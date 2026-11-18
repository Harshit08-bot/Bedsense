import type { BedInfo, Occupant, PatientNeed } from './types';

/** Returns the broken rule, or null when the bed is allowed. Hard rules are never traded off. */
export function violatesHardRule(p: PatientNeed, bed: BedInfo, occupants: Occupant[]): string | null {
  if (bed.type !== p.bedType) return 'wrong bed type';
  if (p.needsIsolation && !bed.isolation) return 'needs isolation room';
  if (p.needsOxygen && !bed.oxygen) return 'needs oxygen point';
  // a medical need (isolation) overrides the payment category
  if (!p.needsIsolation && bed.category !== p.category && !p.acceptsOtherCategory) return 'wrong room category';
  if (bed.sexPolicy === 'male' && p.sex !== 'M') return 'male-only room';
  if (bed.sexPolicy === 'female' && p.sex !== 'F') return 'female-only room';
  if (bed.sexPolicy === 'any' && occupants.some((o) => o.sex !== p.sex)) return 'would mix sexes';
  return null; // 'children' rooms may mix
}
