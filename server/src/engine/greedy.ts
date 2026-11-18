import type { Candidate, Occupant, PatientNeed, Proposal } from '../domain/types';
import { scoreMatch, totalCost } from '../domain/scoring';

/** Fallback allocator: most urgent first, cheapest allowed bed. Also usable as a baseline. */
export function greedyAllocate(needs: PatientNeed[], cands: Candidate[], forbidden = new Set<string>()): Proposal[] {
  const used = new Set<string>();
  const added = new Map<string, Occupant[]>(); // patients already placed in a room this round
  const out: Proposal[] = [];
  const order = [...needs].sort((a, b) => b.urgency - a.urgency);
  for (const p of order) {
    let best: { c: Candidate; cost: number; avail: number; reasons: string[] } | null = null;
    for (const c of cands) {
      if (used.has(c.bed.id) || forbidden.has(`${p.id}:${c.bed.id}`)) continue;
      const occ = [...c.roomOccupants, ...(added.get(c.bed.room) ?? [])];
      const s = scoreMatch(p, { ...c, roomOccupants: occ });
      if (!s) continue;
      const cost = totalCost(s);
      if (!best || cost < best.cost) best = { c, cost, avail: s.availableInMin, reasons: s.reasons };
    }
    if (!best) continue;
    used.add(best.c.bed.id);
    added.set(best.c.bed.room, [...(added.get(best.c.bed.room) ?? []), { sex: p.sex, ageGroup: p.ageGroup }]);
    out.push({ requestId: p.id, bedId: best.c.bed.id, cost: best.cost, availableInMin: best.avail, reasons: best.reasons });
  }
  return out;
}
