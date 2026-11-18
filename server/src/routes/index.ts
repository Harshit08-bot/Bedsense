import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { HttpError, requireAuth, signToken } from '../auth';
import { config } from '../config';
import { ageGroupOf } from '../domain/types';
import { parseIntake, parseReply } from '../domain/parser';
import { AdmissionRequest, Bed, BedState, Hold, Question, Suggestion, User, Ward } from '../models';
import { loadBoard } from '../services/board';
import { recordEvent } from '../services/ledger.service';
import { runPlan, schedulePlan } from '../services/planner.service';
import { answerQuestion, approveSuggestion, rejectSuggestion } from '../services/assignments.service';
import { addBurst, autoNurse, injectDrift } from '../services/simulator';
import { emit } from '../realtime';
import { seed } from '../seed';

export const routes = Router();
const mins = (m: number) => new Date(Date.now() + m * 60000);

// ---------- auth ----------
routes.post('/auth/login', async (req, res) => {
  const { email, password } = z.object({ email: z.string(), password: z.string() }).parse(req.body);
  const u = await User.findOne({ email: email.toLowerCase() });
  if (!u || !(await bcrypt.compare(password, u.passwordHash ?? ''))) throw new HttpError(401, 'Wrong email or password');
  const user = { id: String(u._id), name: u.name ?? '', role: u.role as 'manager' | 'ward' | 'requester', wardId: u.wardId ? String(u.wardId) : undefined };
  res.json({ token: signToken(user), user });
});

// ---------- wards & beds ----------
routes.get('/wards', requireAuth(), async (_req, res) => res.json(await Ward.find().lean()));

routes.get('/beds', requireAuth('manager', 'ward'), async (req, res) => {
  const [board, open, wards] = await Promise.all([loadBoard(), Question.find({ status: 'open' }).lean(), Ward.find().lean()]);
  const openBeds = new Set(open.map((q) => String(q.bedId)));
  const wardName = new Map(wards.map((w) => [String(w._id), w.name]));
  const mine = req.user!.role === 'ward' ? board.filter((r) => r.info.wardId === req.user!.wardId) : board;
  res.json(mine.map((r) => ({
    id: r.info.id, label: r.info.label, wardId: r.info.wardId, ward: wardName.get(r.info.wardId), room: r.info.room,
    type: r.info.type, category: r.info.category, isolation: r.info.isolation, oxygen: r.info.oxygen,
    status: r.state.status, statusSince: r.state.statusSince, trust: r.trust, asking: openBeds.has(r.info.id),
    mismatch: !!r.truthStatus && r.truthStatus !== r.state.status && req.user!.role === 'manager', // demo overlay
  })));
});

const manualEvents = ['DISCHARGE_ORDERED', 'PATIENT_LEFT', 'CLEANED', 'BLOCKED', 'UNBLOCKED'] as const;
routes.post('/beds/:id/events', requireAuth('manager', 'ward'), async (req, res) => {
  const { type } = z.object({ type: z.enum(manualEvents) }).parse(req.body);
  const bed = await Bed.findById(req.params.id);
  if (!bed) throw new HttpError(404, 'No such bed');
  if (req.user!.role === 'ward' && String(bed.wardId) !== req.user!.wardId) throw new HttpError(403, 'Not your ward');
  await recordEvent(String(bed._id), type, req.user!.role === 'ward' ? 'ward' : 'board', { actorId: req.user!.id });
  schedulePlan();
  res.json({ ok: true });
});

routes.post('/beds/:id/hold', requireAuth('manager'), async (req, res) => {
  const { minutes } = z.object({ minutes: z.number().min(5).max(480) }).parse(req.body);
  await Hold.create({ scope: 'bed', bedId: String(req.params.id), until: mins(minutes), createdBy: req.user!.id });
  schedulePlan();
  res.json({ ok: true });
});

// ---------- admission requests ----------
routes.post('/requests/parse', requireAuth('manager', 'requester'), (req, res) => {
  res.json(parseIntake(z.object({ note: z.string().min(3).max(2000) }).parse(req.body).note));
});

