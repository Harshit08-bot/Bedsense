import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { useLive } from '../live';
import AddPatient from '../components/AddPatient';
import type { RequestDoc } from '../types';

const LABEL: Record<string, string> = { waiting: 'Waiting for a bed', assigned: 'Bed assigned', admitted: 'Admitted' };

export default function Requester() {
  useLive();
  const { user, logout } = useAuth();
  const { data = [] } = useQuery({ queryKey: ['requests'], queryFn: () => api<RequestDoc[]>('/requests') });
  return (
    <div className="mx-auto max-w-lg space-y-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold">Admission requests · {user?.name}</h1>
        <button className="text-sm underline" onClick={logout}>Sign out</button>
      </header>
      <AddPatient />
      <h2 className="font-semibold">My requests</h2>
      {data.map((r) => (
        <div key={r._id} className="rounded border bg-white p-2 text-sm">
          {r.age}{r.sex} · {r.bedType === 'ward' ? r.department : r.bedType.toUpperCase()} — <b>{LABEL[r.status] ?? r.status}</b>
          {r.assignedBedLabel && <> · bed {r.assignedBedLabel}</>}
        </div>
      ))}
    </div>
  );
}
