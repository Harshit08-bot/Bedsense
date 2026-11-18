import { HttpError } from '../auth';
import { AdmissionRequest, Bed, BedState, Question, Suggestion } from '../models';
import { emit } from '../realtime';
import { recordEvent } from './ledger.service';
import { schedulePlan } from './planner.service';
import { minutesBetween } from '../domain/ledger';
import type { Reply } from '../domain/parser';

const PRE_SEND_FRESH_MIN = 30;

export async function approveSuggestion(id: string, userId: string) {
  const claimed = await Suggestion.findOneAndUpdate(
    { _id: id, status: 'proposed' }, { status: 'approved', approvedBy: userId, approvedAt: new Date() },
  );
  if (!claimed) throw new HttpError(409, 'This suggestion is no longer current. The plan has been refreshed.');
  const revert = async (msg: string) => { await Suggestion.updateOne({ _id: id }, { status: 'superseded' }); schedulePlan(); throw new HttpError(409, msg); };

  if ((claimed.availableInMin ?? 0) > 0) return revert('That bed is not ready yet.');
  const [req, state, bed] = await Promise.all([
    AdmissionRequest.findById(claimed.requestId), BedState.findOne({ bedId: claimed.bedId }), Bed.findById(claimed.bedId),
  ]);
  if (!req || req.status !== 'waiting') return revert('The request changed.');
  if (!bed || !state || state.status !== 'ready') return revert('The bed changed since the suggestion. Re-planning.');

  await recordEvent(String(bed._id), 'RESERVED', 'system', {
    actorId: userId, occupant: { sex: req.sex as 'M' | 'F', ageGroup: req.ageGroup as 'child' | 'adult' | 'elderly' },
  });
  await AdmissionRequest.updateOne({ _id: req._id }, { status: 'assigned', assignedBedId: bed._id });

  // Heads-up to the ward if nobody confirmed this bed recently, so they can say "not ready" before the patient moves.
  const stale = !state.lastConfirmedAt || minutesBetween(state.lastConfirmedAt, new Date()) > PRE_SEND_FRESH_MIN;
  if (stale) {
    await Question.create({ bedId: bed._id, wardId: bed.wardId, kind: 'pre_send', reason: 'A patient is about to be sent to this bed', suggestionId: claimed._id });
    emit('questions');
  }
  emit('requests', 'feed');
  schedulePlan();
  return { bedLabel: bed.label, preSendCheck: stale };
}

export async function rejectSuggestion(id: string, reason?: string) {
  const s = await Suggestion.findOneAndUpdate({ _id: id, status: 'proposed' }, { status: 'rejected', rejectReason: reason });
  if (!s) throw new HttpError(409, 'This suggestion is no longer current.');
  schedulePlan();
}

const REPLY_TO_STATUS = { ready: 'ready', not_yet: 'dirty', occupied: 'occupied' } as const;

export async function answerQuestion(id: string, reply: Reply, raw: string | undefined, actorId: string) {
  const q = await Question.findById(id);
  if (!q || q.status !== 'open') throw new HttpError(409, 'Question already answered');
  if (reply === 'unknown') { // never assume a bed is free: keep it open, the UI asks again with buttons
    await Question.updateOne({ _id: id }, { rawReply: raw });
    emit('feed');
    return { reask: true };
  }
  await recordEvent(String(q.bedId), 'STATUS_CONFIRMED', 'ward', { actorId, status: REPLY_TO_STATUS[reply] });
  await Question.updateOne({ _id: id }, { status: 'answered', answer: reply, rawReply: raw, answeredAt: new Date() });

  if (q.kind === 'pre_send' && reply !== 'ready' && q.suggestionId) {
    const s = await Suggestion.findByIdAndUpdate(q.suggestionId, { status: 'revoked' });
    if (s) await AdmissionRequest.updateOne({ _id: s.requestId }, { status: 'waiting', $unset: { assignedBedId: 1 } });
    emit('requests');
  }
  emit('questions', 'feed');
  schedulePlan();
  return { reask: false };
}
