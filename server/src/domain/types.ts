export type BedType = 'ward' | 'icu' | 'hdu';
export type Category = 'general' | 'private';
export type Sex = 'M' | 'F';
export type AgeGroup = 'child' | 'adult' | 'elderly';
export type SexPolicy = 'male' | 'female' | 'any' | 'children';
export type BedStatus = 'ready' | 'reserved' | 'occupied' | 'discharging' | 'dirty' | 'blocked';
export type Trust = 'confirmed' | 'inferred' | 'stale';
export type Urgency = 1 | 2 | 3;

export const ageGroupOf = (age: number): AgeGroup => (age < 18 ? 'child' : age >= 65 ? 'elderly' : 'adult');

export interface BedInfo {
  id: string;
  label: string;
  wardId: string;
  department: string;
  room: string;
  type: BedType;
  category: Category;
  sexPolicy: SexPolicy;
  isolation: boolean;
  oxygen: boolean;
}

export interface PatientNeed {
  id: string;
  urgency: Urgency;
  sex: Sex;
  ageGroup: AgeGroup;
  department: string;
  bedType: BedType;
  needsOxygen: boolean;
  needsIsolation: boolean;
  category: Category;
  acceptsOtherCategory: boolean;
}

export interface Occupant {
  sex: Sex;
  ageGroup: AgeGroup;
}

/** A bed that is ready now, or expected to be ready soon, as seen by the planner. */
export interface Candidate {
  bed: BedInfo;
  status: BedStatus;
  availableInMin: number;
  trust: Trust;
  holdMin: number; // minutes until a ward pause ends (0 = no pause)
  roomOccupants: Occupant[];
}

export interface Proposal {
  requestId: string;
  bedId: string;
  cost: number;
  availableInMin: number;
  reasons: string[];
}
