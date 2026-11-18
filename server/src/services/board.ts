import type { BedInfo, PatientNeed } from '../domain/types';
import { computeTrust, initialState, type BedStateData } from '../domain/ledger';
import { Bed, BedState } from '../models';

export const toBedInfo = (b: any): BedInfo => ({
  id: String(b._id), label: b.label, wardId: String(b.wardId), department: b.department, room: b.room,
  type: b.type, category: b.category, sexPolicy: b.sexPolicy, isolation: !!b.isolation, oxygen: !!b.oxygen,
});

export const toNeed = (r: any): PatientNeed => ({
  id: String(r._id), urgency: r.urgency, sex: r.sex, ageGroup: r.ageGroup, department: r.department ?? '',
  bedType: r.bedType, needsOxygen: !!r.needsOxygen, needsIsolation: !!r.needsIsolation,
  category: r.category ?? 'general', acceptsOtherCategory: !!r.acceptsOtherCategory,
});

export const toStateData = (s: any): BedStateData => ({
  status: s.status, statusSince: s.statusSince, lastConfirmedAt: s.lastConfirmedAt ?? undefined,
  occupant: s.occupant?.sex ? { sex: s.occupant.sex, ageGroup: s.occupant.ageGroup } : undefined,
});

/** Every bed with its current ledger state and trust level. */
export async function loadBoard(now = new Date()) {
  const [beds, states] = await Promise.all([Bed.find().lean(), BedState.find().lean()]);
  const byBed = new Map(states.map((s) => [String(s.bedId), s]));
  return beds.map((b) => {
    const st = byBed.get(String(b._id));
    const state = st ? toStateData(st) : initialState(now);
    return { bed: b, info: toBedInfo(b), state, trust: computeTrust(state, now), truthStatus: (st?.truthStatus ?? undefined) as string | undefined };
  });
}
