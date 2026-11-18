import type { Candidate, PatientNeed } from './types';
import { violatesHardRule } from './rules';

/** All weights are tunable assumptions - review them with doctors and nurses. */
export const W = {
  unassigned: 10000, // per urgency level
  waitPerMin: 2, // per minute, per urgency level
  doubted: 250,
  unconfirmed: 30,
  otherDept: 300,
  otherCategory: 200,
  isolationWaste: 150,
  oxygenWaste: 40,
  ageMix: 60, // once per room
};

export interface Scored {
  base: number; // everything except the age-mix cost
  ageMix: boolean;
  availableInMin: number;
  reasons: string[];
}
export const totalCost = (s: Scored) => s.base + (s.ageMix ? W.ageMix : 0);

export function scoreMatch(p: PatientNeed, c: Candidate): Scored | null {
  if (violatesHardRule(p, c.bed, c.roomOccupants)) return null;
  const reasons: string[] = [];
  // a ward pause delays its free beds, except for critical patients
  const avail = p.urgency === 3 ? c.availableInMin : Math.max(c.availableInMin, c.holdMin);
  let base = W.waitPerMin * p.urgency * avail;
  reasons.push(avail === 0 ? 'ready now' : `free in about ${Math.ceil(avail)} min`);
  if (avail > c.availableInMin) reasons.push('ward asked for a short pause');

  if (c.trust === 'confirmed') reasons.push('status confirmed by staff');
  else if (c.trust === 'inferred') { base += W.unconfirmed; reasons.push('status not confirmed recently'); }
  else { base += W.doubted; reasons.push('status doubted - ward will be asked to confirm'); }

  if (c.bed.type === 'ward') {
    if (c.bed.department !== p.department) { base += W.otherDept; reasons.push(`other department (${c.bed.department})`); }
    else reasons.push(`${c.bed.department} ward, own department`);
  } else reasons.push(`${c.bed.type.toUpperCase()} bed`);

  if (c.bed.category !== p.category && !p.needsIsolation) { base += W.otherCategory; reasons.push('different room category (family agreed)'); }
  if (c.bed.isolation && !p.needsIsolation) { base += W.isolationWaste; reasons.push('uses an isolation room that is not needed'); }
  if (c.bed.oxygen && !p.needsOxygen && c.bed.type === 'ward') { base += W.oxygenWaste; reasons.push('uses an oxygen bed that is not needed'); }
  const ageMix = c.roomOccupants.some((o) => o.ageGroup !== p.ageGroup);
  if (ageMix) reasons.push('room has a different age group');
  return { base, ageMix, availableInMin: avail, reasons };
}
