export type Role = "manager" | "ward" | "requester";
export interface User {
  id: string;
  name: string;
  role: Role;
  wardId?: string;
}
export type BedStatus =
  | "ready"
  | "reserved"
  | "occupied"
  | "discharging"
  | "dirty"
  | "blocked";

export interface Bed {
  id: string;
  label: string;
  wardId: string;
  ward?: string;
  room: string;
  type: "ward" | "icu" | "hdu";
  category: string;
  isolation: boolean;
  oxygen: boolean;
  status: BedStatus;
  statusSince: string;
  trust: "confirmed" | "inferred" | "stale";
  asking: boolean;
  mismatch: boolean;
}
export interface RequestDoc {
  _id: string;
  age: number;
  sex: "M" | "F";
  department?: string;
  bedType: string;
  urgency: 1 | 2 | 3;
  needsOxygen: boolean;
  needsIsolation: boolean;
  status: string;
  assignedBedLabel?: string;
  createdAt: string;
}
export interface QueueItem {
  request: RequestDoc;
  suggestion: null | {
    id: string;
    bedLabel: string;
    ward: string;
    cost: number;
    availableInMin: number;
    reasons: string[];
    fallback: boolean;
  };
}
export interface WardQuestion {
  id: string;
  bedLabel: string;
  kind: "is_ready" | "pre_send";
  reason: string;
  needsButtons: boolean;
}
export interface FeedItem {
  id: string;
  bed: string;
  ward: string;
  kind: string;
  reason: string;
  status: string;
  answer?: string;
  rawReply?: string;
  askedAt: string;
}

export interface Field<T> {
  value: T;
  evidence: string;
}
export interface Intake {
  age?: Field<number>;
  sex?: Field<"M" | "F">;
  bedType?: Field<"ward" | "icu" | "hdu">;
  department?: Field<string>;
  oxygen?: Field<boolean>;
  isolation?: Field<boolean>;
  urgency?: Field<1 | 2 | 3>;
  missing: string[];
  questions: string[];
  assumed: string[];
}
