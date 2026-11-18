import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { QueueItem, RequestDoc } from '../types';

const URG = { 3: 'Critical', 2: 'Urgent', 1: 'Routine' } as const;
const URG_STYLE = { 3: 'bg-red-600', 2: 'bg-amber-500', 1: 'bg-slate-500' } as const;
const describe = (r: RequestDoc) => `${r.age}${r.sex} - ${r.bedType === 'ward' ? r.department : r.bedType.toUpperCase()}${r.needsOxygen ? ' - O₂' : ''}${r.needsIsolation ? ' - isolation' : ''}`;

export default function Queue() {
  const qc = useQueryClient();
  const { data: items = [] } = useQuery({ queryKey: ['suggestions'], queryFn: () => api<QueueItem[]>('/suggestions') });
  const done = () => { qc.invalidateQueries({ queryKey: ['suggestions'] }); qc.invalidateQueries({ queryKey: ['beds'] }); qc.invalidateQueries({ queryKey: ['requests'] }); };
  const approve = useMutation({ mutationFn: (id: string) => api(`/suggestions/${id}/approve`, 'POST'), onSuccess: done, onError: (e) => { alert((e as Error).message); done(); } });
  const reject = useMutation({ mutationFn: (id: string) => api(`/suggestions/${id}/reject`, 'POST', {}), onSuccess: done });
  const assigned = useQuery({ queryKey: ['requests'], queryFn: () => api<RequestDoc[]>('/requests') });
  const arrived = useMutation({ mutationFn: (id: string) => api(`/requests/${id}/arrived`, 'POST'), onSuccess: done });

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Waiting patients ({items.length})</h2>
      {items.length === 0 && <p className="text-sm text-slate-500">Nobody is waiting.</p>}
      {items.map(({ request: r, suggestion: s }) => (
        <div key={r._id} className="rounded-lg border bg-white p-3 shadow-sm">
          <div className="flex items-center gap-2">
            <span className={`rounded px-2 py-0.5 text-xs text-white ${URG_STYLE[r.urgency]}`}>{URG[r.urgency]}</span>
            <span className="font-medium">{describe(r)}</span>
          </div>
          {s ? (
            <div className="mt-2 text-sm">
              <div>Suggested: <b>{s.bedLabel}</b> <span className="text-slate-500">({s.ward}{s.fallback ? ', fallback plan' : ''})</span></div>
              <ul className="mt-1 list-disc pl-5 text-slate-600">{s.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
              <div className="mt-2 flex gap-2">
                {s.availableInMin === 0
                  ? <button className="rounded bg-emerald-600 px-3 py-1 text-white" onClick={() => approve.mutate(s.id)}>Approve</button>
                  : <span className="rounded bg-slate-100 px-2 py-1 text-xs">Planned - bed free in ~{Math.ceil(s.availableInMin)} min</span>}
                <button className="rounded border px-3 py-1" onClick={() => reject.mutate(s.id)}>Reject</button>
              </div>
            </div>
          ) : <p className="mt-2 text-sm text-red-600">No suitable bed expected soon - consider referral.</p>}
        </div>
      ))}
      <h3 className="pt-2 font-semibold">Assigned - waiting to arrive</h3>
      {(assigned.data ?? []).filter((r) => r.status === 'assigned').map((r) => (
        <div key={r._id} className="flex items-center justify-between rounded border bg-white p-2 text-sm">
          <span>{describe(r)} → <b>{r.assignedBedLabel}</b></span>
          <button className="rounded bg-slate-900 px-2 py-1 text-white" onClick={() => arrived.mutate(r._id)}>Arrived</button>
        </div>
      ))}
    </div>
  );
}
