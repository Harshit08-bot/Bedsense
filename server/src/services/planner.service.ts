import { randomUUID } from 'crypto';
import { minutesUntilReady, minutesBetween } from '../domain/ledger';
import type { Candidate, Occupant, Proposal } from '../domain/types';
import { greedyAllocate } from '../engine/greedy';
import { solveIlp } from '../engine/ilp';
import { checkProposals, type CheckBed, type CheckPatient } from '../engine/checker';
import { AdmissionRequest, Hold, Suggestion } from '../models';
import { emit } from '../realtime';
import { loadBoard, toNeed } from './board';

const HORIZON_MIN = 180; // also plan for beds expected to be ready within 3 hours
const REJECT_MEMORY_MIN = 120;

export async function runPlan(now = new Date()) {
  const board = await loadBoard(now);
  const [requests, holds, rejected] = await Promise.all([
    AdmissionRequest.find({ status: 'waiting' }).sort({ createdAt: 1 }).lean(),
    Hold.find({ until: { $gt: now } }).lean(),
    Suggestion.find({ status: 'rejected', updatedAt: { $gt: new Date(now.getTime() - REJECT_MEMORY_MIN * 60000) } }).lean(),
  ]);
  const needs = requests.map(toNeed);
  const forbidden = new Set(rejected.map((s) => `${s.requestId}:${s.bedId}`));

  const occupantsByRoom = new Map<string, Occupant[]>();
  for (const r of board) {
    if (r.state.occupant && ['occupied', 'reserved', 'discharging'].includes(r.state.status)) {
      occupantsByRoom.set(r.info.room, [...(occupantsByRoom.get(r.info.room) ?? []), r.state.occupant]);
    }
  }
  const heldBeds = new Set(holds.filter((h) => h.scope === 'bed').map((h) => String(h.bedId)));
  const wardHoldMin = new Map<string, number>();
  for (const h of holds.filter((h) => h.scope === 'ward')) wardHoldMin.set(String(h.wardId), Math.max(0, minutesBetween(now, h.until!)));

  const cands: Candidate[] = [];
  for (const r of board) {
    if (heldBeds.has(r.info.id)) continue;
    const eta = minutesUntilReady(r.state, now);
    if (eta === null || eta > HORIZON_MIN) continue;
    cands.push({
      bed: r.info, status: r.state.status, availableInMin: eta, trust: r.trust,
      holdMin: wardHoldMin.get(r.info.wardId) ?? 0, roomOccupants: occupantsByRoom.get(r.info.room) ?? [],
    });
  }

  let proposals: Proposal[];
  let fallback = false;
  try { proposals = await solveIlp(needs, cands, forbidden); }
  catch (err) { console.error('ILP failed, using greedy fallback:', err); proposals = greedyAllocate(needs, cands, forbidden); fallback = true; }

  // Independent referee: nothing reaches a person without passing it.
  const bedMap = new Map<string, CheckBed>(cands.map((c) => [c.bed.id, {
    id: c.bed.id, room: c.bed.room, type: c.bed.type, category: c.bed.category, sexPolicy: c.bed.sexPolicy,
    isolation: c.bed.isolation, oxygen: c.bed.oxygen, occupantSexes: c.roomOccupants.map((o) => o.sex),
  }]));
  const patMap = new Map<string, CheckPatient>(needs.map((n) => [n.id, {
    id: n.id, sex: n.sex, bedType: n.bedType, category: n.category, acceptsOtherCategory: n.acceptsOtherCategory,
    needsOxygen: n.needsOxygen, needsIsolation: n.needsIsolation,
  }]));
  const violations = checkProposals(proposals.map((p) => ({ requestId: p.requestId, bedId: p.bedId })), patMap, bedMap);
  if (violations.length) {
    console.error('RULE CHECKER REJECTED PROPOSALS', violations);
    const bad = new Set(violations.map((v) => v.requestId));
    proposals = proposals.filter((p) => !bad.has(p.requestId));
  }

  await Suggestion.updateMany({ status: 'proposed' }, { status: 'superseded' });
  const planRunId = randomUUID();
  if (proposals.length) await Suggestion.insertMany(proposals.map((p) => ({ ...p, fallback, planRunId, status: 'proposed' })));
  emit('suggestions');
  return { planRunId, proposals: proposals.length, waiting: needs.length, fallback, violations: violations.length };
}

let timer: NodeJS.Timeout | null = null;
/** Debounced: many events in a burst trigger one plan. */
export function schedulePlan() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; runPlan().catch(console.error); }, 400);
}
