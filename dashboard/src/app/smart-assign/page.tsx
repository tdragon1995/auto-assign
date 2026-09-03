"use client";

import { DriverName } from "@/components/driver-name";

import { useState } from "react";
import { Button } from "@/components/ui/button";

interface DriverSuggestion {
  driver_id: string;
  driver_name: string;
  haversine_km: number;
  status_id: number;
  last_login_ts: string | null;
  jobs_total: number | null;
  jobs_active: number | null;
  jobs_done: number | null;
  last_completed_ts: string | null;
  detour_label: "Arrived" | "En Route" | "Next Stop" | "First Stop" | "Available" | "Start Location" | null;
  detour_customer: string | null;
  detour_haversine_km: number | null;
  detour_distance_km: number | null;
  detour_eta_mins: number | null;
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
}

// One unassigned job in the search-result picker (from GET /api/smart-assign).
interface JobHit {
  job_id: number;
  pickup: string;
  dropoff: string;
  unscheduled: boolean;
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

function DriverCell({ d }: { d: DriverSuggestion }) {
  const dot = STATUS_DOT[d.status_id] ?? STATUS_DOT[4];

  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className="flex items-center gap-1.5">
        <span className={`inline-block size-2 rounded-full shrink-0 ${dot.color}`} title={dot.label} />
        <DriverName full={d.driver_name} className="text-xs font-semibold text-slate-800 truncate" />
      </div>
      <span className="text-[11px] text-slate-500">{d.haversine_km} km straight · {relativeTime(d.last_login_ts)}</span>
      {d.detour_haversine_km !== null && (
        <span className="text-[11px] text-indigo-500 font-medium">
          {d.detour_label}{d.detour_customer ? ` @ ${d.detour_customer}` : ""} →{" "}
          {d.detour_distance_km != null
            ? `${d.detour_distance_km} km · ${d.detour_eta_mins ?? "?"}min`
            : `${d.detour_haversine_km} km straight`}
        </span>
      )}
      <span className="text-[11px] text-slate-400">
        {d.jobs_total === null
          ? "— jobs"
          : `${d.jobs_active ?? 0}/${d.jobs_total} active · ${d.jobs_done ?? 0}/${d.jobs_total} done`}
      </span>
    </div>
  );
}

export default function SmartAssignPage() {
  // ── Search / picker ─────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<JobHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState("");

  // ── Preview run ─────────────────────────────────────────────────────────
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError]   = useState("");
  // null while a "preview all" run is showing; a job_id for a targeted run
  const [activeJobId, setActiveJobId] = useState<number | null>(null);

  const runPreview = async (jobId?: number) => {
    setStatus("loading");
    setResult(null);
    setError("");
    setActiveJobId(jobId ?? null);
    try {
      const url = jobId != null ? `/api/smart-assign?job_id=${jobId}` : "/api/smart-assign";
      const res = await fetch(url, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      setResult(data);
      setStatus("done");
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  };

  // Same convention as Quản trị job: all digits → direct Job ID, otherwise
  // search today's unassigned jobs by pickup/dropoff name.
  const runSearch = async () => {
    const q = query.trim();
    if (/^\d+$/.test(q)) {
      setHits([]);
      setSearched(false);
      setSearchError("");
      runPreview(Number(q));
      return;
    }
    setSearching(true);
    setSearched(true);
    setSearchError("");
    setHits([]);
    try {
      const res = await fetch("/api/smart-assign");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unknown error");
      const all: JobHit[] = Array.isArray(data.jobs) ? data.jobs : [];
      const lq = q.toLowerCase();
      const filtered = lq
        ? all.filter(
            (j) =>
              j.pickup.toLowerCase().includes(lq) ||
              j.dropoff.toLowerCase().includes(lq) ||
              String(j.job_id).includes(lq)
          )
        : all;
      setHits(filtered);
      // Single match → preview it right away.
      if (filtered.length === 1) runPreview(filtered[0].job_id);
    } catch (e) {
      setSearchError(String(e));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-5xl mx-auto space-y-6">

        <div>
          <h1 className="text-2xl font-bold">Smart Assign</h1>
          <p className="text-sm text-slate-500 mt-1">
            Top 3 drivers per unassigned pickup — pre-filtered by haversine, ranked by Goong road distance from last reference stop.
          </p>
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
            placeholder="Job ID hoặc tên khách hàng (để trống = tất cả job chưa gán)…"
            className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
          <Button onClick={runSearch} disabled={searching || status === "loading"}>
            {searching ? "Đang tìm…" : "Tìm"}
          </Button>
        </div>

        <Button
          variant="outline"
          onClick={() => { setHits([]); setSearched(false); runPreview(); }}
          disabled={status === "loading" || searching}
          className="w-full h-10 font-semibold"
        >
          {status === "loading" && activeJobId === null ? "Calculating..." : "🧭 Preview tất cả job chưa gán"}
        </Button>

        {searchError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{searchError}</div>
        )}

        {searched && !searching && hits.length === 0 && !searchError && (
          <p className="text-sm text-slate-400 text-center py-2">Không tìm thấy job chưa gán nào khớp.</p>
        )}

        {hits.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
              {hits.length} job chưa gán — chọn 1 job để xem gợi ý tài xế
            </p>
            {hits.map((hit) => {
              const isActive = activeJobId === hit.job_id;
              return (
                <button
                  key={hit.job_id}
                  type="button"
                  onClick={() => runPreview(hit.job_id)}
                  disabled={status === "loading"}
                  className={`w-full text-left px-3 py-2 rounded-lg border bg-white flex items-center justify-between gap-2 hover:bg-slate-50 ${
                    isActive ? "border-slate-400 ring-1 ring-slate-300" : "border-slate-200"
                  }`}
                >
                  <div className="min-w-0">
                    <span className="font-mono text-xs text-slate-400">#{hit.job_id}</span>
                    <p className="text-sm font-medium text-slate-800 leading-tight break-words">
                      {hit.pickup} <span className="text-slate-400">→</span> {hit.dropoff}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {hit.unscheduled && (
                      <span className="text-[10px] bg-amber-100 text-amber-700 rounded px-1 py-0.5 font-semibold">No schedule</span>
                    )}
                    <span className="text-slate-400 text-xs">{isActive && status === "loading" ? "…" : "▸"}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {status === "error" && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
        )}

        {result && (
          <div className="space-y-4">
            <div className="flex gap-3 text-sm flex-wrap">
              <span className="rounded-full bg-blue-100 text-blue-700 px-3 py-1 font-medium">
                🧭 {activeJobId != null ? `Job #${activeJobId}` : `${result.suggestions.length} jobs`}
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
                              <DriverCell d={row.drivers[i]} />
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