const requestBody = z.object({
  rawNote: z.string().optional(),
  age: z.number().int().min(0).max(120),
  sex: z.enum(['M', 'F']),
  bedType: z.enum(['ward', 'icu', 'hdu']),
  department: z.string().optional(),
  urgency: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  needsOxygen: z.boolean(),
  needsIsolation: z.boolean(),
  category: z.enum(['general', 'private']).default('general'),
  acceptsOtherCategory: z.boolean().default(false),
  evidence: z.any().optional(),
});
routes.post('/requests', requireAuth('manager', 'requester'), async (req, res) => {
  const b = requestBody.parse(req.body);
  if (b.bedType === 'ward' && !b.department) throw new HttpError(400, 'Choose a department for a ward bed');
  const doc = await AdmissionRequest.create({ ...b, ageGroup: ageGroupOf(b.age), department: b.department ?? '', createdBy: req.user!.id, status: 'waiting' });
  emit('requests');
  schedulePlan();
  res.status(201).json(doc);
});

routes.get('/requests', requireAuth('manager', 'requester'), async (req, res) => {
  const filter: Record<string, unknown> = { status: { $ne: 'cancelled' } };
  if (req.user!.role === 'requester') filter.createdBy = req.user!.id;
  const docs = await AdmissionRequest.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  const beds = new Map((await Bed.find({ _id: { $in: docs.map((d) => d.assignedBedId).filter(Boolean) } }).lean()).map((b) => [String(b._id), b.label]));
  res.json(docs.map((d) => ({ ...d, assignedBedLabel: d.assignedBedId ? beds.get(String(d.assignedBedId)) : undefined })));
});

routes.post('/requests/:id/cancel', requireAuth('manager', 'requester'), async (req, res) => {
  await AdmissionRequest.updateOne({ _id: String(req.params.id), status: { $in: ['waiting', 'assigned'] } }, { status: 'cancelled' });
  const r = await AdmissionRequest.findById(req.params.id);
  if (r?.assignedBedId) await recordEvent(String(r.assignedBedId), 'RESERVATION_RELEASED', 'system');
  emit('requests'); schedulePlan();
  res.json({ ok: true });
});

routes.post('/requests/:id/arrived', requireAuth('manager'), async (req, res) => {
  const r = await AdmissionRequest.findById(req.params.id);
  if (!r || r.status !== 'assigned' || !r.assignedBedId) throw new HttpError(409, 'No assigned bed');
  await recordEvent(String(r.assignedBedId), 'ADMITTED', 'board', { actorId: req.user!.id, occupant: { sex: r.sex as 'M' | 'F', ageGroup: r.ageGroup as 'child' | 'adult' | 'elderly' } });
  await AdmissionRequest.updateOne({ _id: r._id }, { status: 'admitted' });
  emit('requests');
  res.json({ ok: true });
});

// ---------- plan & suggestions ----------
routes.post('/plan/run', requireAuth('manager'), async (_req, res) => res.json(await runPlan()));

routes.get('/suggestions', requireAuth('manager'), async (_req, res) => {
  const [sugs, waiting] = await Promise.all([Suggestion.find({ status: 'proposed' }).lean(), AdmissionRequest.find({ status: 'waiting' }).sort({ urgency: -1, createdAt: 1 }).lean()]);
  const beds = new Map((await Bed.find({ _id: { $in: sugs.map((s) => s.bedId) } }).lean()).map((b) => [String(b._id), b]));
  const byReq = new Map(sugs.map((s) => [String(s.requestId), s]));
  res.json(waiting.map((r) => {
    const s = byReq.get(String(r._id));
    const b = s ? beds.get(String(s.bedId)) : undefined;
    return {
      request: r,
      suggestion: s && b ? { id: String(s._id), bedLabel: b.label, ward: b.department, cost: s.cost, availableInMin: s.availableInMin, reasons: s.reasons, fallback: s.fallback } : null,
    };
  }));
});
routes.post('/suggestions/:id/approve', requireAuth('manager'), async (req, res) => res.json(await approveSuggestion(String(req.params.id), req.user!.id)));
routes.post('/suggestions/:id/reject', requireAuth('manager'), async (req, res) => {
  await rejectSuggestion(String(req.params.id), z.object({ reason: z.string().optional() }).parse(req.body).reason);
  res.json({ ok: true });
});

