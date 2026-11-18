import type { BedStatus, Occupant, Trust } from './types';

export type EventType =
  | 'ADMITTED' | 'RESERVED' | 'RESERVATION_RELEASED' | 'DISCHARGE_ORDERED'
  | 'PATIENT_LEFT' | 'CLEANED' | 'BLOCKED' | 'UNBLOCKED' | 'STATUS_CONFIRMED';
export type EventSource = 'board' | 'ward' | 'system' | 'sim';

export interface LedgerEvent {
  type: EventType;
  at: Date;
  source: EventSource;
  payload?: { status?: BedStatus; occupant?: Occupant };
}

export interface BedStateData {
  status: BedStatus;
  statusSince: Date;
  lastConfirmedAt?: Date;
  occupant?: Occupant;
}

export const initialState = (at: Date): BedStateData => ({ status: 'ready', statusSince: at });

function step(s: BedStateData, e: LedgerEvent): BedStateData {
  const to = (status: BedStatus, occupant?: Occupant): BedStateData => ({ status, statusSince: e.at, occupant });
  switch (e.type) {
    case 'ADMITTED': return to('occupied', e.payload?.occupant ?? s.occupant);
    case 'RESERVED': return to('reserved', e.payload?.occupant);
    case 'RESERVATION_RELEASED': return to('ready');
    case 'DISCHARGE_ORDERED': return to('discharging', s.occupant);
    case 'PATIENT_LEFT': return to('dirty');
    case 'CLEANED': return to('ready');
    case 'BLOCKED': return to('blocked');
    case 'UNBLOCKED': return to('dirty');
    case 'STATUS_CONFIRMED': {
      const status = e.payload!.status!;
      if (status === s.status) return s;
      return to(status, status === 'occupied' ? s.occupant : undefined);
    }
  }
}

/** Pure event -> state. A ward-sourced event also counts as a staff confirmation. */
export function applyEvent(s: BedStateData, e: LedgerEvent): BedStateData {
  const next = step(s, e);
  const lastConfirmedAt = e.source === 'ward' ? e.at : next === s ? s.lastConfirmedAt : undefined;
  return { ...next, lastConfirmedAt };
}

export const replay = (events: LedgerEvent[], start: Date): BedStateData =>
  events.reduce(applyEvent, initialState(start));

// ---- trust ----
export const STALE_AFTER_MIN: Record<BedStatus, number> = {
  ready: 480, reserved: 90, discharging: 360, dirty: 120, occupied: Infinity, blocked: Infinity,
};
export const CONFIRM_FRESH_MIN = 60;
export const minutesBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60000;

export function computeTrust(s: BedStateData, now: Date): Trust {
  if (s.lastConfirmedAt && minutesBetween(s.lastConfirmedAt, now) <= CONFIRM_FRESH_MIN) return 'confirmed';
  if (minutesBetween(s.statusSince, now) > STALE_AFTER_MIN[s.status]) return 'stale';
  return 'inferred';
}

/** Rough ETA (minutes) until a bed can take a patient. null = not expected soon. */
export function minutesUntilReady(s: BedStateData, now: Date): number | null {
  const since = minutesBetween(s.statusSince, now);
  switch (s.status) {
    case 'ready': return 0;
    case 'dirty': return Math.max(10, 45 - since);
    case 'discharging': return Math.max(30, 165 - since); // leaves (~120) + cleaning (~45), both assumed
    default: return null;
  }
}
