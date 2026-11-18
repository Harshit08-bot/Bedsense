import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAuth } from "../auth";
import { useLive } from "../live";
import BedBoard from "../components/BedBoard";
import Queue from "../components/Queue";
import AddPatient from "../components/AddPatient";
import Feed from "../components/Feed";
import DemoPanel from "../components/DemoPanel";
import type { Bed } from "../types";

export default function Manager() {
  useLive();
  const { user, logout } = useAuth();
  const qc = useQueryClient();
  const [showTruth, setShowTruth] = useState(false);
  const [selected, setSelected] = useState<Bed | null>(null);
  const { data: beds = [] } = useQuery({
    queryKey: ["beds"],
    queryFn: () => api<Bed[]>("/beds"),
  });

  const bedAction = useMutation({
    mutationFn: (v: { id: string; path: string; body: unknown }) =>
      api(`/beds/${v.id}/${v.path}`, "POST", v.body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["beds"] });
      setSelected(null);
    },
  });
  const replan = useMutation({
    mutationFn: () => api("/plan/run", "POST"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["suggestions"] }),
  });

  const total = beds.length;
  const ready = beds.filter((b) => b.status === "ready").length;
  const doubted = beds.filter((b) => b.trust === "stale").length;
  const mismatches = beds.filter((b) => b.mismatch).length;

  return (
    <div className="mx-auto max-w-[1400px] space-y-3 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">BedSense · Bed Manager</h1>
        <div className="flex items-center gap-3 text-sm">
          <span>
            {ready}/{total} ready
          </span>
          <span>{doubted} doubted</span>
          {showTruth && (
            <span className="text-red-700">{mismatches} wrong on board</span>
          )}
          <button
            className="rounded border px-2 py-1"
            onClick={() => replan.mutate()}
          >
            Re-plan now
          </button>
          <span className="text-slate-500">{user?.name}</span>
          <button className="underline" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <DemoPanel showTruth={showTruth} setShowTruth={setShowTruth} />
      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <BedBoard showTruth={showTruth} onBed={setSelected} />
          {selected && (
            <div className="rounded-lg border bg-white p-3 text-sm">
              <b>{selected.label}</b> · {selected.status} · {selected.trust} ·{" "}
              {selected.room}
              <div className="mt-2 flex flex-wrap gap-2">
                {(
                  [
                    ["Keep free 2h", "hold", { minutes: 120 }],
                    ["Block", "events", { type: "BLOCKED" }],
                    ["Unblock", "events", { type: "UNBLOCKED" }],
                    [
                      "Discharge ordered",
                      "events",
                      { type: "DISCHARGE_ORDERED" },
                    ],
                    ["Patient left", "events", { type: "PATIENT_LEFT" }],
                    ["Cleaned", "events", { type: "CLEANED" }],
                  ] as const
                ).map(([label, path, body]) => (
                  <button
                    key={label}
                    className="rounded border px-2 py-1"
                    onClick={() =>
                      bedAction.mutate({ id: selected.id, path, body })
                    }
                  >
                    {label}
                  </button>
                ))}
                <button
                  className="px-2 text-slate-500"
                  onClick={() => setSelected(null)}
                >
                  Close
                </button>
              </div>
            </div>
          )}
          <Feed />
        </div>
        <div className="space-y-4">
          <AddPatient />
          <Queue />
        </div>
      </div>
    </div>
  );
}
