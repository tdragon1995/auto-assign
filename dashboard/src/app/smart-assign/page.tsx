"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

type Provider = "haversine" | "valhalla" | "goong";

interface DriverSuggestion {
  driver_id: string;
  driver_name: string;
  haversine_km: number;
  distance_km: number | null;
  eta_mins: number | null;
  status_id: number;
  last_login_ts: string | null;
  jobs_total: number | null;
  jobs_active: number | null;
  jobs_done: number | null;
}

interface JobSuggestion {
  job_id: number;
  pickup: string;
  unscheduled: boolean;
  drivers: DriverSuggestion[];
}

interface Result {
  suggestions: JobSuggestion[];
  unmatched: { job_id: number; reason: string }[];
  drivers_with_gps: number;
  provider: Provider;
}

const STATUS_DOT: Record<number, { color: string; label: string }> = {
  1: { color: "bg-green-500",  label: "Online"      },
  2: { color: "bg-blue-500",   label: "On Route"    },
  3: { color: "bg-slate-400",  label: "Not Active"  },
  4: { color: "bg-red-500",    label: "Offline"     },
  5: { color: "bg-amber-400",  label: "On Break"    },
};

function relativeTime(ts: string | null): string {
  if (!ts) return "—";
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function DriverCell({ d, provider }: { d: DriverSuggestion; provider: Provider }) {
  const dot = STATUS_DOT[d.status_id] ?? STATUS_DOT[4];
  const usesRouting = provider === "valhalla" || provider === "goong";
  const isRouteFallback = usesRouting && d.distance_km == null;
  const distLine = usesRouting && d.distance_km != null
    ? `${d.distance_km} km road · ${d.eta_mins ?? "?"}min`
    : `${d.haversine_km} km straight${isRouteFallback ? " ⚠️" : ""}`;

  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className="flex items-center gap-1.5">
        <span className={`inline-block size-2 rounded-full shrink-0 ${dot.color}`} title={dot.label} />
        <span className="text-xs font-semibold text-slate-800 truncate">{d.driver_name}</span>
      </div>
      <span className="text-[11px] text-slate-500">{distLine} · {relativeTime(d.last_login_ts)}</span>
      <span className="text-[11px] text-slate-400">
        {d.jobs_total === null
          ? "— jobs"
          : `${d.jobs_active ?? 0}/${d.jobs_total} active · ${d.jobs_done ?? 0}/${d.jobs_total} done`}
      </span>
    </div>
  );
}

const PROVIDERS: { key: Provider; label: string }[] = [
  { key: "haversine", label: "📐 Straight line" },
  { key: "valhalla",  label: "🛵 Valhalla (road)" },
  { key: "goong",     label: "🗺️ Goong (road)" },
];

export default function SmartAssignPage() {
  const [provider, setProvider] = useState<Provider>("haversine");
  const [status, setStatus]     = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult]     = useState<Result | null>(null);
  const [error, setError]       = useState("");

  const run = async () => {
    setStatus("loading");
    setResult(null);
    setError("");
    try {
      const res = await fetch(`/api/smart-assign?provider=${provider}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      setResult(data);
      setStatus("done");
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-5xl mx-auto space-y-6">

        <div>
          <h1 className="text-2xl font-bold">Smart Assign</h1>
          <p className="text-sm text-slate-500 mt-1">
            Top 3 nearest drivers per unassigned pickup — suggestions only, no writes to Cartrack.
          </p>
        </div>

        {/* Provider toggle */}
        <div className="flex gap-2">
          {PROVIDERS.map((p) => (
            <button
              key={p.key}
              onClick={() => setProvider(p.key)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                provider === p.key
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <Button onClick={run} disabled={status === "loading"} className="w-full h-12 text-base font-semibold">
          {status === "loading" ? "Calculating..." : "🧭 Preview Suggestions"}
        </Button>

        {status === "error" && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
        )}

        {result && (
          <div className="space-y-4">
            <div className="flex gap-3 text-sm flex-wrap">
              <span className="rounded-full bg-blue-100 text-blue-700 px-3 py-1 font-medium">
                🧭 {result.suggestions.length} jobs
              </span>
              {result.unmatched.length > 0 && (
                <span className="rounded-full bg-red-100 text-red-700 px-3 py-1 font-medium">
                  ⚠️ {result.unmatched.length} unmatched
                </span>
              )}
              <span className="rounded-full bg-slate-100 text-slate-600 px-3 py-1 font-medium">
                📍 {result.drivers_with_gps} drivers with GPS
              </span>
            </div>

            {result.suggestions.length > 0 && (
              <div className="rounded-lg border bg-white overflow-x-auto">
                <table className="w-full text-sm min-w-[640px]">
                  <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide border-b">
                    <tr>
                      <th className="px-4 py-2 text-left w-40">Job / Pickup</th>
                      <th className="px-4 py-2 text-left">#1 Nearest</th>
                      <th className="px-4 py-2 text-left">#2 Nearest</th>
                      <th className="px-4 py-2 text-left">#3 Nearest</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {result.suggestions.map((row) => (
                      <tr key={row.job_id} className="hover:bg-slate-50/60">
                        <td className="px-4 py-3 align-top">
                          <p className="font-mono text-xs text-slate-400">#{row.job_id}</p>
                          <p className="font-medium text-slate-800 text-xs leading-tight mt-0.5">{row.pickup}</p>
                          {row.unscheduled && (
                            <span className="mt-1 inline-block text-[10px] bg-amber-100 text-amber-700 rounded px-1 py-0.5 font-semibold">No schedule</span>
                          )}
                        </td>
                        {[0, 1, 2].map((i) =>
                          row.drivers[i] ? (
                            <td key={i} className="px-4 py-3 align-top">
                              <DriverCell d={row.drivers[i]} provider={result.provider} />
                            </td>
                          ) : (
                            <td key={i} className="px-4 py-3 align-top text-xs text-slate-300">—</td>
                          )
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {result.unmatched.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-1">
                <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">Unmatched Jobs</p>
                {result.unmatched.map((row) => (
                  <p key={row.job_id} className="text-sm text-amber-800">
                    <span className="font-mono">#{row.job_id}</span> — {row.reason}
                  </p>
                ))}
              </div>
            )}

            {result.suggestions.length === 0 && result.unmatched.length === 0 && (
              <p className="text-sm text-slate-400 text-center py-6">No unassigned jobs found for today.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
