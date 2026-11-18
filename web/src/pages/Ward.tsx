import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { useLive } from '../live';
import { BedTile } from '../components/BedBoard';
import type { Bed, WardQuestion } from '../types';

const ACTION: Record<string, [string, string][]> = {
  occupied: [['Patient left', 'PATIENT_LEFT']], discharging: [['Patient left', 'PATIENT_LEFT']],
  dirty: [['Cleaned ✓', 'CLEANED']], ready: [['Block', 'BLOCKED']], blocked: [['Unblock', 'UNBLOCKED']], reserved: [],
};

function Question({ q }: { q: WardQuestion }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const answer = useMutation({
    mutationFn: (body: { reply?: string; text?: string }) => api(`/questions/${q.id}/answer`, 'POST', body),
    onSuccess: () => { setText(''); qc.invalidateQueries({ queryKey: ['questions'] }); qc.invalidateQueries({ queryKey: ['beds'] }); },
  });
  const btn = 'flex-1 rounded-lg py-3 text-base font-semibold text-white';
  return (
    <div className="rounded-xl border-2 border-indigo-300 bg-white p-3">
      <div className="text-lg font-bold">Bed {q.bedLabel}: is it ready?</div>
      <div className="text-xs text-slate-500">{q.kind === 'pre_send' ? 'A patient is about to be sent here.' : q.reason}</div>
      {q.needsButtons && <div className="mt-1 text-xs text-amber-700">We couldn&apos;t understand the last reply. Please tap a button.</div>}
      <div className="mt-2 flex gap-2">
        <button className={`${btn} bg-emerald-600`} onClick={() => answer.mutate({ reply: 'ready' })}>Ready</button>
        <button className={`${btn} bg-amber-500`} onClick={() => answer.mutate({ reply: 'not_yet' })}>Not yet</button>
        <button className={`${btn} bg-rose-600`} onClick={() => answer.mutate({ reply: 'occupied' })}>Occupied</button>
      </div>
      <div className="mt-2 flex gap-2">
        <input className="flex-1 rounded border p-2 text-sm" placeholder='or type: "haan khali hai"' value={text} onChange={(e) => setText(e.target.value)} />
        <button className="rounded border px-3 text-sm" disabled={!text} onClick={() => answer.mutate({ text })}>Send</button>
      </div>
    </div>
  );
}

export default function Ward() {
  useLive();
  const { user, logout } = useAuth();
  const qc = useQueryClient();
  const { data: beds = [] } = useQuery({ queryKey: ['beds'], queryFn: () => api<Bed[]>('/beds') });
  const { data: questions = [] } = useQuery({ queryKey: ['questions'], queryFn: () => api<WardQuestion[]>('/ward/questions') });
  const { data: hold } = useQuery({ queryKey: ['hold'], queryFn: () => api<{ until: string } | null>('/ward/hold') });
  const event = useMutation({
    mutationFn: (v: { id: string; type: string }) => api(`/beds/${v.id}/events`, 'POST', { type: v.type }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['beds'] }),
  });
  const setHold = useMutation({
    mutationFn: (minutes: number | null) => (minutes ? api('/ward/hold', 'POST', { minutes }) : api('/ward/hold', 'DELETE')),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hold'] }),
  });

  return (
    <div className="mx-auto max-w-md space-y-4 p-3">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold">{user?.name}</h1>
        <button className="text-sm underline" onClick={logout}>Sign out</button>
      </header>

      <section className="space-y-2">
        <h2 className="font-semibold">Questions ({questions.length})</h2>
        {questions.length === 0 && <p className="text-sm text-slate-500">Nothing to answer right now.</p>}
        {questions.map((q) => <Question key={q.id} q={q} />)}
      </section>

      <section className="rounded-xl border bg-white p-3">
        <h2 className="font-semibold">Busy? Pause new admissions</h2>
        {hold ? (
          <div className="mt-1 text-sm">Paused until {new Date(hold.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (critical patients still allowed)
            <button className="ml-2 underline" onClick={() => setHold.mutate(null)}>Clear</button></div>
        ) : (
          <div className="mt-2 flex gap-2">
            {[30, 60].map((m) => <button key={m} className="rounded border px-3 py-2 text-sm" onClick={() => setHold.mutate(m)}>{m} min</button>)}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Beds</h2>
        <div className="space-y-2">
          {beds.map((b) => (
            <div key={b.id} className="flex items-center justify-between rounded-lg border bg-white p-2">
              <BedTile bed={b} />
              <div className="flex gap-2">
                {(ACTION[b.status] ?? []).map(([label, type]) => (
                  <button key={type} className="rounded border px-3 py-2 text-sm" onClick={() => event.mutate({ id: b.id, type })}>{label}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