// ---------- ward questions, replies and pause ----------
routes.get('/ward/questions', requireAuth('ward'), async (req, res) => {
  const qs = await Question.find({ wardId: req.user!.wardId, status: 'open' }).sort({ askedAt: 1 }).lean();
  const beds = new Map((await Bed.find({ _id: { $in: qs.map((q) => q.bedId) } }).lean()).map((b) => [String(b._id), b.label]));
  res.json(qs.map((q) => ({ id: String(q._id), bedLabel: beds.get(String(q.bedId)), kind: q.kind, reason: q.reason, askedAt: q.askedAt, needsButtons: !!q.rawReply })));
});

routes.post('/questions/:id/answer', requireAuth('ward'), async (req, res) => {
  const body = z.object({ reply: z.enum(['ready', 'not_yet', 'occupied']).optional(), text: z.string().max(200).optional() }).parse(req.body);
  const q = await Question.findById(req.params.id);
  if (!q || String(q.wardId) !== req.user!.wardId) throw new HttpError(404, 'No such question');
  const reply = body.reply ?? parseReply(body.text ?? '');
  res.json(await answerQuestion(String(q._id), reply, body.text, req.user!.id));
});

routes.get('/ward/hold', requireAuth('ward'), async (req, res) => {
  res.json(await Hold.findOne({ scope: 'ward', wardId: req.user!.wardId, until: { $gt: new Date() } }).lean());
});
routes.post('/ward/hold', requireAuth('ward'), async (req, res) => {
  const { minutes } = z.object({ minutes: z.number().min(5).max(120) }).parse(req.body);
  await Hold.deleteMany({ scope: 'ward', wardId: req.user!.wardId });
  await Hold.create({ scope: 'ward', wardId: req.user!.wardId, until: mins(minutes), createdBy: req.user!.id });
  schedulePlan(); emit('beds');
  res.json({ ok: true });
});
routes.delete('/ward/hold', requireAuth('ward'), async (req, res) => {
  await Hold.deleteMany({ scope: 'ward', wardId: req.user!.wardId });
  schedulePlan();
  res.json({ ok: true });
});

routes.get('/feed', requireAuth('manager'), async (_req, res) => {
  const qs = await Question.find().sort({ askedAt: -1 }).limit(30).lean();
  const [beds, wards] = await Promise.all([Bed.find({ _id: { $in: qs.map((q) => q.bedId) } }).lean(), Ward.find().lean()]);
  const bl = new Map(beds.map((b) => [String(b._id), b.label]));
  const wn = new Map(wards.map((w) => [String(w._id), w.name]));
  res.json(qs.map((q) => ({ id: String(q._id), bed: bl.get(String(q.bedId)), ward: wn.get(String(q.wardId)), kind: q.kind, reason: q.reason, status: q.status, answer: q.answer, rawReply: q.rawReply, askedAt: q.askedAt, answeredAt: q.answeredAt })));
});

// ---------- demo tools ----------
if (config.demoTools) {
  const demo = Router();
  demo.post('/drift', async (req, res) => {
    const b = z.object({ hidden: z.number().min(0).max(30).default(5), phantom: z.number().min(0).max(30).default(3) }).parse(req.body);
    res.json(await injectDrift(b.hidden, b.phantom));
  });
  demo.post('/burst', async (req, res) => { await addBurst(z.object({ count: z.number().min(1).max(60).default(5) }).parse(req.body).count); res.json({ ok: true }); });
  demo.post('/auto-nurse', async (_req, res) => res.json(await autoNurse()));
  demo.post('/reset', async (_req, res) => { await seed(); emit('beds', 'suggestions', 'questions', 'requests', 'feed'); res.json({ ok: true }); });
  routes.use('/demo', requireAuth('manager'), demo);
}
