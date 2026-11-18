import { applyEvent, initialState, replay, type EventSource, type EventType, type LedgerEvent } from '../domain/ledger';
import type { BedStatus, Occupant } from '../domain/types';
import { BedEvent, BedState } from '../models';
import { emit } from '../realtime';
import { toStateData } from './board';

interface Opts { actorId?: string; at?: Date; status?: BedStatus; occupant?: Occupant }

/** Append the event, then update the read model. If they ever disagree, rebuildState() fixes it. */
export async function recordEvent(bedId: string, type: EventType, source: EventSource, opts: Opts = {}) {
  const at = opts.at ?? new Date();
  const payload = { status: opts.status, occupant: opts.occupant };
  await BedEvent.create({ bedId, type, at, source, actorId: opts.actorId, payload });

  const cur = await BedState.findOne({ bedId }).lean();
  const next = applyEvent(cur ? toStateData(cur) : initialState(at), { type, at, source, payload });

  const set: Record<string, unknown> = { status: next.status, statusSince: next.statusSince };
  const unset: Record<string, 1> = {};
  if (next.lastConfirmedAt) set.lastConfirmedAt = next.lastConfirmedAt; else unset.lastConfirmedAt = 1;
  if (next.occupant) set.occupant = next.occupant; else unset.occupant = 1;
  // demo only: real staff actions and system actions are, by definition, the truth
  if (cur?.truthStatus && (source === 'ward' || source === 'system')) set.truthStatus = next.status;

  await BedState.updateOne({ bedId }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { upsert: true });
  emit('beds');
  return next;
}

export async function rebuildState(bedId: string) {
  const events = (await BedEvent.find({ bedId }).sort({ at: 1 }).lean()) as unknown as LedgerEvent[];
  const state = replay(events, events[0]?.at ?? new Date());
  await BedState.updateOne({ bedId }, { $set: { status: state.status, statusSince: state.statusSince, lastConfirmedAt: state.lastConfirmedAt, occupant: state.occupant } }, { upsert: true });
  return state;
}
