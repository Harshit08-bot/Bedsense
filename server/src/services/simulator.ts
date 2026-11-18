import { ageGroupOf, type Sex } from '../domain/types';
import { AdmissionRequest, BedState } from '../models';
import { emit } from '../realtime';
import { loadBoard } from './board';
import { recordEvent } from './ledger.service';
import { answerQuestion } from './assignments.service';
import { Question } from '../models';
import { schedulePlan } from './planner.service';

const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const shuffle = <T,>(a: T[]) => [...a].sort(() => Math.random() - 0.5);
const minsAgo = (m: number) => new Date(Date.now() - m * 60000);

/**
 * Make the board wrong, the way a real hospital's board goes wrong.
 *  hidden : really free, but the board still says dirty/discharging for hours ("hidden bed")
 *  phantom: board says ready, but the bed is really not ("phantom bed")
 */
export async function injectDrift(hidden: number, phantom: number) {
  const board = shuffle(await loadBoard());
  let h = 0, p = 0;
  for (const r of board) {
    const id = r.info.id;
    if (h < hidden && ['occupied', 'dirty', 'discharging'].includes(r.state.status)) {
      await recordEvent(id, 'PATIENT_LEFT', 'sim', { at: minsAgo(150 + Math.random() * 200) }); // board: dirty for hours
      await BedState.updateOne({ bedId: id }, { truthStatus: 'ready' });
      h++;
    } else if (p < phantom && r.state.status === 'ready') {
      await recordEvent(id, 'CLEANED', 'sim', { at: minsAgo(20 + Math.random() * 60) }); // board: ready, unconfirmed
      await BedState.updateOne({ bedId: id }, { truthStatus: pick(['occupied', 'dirty']) });
      p++;
    }
  }
  schedulePlan();
  return { hidden: h, phantom: p };
}

/** A burst of waiting patients, e.g. a bus accident. */
export async function addBurst(count: number) {
  const depts = ['Medicine', 'Surgery', 'Paediatrics'];
  for (let i = 0; i < count; i++) {
    const critical = Math.random() < 0.25;
    const dept = pick(depts);
    const age = dept === 'Paediatrics' ? 2 + Math.floor(Math.random() * 12) : 20 + Math.floor(Math.random() * 65);
    await AdmissionRequest.create({
      rawNote: '(simulated)', age, ageGroup: ageGroupOf(age), sex: pick<Sex>(['M', 'F']),
      department: critical ? '' : dept, bedType: critical ? pick(['icu', 'hdu']) : 'ward',
      urgency: critical ? 3 : pick([1, 2]), needsOxygen: Math.random() < 0.3, needsIsolation: Math.random() < 0.08,
      category: 'general', acceptsOtherCategory: false, status: 'waiting',
    });
  }
  emit('requests');
  schedulePlan();
}

/** A fake nurse who answers every open question truthfully, so the demo runs without a phone. */
export async function autoNurse() {
  const open = await Question.find({ status: 'open' }).lean();
  let answered = 0;
  for (const q of open) {
    const st = await BedState.findOne({ bedId: q.bedId }).lean();
    const truth = st?.truthStatus ?? st?.status;
    const reply = truth === 'ready' ? 'ready' : truth === 'occupied' || truth === 'discharging' ? 'occupied' : 'not_yet';
    await answerQuestion(String(q._id), reply, undefined, String(q.wardId));
    answered++;
  }
  return { answered };
}
