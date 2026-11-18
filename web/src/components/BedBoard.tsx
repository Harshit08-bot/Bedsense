import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { Bed, BedStatus } from "../types";

export const STATUS_STYLE: Record<BedStatus, string> = {
  ready: "bg-emerald-200 border-emerald-500",
  reserved: "bg-sky-200 border-sky-500",
  occupied: "bg-rose-200 border-rose-400",
  discharging: "bg-amber-200 border-amber-500",
  dirty: "bg-orange-200 border-orange-500",
  blocked: "bg-slate-300 border-slate-500",
};
const HATCH = {
  backgroundImage:
    "repeating-linear-gradient(45deg, rgba(0,0,0,.18) 0 3px, transparent 3px 8px)",
};

export function BedTile({
  bed,
  showTruth,
  onClick,
}: {
  bed: Bed;
  showTruth?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={`${bed.label} - ${bed.status} (${bed.trust})`}
      style={bed.trust === "stale" ? HATCH : undefined}
      className={`relative h-14 w-16 rounded border-2 text-xs font-medium ${STATUS_STYLE[bed.status]} ${showTruth && bed.mismatch ? "ring-4 ring-red-600" : ""}`}
    >
      {bed.label}
      <div className="text-[10px] font-normal">{bed.status}</div>
      {bed.asking && (
        <span className="absolute -right-2 -top-2 rounded-full bg-indigo-600 px-1.5 text-white">
          ?
        </span>
      )}
      {bed.oxygen && (
        <span className="absolute bottom-0 right-0.5 text-[9px]">O₂</span>
      )}
      {bed.isolation && (
        <span className="absolute bottom-0 left-0.5 text-[9px]">ISO</span>
      )}
    </button>
  );
}

export const Legend = () => (
  <div className="flex flex-wrap gap-2 text-xs">
    {(Object.keys(STATUS_STYLE) as BedStatus[]).map((s) => (
      <span key={s} className={`rounded border px-2 py-0.5 ${STATUS_STYLE[s]}`}>
        {s}
      </span>
    ))}
    <span className="rounded border px-2 py-0.5" style={HATCH}>
      hatched = doubted
    </span>
    <span className="rounded border px-2 py-0.5">? = ward is being asked</span>
  </div>
);

export default function BedBoard({
  showTruth,
  onBed,
}: {
  showTruth: boolean;
  onBed: (b: Bed) => void;
}) {
  const { data: beds = [] } = useQuery({
    queryKey: ["beds"],
    queryFn: () => api<Bed[]>("/beds"),
  });
  const wards = [...new Set(beds.map((b) => b.ward))];
  return (
    <div className="space-y-4">
      <Legend />
      {wards.map((w) => {
        const list = beds.filter((b) => b.ward === w);
        const free = list.filter((b) => b.status === "ready").length;
        return (
          <section key={w}>
            <h3 className="mb-1 font-semibold">
              {w}{" "}
              <span className="text-sm font-normal text-slate-500">
                {free} ready / {list.length}
              </span>
            </h3>
            <div className="flex flex-wrap gap-2">
              {list.map((b) => (
                <BedTile
                  key={b.id}
                  bed={b}
                  showTruth={showTruth}
                  onClick={() => onBed(b)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
