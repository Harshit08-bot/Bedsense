import { violatesHardRule } from '../domain/rules';
import { AdmissionRequest, Question } from '../models';
import { emit } from '../realtime';
import { loadBoard, toNeed } from './board';

const MAX_PER_WARD_PER_HOUR = 3;
const LOW_TRUST_SHARE = 0.1;

/**
 * Asks wards about doubted beds - but only where the answer matters:
 * a waiting patient could use the bed, or the ward has almost no trustworthy free beds.
 */
export async function runTruthAgent(now = new Date()) {
  const board = await loadBoard(now);
  const needs = (await AdmissionRequest.find({ status: 'waiting' }).lean()).map(toNeed);
  const hourAgo = new Date(now.getTime() - 3600_000);
  const [recent, open] = await Promise.all([
    Question.find({ askedAt: { $gte: hourAgo } }).lean(),
    Question.find({ status: 'open' }).lean(),
  ]);
  const sentByWard = new Map<string, number>();
  for (const q of recent) sentByWard.set(String(q.wardId), (sentByWard.get(String(q.wardId)) ?? 0) + 1);
  const openBeds = new Set(open.map((q) => String(q.bedId)));

  const wards = new Map<string, typeof board>();
  for (const r of board) wards.set(r.info.wardId, [...(wards.get(r.info.wardId) ?? []), r]);

  let asked = 0;
  for (const [wardId, beds] of wards) {
    const trustedFree = beds.filter((b) => b.state.status === 'ready' && b.trust !== 'stale').length;
    const lowTrust = trustedFree / beds.length < LOW_TRUST_SHARE;
    const doubted = beds
      .filter((b) => b.trust === 'stale' && b.state.status !== 'blocked' && !openBeds.has(b.info.id))
      .sort((a, b) => a.state.statusSince.getTime() - b.state.statusSince.getTime());

    let budget = MAX_PER_WARD_PER_HOUR - (sentByWard.get(wardId) ?? 0);
    for (const b of doubted) {
      if (budget <= 0) break;
      const wanted = needs.some((p) => !violatesHardRule(p, b.info, []));
      if (!wanted && !lowTrust) continue;
      await Question.create({
        bedId: b.info.id, wardId, kind: 'is_ready',
        reason: wanted ? 'A waiting patient could use this bed' : 'Few trusted free beds in this ward',
      });
      budget--; asked++;
    }
  }
  if (asked) emit('questions', 'feed');
  return { asked };
}
