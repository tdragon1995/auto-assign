"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { JOB_STATUS } from "@/lib/job-filters";
import { DIAG_LOCATIONS } from "@/lib/diag-locations";

type Env = "prod" | "uat";
type SubTab = "complete" | "dropoff";

interface JobSummary {
  job_id: number;
  job_status_id: number | null;
  reference_number: string | null;
  delivery_driver_id: string | null;
  pickup: { stop_id: number | null; customer_id: string | null; customer_name: string | null } | null;
  dropoff: { stop_id: number | null; customer_id: string | null; customer_name: string | null } | null;
  started: boolean;
}

// Terminal statuses where neither action is allowed.
const TERMINAL = new Set([3, 5, 7]);

const STATUS_BADGE: Record<number, string> = {
  2: "bg-amber-100 text-amber-700",
  3: "bg-red-100 text-red-700",
  4: "bg-blue-100 text-blue-700",
  5: "bg-emerald-100 text-emerald-700",
  7: "bg-slate-100 text-slate-500",
};

export function JobAdminPanel({ env }: { env: Env }) {
  const [tab, setTab] = useState<SubTab>("complete");

  // Shared job lookup
  const [jobIdInput, setJobIdInput] = useState("");
  const [job, setJob] = useState<JobSummary | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState("");

  // Complete action
  const [completing, setCompleting] = useState(false);

  // Change-dropoff action
  const [pscId, setPscId] = useState("");
  const [pscName, setPscName] = useState("");
  const [pscSearch, setPscSearch] = useState("");
  const [showPscList, setShowPscList] = useState(false);
  const [changing, setChanging] = useState(false);

  const clearPsc = useCallback(() => {
    setPscId("");
    setPscName("");
    setPscSearch("");
    setShowPscList(false);
  }, []);

  // A looked-up job belongs to one environment — clear it if the admin flips env.
  useEffect(() => {
    setJob(null);
    setLookupError("");
    clearPsc();
  }, [env, clearPsc]);

  const fetchJob = useCallback(
    async (id: string): Promise<JobSummary | null> => {
      setLookupLoading(true);
      setLookupError("");
      try {
        const res = await fetch(`/api/admin/job?job_id=${encodeURIComponent(id)}&env=${env}`);
        const data = await res.json();
        if (!res.ok) {
          setJob(null);
          setLookupError(data.error ?? "Không tìm thấy job");
          return null;
        }
        setJob(data);
        return data;
      } catch {
        setJob(null);
        setLookupError("Lỗi kết nối, vui lòng thử lại");
        return null;
      } finally {
        setLookupLoading(false);
      }
    },
    [env]
  );

  const lookup = useCallback(() => {
    const id = jobIdInput.trim();
    if (!id) return;
    clearPsc();
    fetchJob(id);
  }, [jobIdInput, fetchJob, clearPsc]);

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
      await fetchJob(String(job.job_id));
    } catch {
      toast.error("Lỗi kết nối, vui lòng thử lại");
    } finally {
      setCompleting(false);
    }
  }, [job, env, fetchJob]);

  const doChangeDropoff = useCallback(async () => {
    if (!job || !pscId) return;
    if (!window.confirm(`Đổi điểm giao của Job ${job.job_id}\nsang ${pscName}?`)) return;
    setChanging(true);
    try {
      const res = await fetch(`/api/admin/change-dropoff?env=${env}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Pass stop metadata so the server can skip its own getJobDetails round-trip.
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
      toast.success(`Đã đổi điểm giao sang ${newName}`);
      clearPsc();
      // Update state locally — no re-fetch needed; we know exactly what changed.
      setJob((prev) =>
        prev
          ? {
              ...prev,
              dropoff: {
                stop_id: prev.dropoff?.stop_id ?? null,
                customer_id: pscId,
                customer_name: newName,
              },
            }
          : prev
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
      (l) => l.name.toLowerCase().includes(q) || l.address.toLowerCase().includes(q)
    );
  }, [pscSearch, pscId]);

  const statusId = job?.job_status_id ?? null;
  const isTerminal = statusId != null && TERMINAL.has(statusId);

  return (
    <Card className="flex flex-col h-full py-4">
      <CardHeader className="pb-2 shrink-0">
        <CardTitle className="text-sm">Quản trị job</CardTitle>
        <div className="flex items-center rounded-lg overflow-hidden border w-fit text-xs font-semibold mt-1">
          <button
            onClick={() => setTab("complete")}
            className={`px-3 py-1 transition-colors ${tab === "complete" ? "bg-emerald-600 text-white" : "text-slate-500 hover:text-slate-800"}`}
          >
            Hoàn thành job
          </button>
          <button
            onClick={() => setTab("dropoff")}
            className={`px-3 py-1 border-l transition-colors ${tab === "dropoff" ? "bg-indigo-600 text-white" : "text-slate-500 hover:text-slate-800"}`}
          >
            Đổi điểm giao
          </button>
        </div>
      </CardHeader>

      <CardContent className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="max-w-md mx-auto space-y-4 pr-3">
            {/* Shared job lookup */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Job ID</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  value={jobIdInput}
                  onChange={(e) => setJobIdInput(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={(e) => { if (e.key === "Enter") lookup(); }}
                  placeholder="VD: 34317828"
                  className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
                />
                <Button size="sm" onClick={lookup} disabled={!jobIdInput.trim() || lookupLoading}>
                  {lookupLoading ? "Đang tra..." : "Tra cứu"}
                </Button>
              </div>
              {lookupError && (
                <p className="text-xs text-red-600 pt-0.5">{lookupError}</p>
              )}
            </div>

            {/* Job card */}
            {job && (
              <div className="rounded-xl border border-slate-200 p-3.5 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-semibold text-slate-800">#{job.job_id}</span>
                  {statusId != null && (
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_BADGE[statusId] ?? "bg-slate-100 text-slate-600"}`}>
                      {JOB_STATUS[statusId] ?? `Trạng thái ${statusId}`}
                    </span>
                  )}
                </div>
                {job.reference_number && (
                  <p className="font-mono text-[11px] text-slate-400 break-all">{job.reference_number}</p>
                )}
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
                {!job.delivery_driver_id && (
                  <p className="text-[11px] text-slate-400">Chưa có tài xế.</p>
                )}
              </div>
            )}

            {/* ── Complete sub-tab ── */}
            {tab === "complete" && job && (
              <div className="space-y-2">
                {isTerminal ? (
                  <p className="text-sm text-slate-500 text-center py-1">
                    {statusId === 5 ? "Job đã hoàn thành rồi." : `Không thể hoàn thành: job ${(JOB_STATUS[statusId!] ?? "").toLowerCase()}.`}
                  </p>
                ) : !job.delivery_driver_id ? (
                  <p className="text-sm text-slate-500 text-center py-1">
                    Chỉ hoàn thành được job đã giao cho tài xế.
                  </p>
                ) : (
                  <Button
                    onClick={doComplete}
                    disabled={completing}
                    className="w-full bg-emerald-600 hover:bg-emerald-700"
                  >
                    {completing ? "Đang hoàn thành..." : "Hoàn thành job"}
                  </Button>
                )}
              </div>
            )}

            {/* ── Change-dropoff sub-tab ── */}
            {tab === "dropoff" && job && (
              <div className="space-y-2">
                {isTerminal ? (
                  <p className="text-sm text-slate-500 text-center py-1">
                    Không thể đổi điểm giao: job {(JOB_STATUS[statusId!] ?? "").toLowerCase()}.
                  </p>
                ) : (
                  <>
                    {job.started && (
                      <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                        ⚠️ Tài xế đã bắt đầu — đổi điểm giao sẽ thay đổi lộ trình giữa chuyến.
                      </p>
                    )}
                    <div className="space-y-1 relative">
                      <label className="text-sm font-medium text-slate-700">Điểm giao mới (PSC)</label>
                      <div className="relative">
                        <input
                          type="text"
                          value={pscSearch}
                          onChange={(e) => {
                            setPscSearch(e.target.value);
                            setPscId("");
                            setPscName("");
                            setShowPscList(true);
                          }}
                          onFocus={() => setShowPscList(true)}
                          onBlur={() => setTimeout(() => setShowPscList(false), 150)}
                          placeholder="Tìm PSC (VD: D001)..."
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
                      </div>
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
                      className="w-full bg-indigo-600 hover:bg-indigo-700"
                    >
                      {changing ? "Đang đổi..." : pscId ? `Đổi điểm giao → ${pscName}` : "Đổi điểm giao"}
                    </Button>
                  </>
                )}
              </div>
            )}

            {!job && !lookupError && (
              <p className="text-sm text-slate-400 text-center py-6">
                Nhập Job ID rồi bấm Tra cứu để bắt đầu.
              </p>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
