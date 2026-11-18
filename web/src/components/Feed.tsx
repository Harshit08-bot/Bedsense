import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { FeedItem } from '../types';

export default function Feed() {
  const { data = [] } = useQuery({ queryKey: ['feed'], queryFn: () => api<FeedItem[]>('/feed') });
  return (
    <div className="space-y-1">
      <h2 className="font-semibold">Messages to wards</h2>
      {data.length === 0 && <p className="text-sm text-slate-500">No questions sent yet.</p>}
      {data.map((q) => (
        <div key={q.id} className="rounded border bg-white p-2 text-xs">
          <b>{q.ward}</b> · bed {q.bed} · {q.kind === 'pre_send' ? 'heads-up before sending' : 'is it ready?'}
          <div className="text-slate-500">{q.reason}</div>
          <div>{q.status === 'open' ? <span className="text-indigo-600">waiting for reply{q.rawReply ? ` (unclear: “${q.rawReply}”)` : ''}</span> : <span className="text-emerald-700">answered: {q.answer}</span>}</div>
        </div>
      ))}
    </div>
  );
}
