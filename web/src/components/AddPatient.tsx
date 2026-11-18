import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { Intake } from '../types';

const DEPTS = ['Medicine', 'Surgery', 'Paediatrics', 'Obstetrics and Gynaecology', 'Orthopaedics', 'ENT', 'Eye', 'Psychiatry', 'Dermatology'];

interface Form { age: string; sex: 'M' | 'F' | ''; bedType: 'ward' | 'icu' | 'hdu'; department: string; urgency: 1 | 2 | 3; oxygen: boolean; isolation: boolean; private: boolean }
const empty: Form = { age: '', sex: '', bedType: 'ward', department: 'Medicine', urgency: 1, oxygen: false, isolation: false, private: false };

export default function AddPatient({ onSaved }: { onSaved?: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [form, setForm] = useState<Form>(empty);
  const [intake, setIntake] = useState<Intake | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const parse = useMutation({
    mutationFn: () => api<Intake>('/requests/parse', 'POST', { note }),
    onSuccess: (r) => {
      setIntake(r);
      setForm((f) => ({
        ...f,
        age: r.age ? String(r.age.value) : f.age, sex: r.sex?.value ?? f.sex, bedType: r.bedType?.value ?? f.bedType,
        department: r.department?.value ?? f.department, urgency: r.urgency?.value ?? 1,
        oxygen: r.oxygen?.value ?? false, isolation: r.isolation?.value ?? false,
      }));
    },
  });
  const save = useMutation({
    mutationFn: () => api('/requests', 'POST', {
      rawNote: note, age: Number(form.age), sex: form.sex, bedType: form.bedType, urgency: form.urgency,
      department: form.bedType === 'ward' ? form.department : undefined, needsOxygen: form.oxygen,
      needsIsolation: form.isolation, category: form.private ? 'private' : 'general', evidence: intake,
    }),
    onSuccess: () => { setNote(''); setForm(empty); setIntake(null); qc.invalidateQueries(); onSaved?.(); },
  });
  const ready = Number(form.age) > 0 && form.sex !== '';

  return (
    <div className="space-y-2 rounded-lg border bg-white p-3">
      <h2 className="font-semibold">Add patient from a doctor&apos;s note</h2>
      <textarea className="w-full rounded border p-2 text-sm" rows={3} value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="62 yr old female, COPD, on 4L O2. Admit under Medicine ward. No isolation" />
      <button className="rounded border px-3 py-1 text-sm" disabled={note.length < 3} onClick={() => parse.mutate()}>Read note</button>

      {intake && (
        <div className="rounded bg-slate-50 p-2 text-xs">
          {intake.questions.map((q) => <p key={q} className="font-medium text-red-700">? {q}</p>)}
          {intake.assumed.length > 0 && <p className="text-amber-700">Assumed, please confirm: {intake.assumed.join('; ')}</p>}
          {[intake.age, intake.sex, intake.department, intake.oxygen, intake.isolation].filter(Boolean).map((f) => (
            <p key={f!.evidence} className="text-slate-500">from note: “{f!.evidence}”</p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 text-sm">
        <input className="rounded border p-1" type="number" placeholder="Age" value={form.age} onChange={(e) => set('age', e.target.value)} />
        <select className="rounded border p-1" value={form.sex} onChange={(e) => set('sex', e.target.value as Form['sex'])}>
          <option value="">Sex…</option><option value="M">Male</option><option value="F">Female</option>
        </select>
        <select className="rounded border p-1" value={form.bedType} onChange={(e) => set('bedType', e.target.value as Form['bedType'])}>
          <option value="ward">Ward</option><option value="hdu">HDU</option><option value="icu">ICU</option>
        </select>
        <select className="rounded border p-1" disabled={form.bedType !== 'ward'} value={form.department} onChange={(e) => set('department', e.target.value)}>
          {DEPTS.map((d) => <option key={d}>{d}</option>)}
        </select>
        <select className="rounded border p-1" value={form.urgency} onChange={(e) => set('urgency', Number(e.target.value) as Form['urgency'])}>
          <option value={1}>Routine</option><option value={2}>Urgent</option><option value={3}>Critical</option>
        </select>
        <label><input type="checkbox" checked={form.oxygen} onChange={(e) => set('oxygen', e.target.checked)} /> Oxygen</label>
        <label><input type="checkbox" checked={form.isolation} onChange={(e) => set('isolation', e.target.checked)} /> Isolation</label>
        <label><input type="checkbox" checked={form.private} onChange={(e) => set('private', e.target.checked)} /> Private room</label>
      </div>
      {save.error && <p className="text-sm text-red-600">{(save.error as Error).message}</p>}
      <button className="w-full rounded bg-slate-900 p-2 text-white disabled:opacity-40" disabled={!ready} onClick={() => save.mutate()}>Add to queue</button>
    </div>
  );
}
