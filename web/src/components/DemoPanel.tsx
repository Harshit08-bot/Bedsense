import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

export default function DemoPanel({ showTruth, setShowTruth }: { showTruth: boolean; setShowTruth: (v: boolean) => void }) {
  const qc = useQueryClient();
  const run = (path: string, body?: unknown) => ({ mutationFn: () => api(`/demo/${path}`, 'POST', body ?? {}), onSuccess: () => qc.invalidateQueries() });
  const drift = useMutation(run('drift', { hidden: 5, phantom: 3 }));
  const burst = useMutation(run('burst', { count: 5 }));
  const crunch = useMutation(run('burst', { count: 40 }));
  const nurse = useMutation(run('auto-nurse'));
  const reset = useMutation(run('reset'));
  const btn = 'rounded border bg-white px-2 py-1 text-xs hover:bg-slate-100';
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-indigo-300 bg-indigo-50 p-2">
      <span className="text-xs font-semibold text-indigo-700">DEMO</span>
      <label className="text-xs"><input type="checkbox" checked={showTruth} onChange={(e) => setShowTruth(e.target.checked)} /> Show where the board is wrong</label>
      <button className={btn} onClick={() => drift.mutate()}>Make the board wrong (5 hidden, 3 phantom)</button>
      <button className={btn} onClick={() => burst.mutate()}>Add 5 patients</button>
      <button className={btn} onClick={() => crunch.mutate()}>Crunch: 40 patients</button>
      <button className={btn} onClick={() => nurse.mutate()}>Auto-answer as nurse</button>
      <button className={btn} onClick={() => confirm('Reset all demo data?') && reset.mutate()}>Reset</button>
    </div>
  );
}
