"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { JOB_STATUS } from "@/lib/job-filters";
import { DIAG_LOCATIONS } from "@/lib/diag-locations";

type Env = "prod" | "uat";

interface JobSummary {
  job_id: number;
  job_status_id: number | null;
  reference_number: string | null;
  delivery_driver_id: string | null;
  pickup: { stop_id: number | null; customer_id: string | null; customer_name: string | null } | null;
  dropoff: { stop_id: number | null; customer_id: string | null; customer_name: string | null } | null;
  started: boolean;
}

// One row in the search result list. `statusId` is filled in lazily once the row
// is opened (and updated after an action), so the list reflects edits in place.
interface SearchHit {
  job_id: number;
  label: string;
  statusId?: number | null;
}

const TERMINAL = new Set([3, 5, 7]);

const STATUS_BADGE: Record<number, string> = {
  2: "bg-amber-100 text-amber-700",
  3: "bg-red-100 text-red-700",
  4: "bg-blue-100 text-blue-700",
  5: "bg-emerald-100 text-emerald-700",
  7: "bg-slate-100 text-slate-500",
};

export function JobAdminPanel({ env }: { env: Env }) {
  // ── Search ────────────────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searched, setSearched] = useState(false);

  // ── Active (opened) job ─────────────────────────────────────────────────────
  const [activeId, setActiveId] = useState<number | null>(null);
  const [job, setJob] = useState<JobSummary | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState("");

  const [completing, setCompleting] = useState(false);
  const [changing, setChanging] = useState(false);

  // Change-dropoff PSC picker (scoped to the active job)
  const [pscId, setPscId] = useState("");
  const [pscName, setPscName] = useState("");
  const [pscSearch, setPscSearch] = useState("");
  const [showPscList, setShowPscList] = useState(false);

  const clearPsc = useCallback(() => {
    setPscId("");
    setPscName("");
    setPscSearch("");
    setShowPscList(false);
  }, []);

  // A looked-up job belongs to one environment — reset everything on env flip.
  useEffect(() => {
    setResults([]);
    setSearched(false);
    setActiveId(null);
    setJob(null);
    setLookupError("");
    clearPsc();
  }, [env, clearPsc]);

  const setHitStatus = useCallback((id: number, statusId: number | null) => {
    setResults((prev) => prev.map((h) => (h.job_id === id ? { ...h, statusId } : h)));
  }, []);

  const fetchJob = useCallback(
    async (id: number) => {
      setLookupLoading(true);
      setLookupError("");
      try {
        const res = await fetch(`/api/admin/job?job_id=${id}&env=${env}`);
        const data = await res.json();
        if (!res.ok) {
          setJob(null);
          setLookupError(data.error ?? "Không tìm thấy job");
          return;
        }
        setJob(data);
        setHitStatus(id, data.job_status_id ?? null);
      } catch {
        setJob(null);
        setLookupError("Lỗi kết nối, vui lòng thử lại");
      } finally {
        setLookupLoading(false);
      }
    },
    [env, setHitStatus],
  );

  // Open / collapse a result row. Opening fetches its live details + guards.
  const openHit = useCallback(
    (id: number) => {
      clearPsc();
      if (activeId === id) {
        setActiveId(null);
        setJob(null);
        setLookupError("");
        return;
      }
      setActiveId(id);
      setJob(null);
      fetchJob(id);
    },
    [activeId, clearPsc, fetchJob],
  );

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setActiveId(null);
    setJob(null);
    setSearching(true);
    setSearchError("");
    setSearched(true);
    try {
      // All digits → treat as a direct Job ID; otherwise search the activity log.
      if (/^\d+$/.test(q)) {
        const id = Number(q);
        setResults([{ job_id: id, label: `Job ${id}` }]);
        clearPsc();
        setActiveId(id);
        setJob(null);
        fetchJob(id);
      } else {
        const res = await fetch(`/api/admin/search-jobs?q=${encodeURIComponent(q)}&env=${env}`);
        const data = await res.json();
        setResults(Array.isArray(data.results) ? data.results : []);
      }
    } catch {
      setResults([]);
      setSearchError("Lỗi tìm kiếm, vui lòng thử lại");
    } finally {
      setSearching(false);
    }
    // fetchJob/clearPsc omitted from deps — stable enough for this one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, env]);

  const doComplete = useCallback(async () => {
    if (!job) return;
    if (!window.confirm(`Hoàn thành Job ${job.job_id}?\n\nThao tác này đánh dấu job đã xong và không thể hoàn tác.`)) return;
    setCompleting(true);
    try {
      const res = await fetch(`/api/admin/complete-job?env=${env}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.job_id }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Hoàn thành job thất bại");
        return;
      }
      toast.success(`Đã hoàn thành Job ${job.job_id}`);
      setJob((prev) => (prev ? { ...prev, job_status_id: 5 } : prev));
      setHitStatus(job.job_id, 5);
    } catch {
      toast.error("Lỗi kết nối, vui lòng thử lại");
    } finally {
      setCompleting(false);
    }
  }, [job, env, setHitStatus]);

  const doChangeDropoff = useCallback(async () => {
    if (!job || !pscId) return;
    if (!window.confirm(`Đổi điểm giao của Job ${job.job_id}\nsang ${pscName}?`)) return;
    setChanging(true);
    try {
      const res = await fetch(`/api/admin/change-dropoff?env=${env}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: job.job_id,
          new_dropoff_customer_id: pscId,
          job_status_id: job.job_status_id,
          pickup_stop_id: job.pickup?.stop_id,
          pickup_customer_id: job.pickup?.customer_id,
          dropoff_stop_id: job.dropoff?.stop_id,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Đổi điểm giao thất bại");
        return;
      }
      const newName = data.dropoff_name ?? pscName;
      toast.success(`Đã đổi điểm giao Job ${job.job_id} → ${newName}`);
      clearPsc();
      setJob((prev) =>
        prev
          ? { ...prev, dropoff: { stop_id: prev.dropoff?.stop_id ?? null, customer_id: pscId, customer_name: newName } }
          : prev,
      );
    } catch {
      toast.error("Lỗi kết nối, vui lòng thử lại");
    } finally {
      setChanging(false);
    }
  }, [job, pscId, pscName, env, clearPsc]);

  const filteredPscs = useMemo(() => {
    const q = pscSearch.trim().toLowerCase();
    if (!q || pscId) return DIAG_LOCATIONS;
    return DIAG_LOCATIONS.filter(
      (l) => l.name.toLowerCase().includes(q) || l.address.toLowerCase().includes(q),
    );
  }, [pscSearch, pscId]);

  const statusId = job?.job_status_id ?? null;
  const isTerminal = statusId != null && TERMINAL.has(statusId);

  return (
    <Card className="flex flex-col h-full py-4">
      <CardHeader className="pb-2 shrink-0 space-y-2">
        <CardTitle className="text-sm">Quản trị job</CardTitle>
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
            placeholder="Job ID hoặc tên khách hàng…"
            className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
          <Button size="sm" onClick={runSearch} disabled={!query.trim() || searching}>
            {searching ? "Đang tìm…" : "Tìm"}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="space-y-1.5 pr-3">
            {searchError && <p className="text-xs text-red-600">{searchError}</p>}
            {searched && !searching && results.length === 0 && !searchError && (
              <p className="text-sm text-slate-400 text-center py-6">
                Không tìm thấy job nào khớp.
              </p>
            )}

            {results.map((hit) => {
              const isActive = activeId === hit.job_id;
              return (
                <div key={hit.job_id} className={`rounded-lg border ${isActive ? "border-slate-400" : "border-slate-200"}`}>
                  {/* Result row — click to open this job's editor */}
                  <button
                    type="button"
                    onClick={() => openHit(hit.job_id)}
                    className="w-full text-left px-3 py-2 flex items-center justify-between gap-2 hover:bg-slate-50 rounded-lg"
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-sm font-semibold text-slate-800">#{hit.job_id}</div>
                      {hit.label && (
                        <div className="text-xs text-slate-600 break-words leading-snug">{hit.label}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {hit.statusId != null && (
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${STATUS_BADGE[hit.statusId] ?? "bg-slate-100 text-slate-600"}`}>
                          {JOB_STATUS[hit.statusId] ?? hit.statusId}
                        </span>
                      )}
                      <span className="text-slate-400 text-xs">{isActive ? "▾" : "▸"}</span>
                    </div>
                  </button>

                  {/* Inline editor for the opened job */}
                  {isActive && (
                    <div className="border-t px-3 py-3 space-y-3">
                      {lookupLoading && <p className="text-xs text-slate-400">Đang tải chi tiết…</p>}
                      {lookupError && <p className="text-xs text-red-600">{lookupError}</p>}

                      {job && (
                        <>
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <a
                                href={`https://fleetweb-vn.cartrack.com/delivery/map?job=${job.job_id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-mono text-xs font-semibold text-indigo-600 underline hover:text-indigo-800"
                              >
                                #{job.job_id}
                              </a>
                              {statusId != null && (
                                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_BADGE[statusId] ?? "bg-slate-100 text-slate-600"}`}>
                                  {JOB_STATUS[statusId] ?? `Trạng thái ${statusId}`}
                                </span>
                              )}
                            </div>
                            <div className="space-y-1 text-sm">
                              <div className="flex gap-2">
                                <span className="text-[10px] font-bold uppercase text-slate-400 pt-0.5 w-9 shrink-0">LẤY</span>
                                <span className="text-slate-800 font-medium">{job.pickup?.customer_name ?? "—"}</span>
                              </div>
                              <div className="flex gap-2">
                                <span className="text-[10px] font-bold uppercase text-slate-400 pt-0.5 w-9 shrink-0">GIAO</span>
                                <span className="text-slate-800 font-medium">{job.dropoff?.customer_name ?? "—"}</span>
                              </div>
                            </div>
                          </div>

                          {/* Complete */}
                          {isTerminal ? (
                            <p className="text-xs text-slate-500">
                              {statusId === 5 ? "Job đã hoàn thành rồi." : `Không thể thao tác: job ${(JOB_STATUS[statusId!] ?? "").toLowerCase()}.`}
                            </p>
                          ) : (
                            <div className="space-y-2.5">
                              {job.delivery_driver_id ? (
                                <Button
                                  onClick={doComplete}
                                  disabled={completing}
                                  className="w-full h-8 bg-emerald-600 hover:bg-emerald-700"
                                >
                                  {completing ? "Đang hoàn thành…" : "Hoàn thành job"}
                                </Button>
                              ) : (
                                <p className="text-[11px] text-slate-400">Chỉ hoàn thành được job đã giao cho tài xế.</p>
                              )}

                              {/* Change dropoff */}
                              <div className="space-y-1.5">
                                {job.started && (
                                  <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                                    ⚠️ Tài xế đã bắt đầu — đổi điểm giao sẽ thay đổi lộ trình giữa chuyến.
                                  </p>
                                )}
                                <div className="relative">
                                  <input
                                    type="text"
                                    value={pscSearch}
                                    onChange={(e) => { setPscSearch(e.target.value); setPscId(""); setPscName(""); setShowPscList(true); }}
                                    onFocus={() => setShowPscList(true)}
                                    onBlur={() => setTimeout(() => setShowPscList(false), 150)}
                                    placeholder="Đổi điểm giao → tìm PSC (VD: D001)…"
                                    className="w-full border border-slate-300 rounded-lg px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                                  />
                                  {pscSearch && (
                                    <button
                                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                                      onMouseDown={(e) => { e.preventDefault(); clearPsc(); }}
                                    >
                                      ×
                                    </button>
                                  )}
                                  {showPscList && !pscId && filteredPscs.length > 0 && (
                                    <ul className="absolute z-10 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-52 overflow-y-auto mt-1">
                                      {filteredPscs.map((l) => (
                                        <li
                                          key={l.customer_id}
                                          className="px-3 py-2 cursor-pointer hover:bg-indigo-50"
                                          onMouseDown={() => {
                                            setPscId(l.customer_id);
                                            setPscName(l.name);
                                            setPscSearch(l.name);
                                            setShowPscList(false);
                                          }}
                                        >
                                          <div className="text-sm font-medium text-slate-800">{l.name}</div>
                                          <div className="text-xs text-slate-400 truncate">{l.address}</div>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                                <Button
                                  onClick={doChangeDropoff}
                                  disabled={!pscId || changing}
                                  className="w-full h-8 bg-indigo-600 hover:bg-indigo-700"
                                >
                                  {changing ? "Đang đổi…" : pscId ? `Đổi điểm giao → ${pscName}` : "Đổi điểm giao"}
                                </Button>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
