"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, LockOpen, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { JOB_STATUS } from "@/lib/job-filters";
import { DIAG_LOCATIONS, type DiagLocation } from "@/lib/diag-locations";
import { foldName } from "@/lib/driver-cell";
import { driverDisplayName } from "@/lib/display-names";
import { DriverName } from "./driver-name";
import type { ConfigDriver } from "@/lib/types";

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

/** A request from elsewhere on the page ("Điều chỉnh" on a Cần xử lý row) to open
 *  one job here. `seq` makes a second click on the same job count as a new ask. */
export interface JobAdminRequest {
  jobId: number;
  seq: number;
}

type Notice = { tone: "hint" | "error"; text: string } | null;

const TERMINAL = new Set([3, 5, 7]);

// Text is the -800 step on each tint so the smallest type on the panel still
// clears 4.5:1; the -700 steps did not on the lighter tints.
const STATUS_BADGE: Record<number, string> = {
  2: "bg-amber-100 text-amber-800",
  3: "bg-red-100 text-red-800",
  4: "bg-blue-100 text-blue-800",
  5: "bg-emerald-100 text-emerald-800",
  7: "bg-slate-100 text-slate-700",
};

const cartrackJob = (id: number) => `https://fleetweb-vn.cartrack.com/delivery/map?job=${id}`;

const hhmm = (ts: number) =>
  new Date(ts).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });

/** Swap the destination at the end of a result label. Every label the search
 *  produces ends in "… → <dropoff>" (log lines and a driver's route alike), so a
 *  changed dropoff can be written back into the row instead of leaving it stale. */
const withDropoff = (label: string, name: string) => {
  const i = label.lastIndexOf(" → ");
  return i === -1 ? label : label.slice(0, i + 3) + name;
};

/** The row a number gets when it also matched customers: "maybe you meant a job". */
const PROBE_LABEL = "Tra số này như Job ID trên Cartrack";

const routeOf = (j: JobSummary) =>
  `${j.pickup?.customer_name ?? "—"} → ${j.dropoff?.customer_name ?? "—"}`;

export function JobAdminPanel({
  env,
  drivers,
  openRequest,
}: {
  env: Env;
  drivers: ConfigDriver[];
  openRequest?: JobAdminRequest | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputId = useId();

  // ── Search ────────────────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [searched, setSearched] = useState(false);

  // ── Active (opened) job ─────────────────────────────────────────────────────
  const [activeId, setActiveId] = useState<number | null>(null);
  const [job, setJob] = useState<JobSummary | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState("");

  // Every lookup and search takes a ticket; an answer whose ticket is no longer
  // the newest is dropped. Without it, opening row A then row B quickly could
  // land A's details under B — and the buttons would then act on A.
  const lookupSeq = useRef(0);
  const searchSeq = useRef(0);

  // ── Actions ───────────────────────────────────────────────────────────────
  const [confirming, setConfirming] = useState<null | "complete" | "dropoff">(null);
  const [completing, setCompleting] = useState(false);
  const [changing, setChanging] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [psc, setPsc] = useState<DiagLocation | null>(null);
  // driver_id → when their geofence locks again, so the button shows it is already open.
  const [openUntil, setOpenUntil] = useState<Record<string, number>>({});
  // Re-rendered at the next expiry below, so "Đã mở đến" gives the button back
  // on its own when the five minutes are up.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const next = Object.values(openUntil).filter((t) => t > now).sort((a, b) => a - b)[0];
    if (!next) return;
    const t = setTimeout(() => setNow(Date.now()), next - Date.now() + 250);
    return () => clearTimeout(t);
  }, [openUntil, now]);

  const driverNames = useMemo(() => new Map(drivers.map((d) => [d.driver_id, d.name])), [drivers]);

  const resetEditor = useCallback(() => {
    setPsc(null);
    setConfirming(null);
  }, []);

  const setHit = useCallback((id: number, patch: (h: SearchHit) => Partial<SearchHit>) => {
    setResults((prev) => prev.map((h) => (h.job_id === id ? { ...h, ...patch(h) } : h)));
  }, []);

  const fetchJob = useCallback(
    async (id: number, direct = false) => {
      const seq = ++lookupSeq.current;
      setLookupLoading(true);
      setLookupError("");
      try {
        const res = await fetch(`/api/admin/job?job_id=${id}&env=${env}`);
        const data = await res.json();
        if (seq !== lookupSeq.current) return;
        if (!res.ok) {
          setJob(null);
          if (direct && res.status === 404) {
            // A typed number that is not a job is a search with no result, not a
            // row that failed to open.
            setResults([]);
            setActiveId(null);
            setNotice({ tone: "error", text: `Không có job hay mã khách nào khớp ${id} hôm nay.` });
          } else {
            setLookupError(data.error ?? "Không tải được job.");
          }
          return;
        }
        setJob(data);
        setHit(id, (h) => ({
          statusId: data.job_status_id ?? null,
          label: h.label && h.label !== PROBE_LABEL ? h.label : routeOf(data),
        }));
      } catch {
        if (seq !== lookupSeq.current) return;
        setJob(null);
        setLookupError("Mất kết nối khi tải job.");
      } finally {
        if (seq === lookupSeq.current) setLookupLoading(false);
      }
    },
    [env, setHit],
  );

  // Open / collapse a result row. Opening fetches its live details + guards.
  const openHit = useCallback(
    (id: number) => {
      resetEditor();
      if (activeId === id) {
        lookupSeq.current++;
        setLookupLoading(false);
        setActiveId(null);
        setJob(null);
        setLookupError("");
        return;
      }
      setActiveId(id);
      setJob(null);
      fetchJob(id);
    },
    [activeId, resetEditor, fetchJob],
  );

  /** A Job ID goes straight to Cartrack — no log scan, one lookup. */
  const lookupById = useCallback(
    (id: number) => {
      searchSeq.current++;
      setSearching(false);
      setNotice(null);
      resetEditor();
      setSearched(true);
      setResults([{ job_id: id, label: "" }]);
      setActiveId(id);
      setJob(null);
      fetchJob(id, true);
    },
    [fetchJob, resetEditor],
  );

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    // Digits are EITHER a job number or a customer code ("21362 - D11 - ACo - …"), so a
    // number is searched like a name first — that costs no Cartrack call — and only a
    // number nothing matches goes straight to Cartrack as a Job ID.
    const digits = /^\d+$/.test(q);
    if (digits && q.length < 2) {
      lookupById(Number(q));
      return;
    }
    lookupSeq.current++;
    resetEditor();
    setActiveId(null);
    setJob(null);
    setLookupLoading(false);
    if (q.length < 2) {
      // The server ignores one-letter queries; saying "no match" would be a lie.
      setSearched(false);
      setResults([]);
      setNotice({ tone: "hint", text: "Nhập ít nhất 2 chữ để tìm theo tên." });
      return;
    }
    const seq = ++searchSeq.current;
    setNotice(null);
    setSearching(true);
    setSearched(true);
    try {
      const res = await fetch(`/api/admin/search-jobs?q=${encodeURIComponent(q)}&env=${env}`);
      const data = await res.json();
      if (seq !== searchSeq.current) return;
      if (!res.ok) throw new Error();
      const hits: SearchHit[] = Array.isArray(data.results) ? data.results : [];
      // Cartrack did not answer: the list came from the day snapshot + activity log,
      // which is NOT limited to jobs on the road. Say so rather than pass it off.
      const fallbackNote: Notice = data.source === "fallback" && hits.length
        ? { tone: "hint", text: "Cartrack chưa trả lời — danh sách lấy từ nhật ký, có thể gồm job đã xong." }
        : null;
      if (digits) {
        const id = Number(q);
        const own = hits.find((h) => h.job_id === id);
        if (own) {
          // It IS a job number: that job first, opened, like a direct lookup.
          setResults([own, ...hits.filter((h) => h !== own)]);
          setActiveId(id);
          fetchJob(id);
        } else if (hits.length) {
          // A customer code. The number still gets a row, unopened, in case it was
          // meant as a job — opening it is the one Cartrack call, and only on demand.
          setResults([{ job_id: id, label: PROBE_LABEL }, ...hits]);
          setNotice(fallbackNote);
        } else {
          lookupById(id);
        }
        return;
      }
      setResults(hits);
      setNotice(fallbackNote);
    } catch {
      if (seq !== searchSeq.current) return;
      setResults([]);
      setNotice({ tone: "error", text: "Mất kết nối khi tìm — bấm Tìm để thử lại." });
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, [query, env, lookupById, resetEditor, fetchJob]);

  // "Điều chỉnh" on a Cần xử lý row: put the job here without retyping its number.
  useEffect(() => {
    if (!openRequest) return;
    setQuery(String(openRequest.jobId));
    lookupById(openRequest.jobId);
    // On a phone this panel sits below the list; bring it to the reader.
    rootRef.current?.scrollIntoView({ block: "nearest" });
    // Keyed on seq alone: a new request is the only thing that should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest?.seq]);

  const doComplete = useCallback(async () => {
    if (!job) return;
    const id = job.job_id;
    setCompleting(true);
    try {
      const res = await fetch(`/api/admin/complete-job?env=${env}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: id }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Hoàn thành job thất bại");
        return;
      }
      toast.success(`Đã hoàn thành Job ${id}`);
      setConfirming(null);
      setJob((prev) => (prev?.job_id === id ? { ...prev, job_status_id: 5 } : prev));
      setHit(id, () => ({ statusId: 5 }));
    } catch {
      toast.error("Mất kết nối — job chưa được hoàn thành, thử lại.");
    } finally {
      setCompleting(false);
    }
  }, [job, env, setHit]);

  const doGeofenceBypass = useCallback(async () => {
    const driverId = job?.delivery_driver_id;
    if (!job || !driverId) return;
    setUnlocking(true);
    try {
      const res = await fetch(`/api/admin/geofence-bypass?env=${env}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.job_id, driver_id: driverId }),
      });
      const data = await res.json();
      if (!res.ok) toast.error(data.error ?? "Mở khóa tọa độ thất bại");
      else {
        setOpenUntil((m) => ({ ...m, [driverId]: data.until }));
        setNow(Date.now());
        toast.success(`Đã mở khóa tọa độ đến ${hhmm(data.until)}`);
      }
    } catch {
      toast.error("Mất kết nối — chưa mở khóa, thử lại.");
    } finally {
      setUnlocking(false);
    }
  }, [job, env]);

  const doChangeDropoff = useCallback(async () => {
    if (!job || !psc) return;
    const id = job.job_id;
    const target = psc;
    setChanging(true);
    try {
      const res = await fetch(`/api/admin/change-dropoff?env=${env}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: id,
          new_dropoff_customer_id: target.customer_id,
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
      const newName: string = data.dropoff_name ?? target.customer_name;
      toast.success(`Đã đổi điểm giao Job ${id} → ${newName}`);
      resetEditor();
      setJob((prev) =>
        prev?.job_id === id
          ? { ...prev, dropoff: { stop_id: prev.dropoff?.stop_id ?? null, customer_id: target.customer_id, customer_name: newName } }
          : prev,
      );
      setHit(id, (h) => ({ label: withDropoff(h.label, newName) }));
    } catch {
      toast.error("Mất kết nối — điểm giao chưa đổi, thử lại.");
    } finally {
      setChanging(false);
    }
  }, [job, psc, env, resetEditor, setHit]);

  const statusId = job?.job_status_id ?? null;
  const isTerminal = statusId != null && TERMINAL.has(statusId);
  const driverId = job?.delivery_driver_id ?? null;
  const driverName = driverId ? driverNames.get(driverId) : undefined;
  const unlockedUntil = driverId && (openUntil[driverId] ?? 0) > now ? openUntil[driverId] : null;

  return (
    // Beside the Cần xử lý list on a wide screen (the tool you reach for when
    // fixing a row there), below it on a phone. It fetches nothing until someone
    // searches or presses "Điều chỉnh" on a row.
    <Card ref={rootRef} className="gap-3 py-3 lg:h-full lg:min-h-0">
      <CardHeader className="px-4 gap-1">
        <CardTitle className="text-sm">Điều chỉnh job</CardTitle>
        <p className="text-xs text-slate-600">Đổi điểm giao, mở khóa tọa độ hoặc hoàn thành một job.</p>
      </CardHeader>

      <CardContent className="px-4 flex flex-col gap-3 lg:flex-1 lg:min-h-0">
        <form
          className="space-y-1"
          onSubmit={(e) => { e.preventDefault(); runSearch(); }}
        >
          <label htmlFor={inputId} className="text-xs font-medium text-slate-700">
            Job ID, tên khách hoặc tên tài xế
          </label>
          <div className="flex gap-2">
            <input
              id={inputId}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="VD: 34464285 hoặc Thuỷ Tâm"
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm placeholder:text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            />
            <Button type="submit" size="sm" disabled={!query.trim() || searching}>
              {searching ? "Đang tìm…" : "Tìm"}
            </Button>
          </div>
        </form>

        <div aria-live="polite" className="empty:hidden">
          {notice && (
            <p
              role={notice.tone === "error" ? "alert" : undefined}
              className={`text-xs ${notice.tone === "error" ? "text-red-700" : "text-slate-700"}`}
            >
              {notice.text}
            </p>
          )}
          {searched && !searching && !notice && results.length === 0 && (
            <p className="text-xs text-slate-700">
              Không có job chưa xong nào khớp hôm nay. Job đã xong thì nhập số job để tra thẳng.
            </p>
          )}
          {searching && <p className="text-xs text-slate-600">Đang tìm…</p>}
        </div>

        {results.length > 0 && (
          <div className="flex flex-col gap-1.5 lg:min-h-0 lg:flex-1">
            {(() => {
              const n = results.filter((h) => h.label !== PROBE_LABEL).length;
              return n > 1 ? <p className="text-[11px] font-medium text-slate-600">{n} job</p> : null;
            })()}
            <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              {results.map((hit) => {
                const isActive = activeId === hit.job_id;
                const panelId = `job-admin-${hit.job_id}`;
                const Chevron = isActive ? ChevronDown : ChevronRight;
                return (
                  <li key={hit.job_id} className={isActive ? "bg-slate-50" : undefined}>
                    <button
                      type="button"
                      onClick={() => openHit(hit.job_id)}
                      aria-expanded={isActive}
                      aria-controls={isActive ? panelId : undefined}
                      className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
                    >
                      <Chevron className="mt-0.5 size-4 shrink-0 text-slate-500" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-sm font-semibold text-slate-900">Job {hit.job_id}</span>
                          {hit.statusId != null && (
                            <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none ${STATUS_BADGE[hit.statusId] ?? "bg-slate-100 text-slate-700"}`}>
                              {JOB_STATUS[hit.statusId] ?? `Trạng thái ${hit.statusId}`}
                            </span>
                          )}
                        </span>
                        {hit.label && (
                          <span className="mt-0.5 block text-xs leading-snug text-slate-700 break-words">{hit.label}</span>
                        )}
                      </span>
                    </button>

                    {isActive && (
                      <div id={panelId} className="space-y-3 px-3 pb-3 pt-1">
                        {lookupLoading && (
                          <p role="status" className="text-xs text-slate-600">Đang tải chi tiết…</p>
                        )}
                        {lookupError && (
                          <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-red-700">
                            {lookupError}
                            <Button size="xs" variant="outline" onClick={() => fetchJob(hit.job_id)}>Thử lại</Button>
                          </div>
                        )}

                        {job && job.job_id === hit.job_id && (
                          <>
                            <dl className="grid grid-cols-[3.25rem_1fr] gap-x-2 gap-y-1 text-sm">
                              <dt className="pt-0.5 text-[11px] font-semibold uppercase text-slate-600">Lấy</dt>
                              <dd className="font-medium text-slate-900 break-words">{job.pickup?.customer_name ?? "—"}</dd>
                              <dt className="pt-0.5 text-[11px] font-semibold uppercase text-slate-600">Giao</dt>
                              <dd className="font-medium text-slate-900 break-words">{job.dropoff?.customer_name ?? "—"}</dd>
                              <dt className="pt-0.5 text-[11px] font-semibold uppercase text-slate-600">Tài xế</dt>
                              <dd className="flex flex-wrap items-baseline gap-x-1.5 text-slate-900">
                                {driverName ? (
                                  <DriverName full={driverName} className="font-medium text-slate-900" />
                                ) : driverId ? (
                                  <span className="text-slate-700">Không có trong danh sách tài xế</span>
                                ) : (
                                  <span className="text-slate-700">Chưa giao</span>
                                )}
                              </dd>
                            </dl>
                            <a
                              href={cartrackJob(job.job_id)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs font-medium text-indigo-700 underline underline-offset-2 hover:text-indigo-900"
                            >
                              Mở trên Cartrack
                              <ExternalLink className="size-3" aria-hidden />
                            </a>

                            {isTerminal ? (
                              <p className="rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-700">
                                {statusId === 5
                                  ? "Job đã hoàn thành — không còn thao tác nào."
                                  : `Job ${(JOB_STATUS[statusId!] ?? "đã kết thúc").toLowerCase()} — không còn thao tác nào.`}
                              </p>
                            ) : (
                              <>
                                {/* ── Route: the everyday fix ───────────────── */}
                                <section className="space-y-1.5 border-t border-slate-200 pt-3" aria-label="Đổi điểm giao">
                                  <h4 className="text-xs font-semibold text-slate-800">Đổi điểm giao</h4>
                                  {job.started && (
                                    <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
                                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} aria-hidden />
                                      Chuyến đã bắt đầu — đổi điểm giao sẽ đổi lộ trình giữa chuyến.
                                    </p>
                                  )}
                                  <PscCombobox
                                    value={psc}
                                    onChange={(l) => { setPsc(l); setConfirming(null); }}
                                    excludeId={job.dropoff?.customer_id ?? null}
                                  />
                                  {psc && confirming !== "dropoff" && (
                                    <Button size="sm" variant="outline" onClick={() => setConfirming("dropoff")}>
                                      Đổi sang {psc.customer_name}
                                    </Button>
                                  )}
                                  {psc && confirming === "dropoff" && (
                                    <ConfirmBox
                                      title={`Đổi điểm giao Job ${job.job_id}?`}
                                      lines={[
                                        `${job.dropoff?.customer_name ?? "—"} → ${psc.customer_name}`,
                                        ...(job.started ? ["Tài xế đang chạy chuyến này."] : []),
                                      ]}
                                      confirmLabel={changing ? "Đang đổi…" : "Xác nhận đổi"}
                                      busy={changing}
                                      tone="indigo"
                                      onConfirm={doChangeDropoff}
                                      onCancel={() => setConfirming(null)}
                                    />
                                  )}
                                </section>

                                {/* ── Driver help: temporary, so no confirm ─── */}
                                {driverId && (
                                  <section className="space-y-1.5 border-t border-slate-200 pt-3" aria-label="Mở khóa tọa độ">
                                    <h4 className="text-xs font-semibold text-slate-800">Mở khóa tọa độ</h4>
                                    <p className="text-xs leading-snug text-slate-600">
                                      Cho tài xế hoàn thành điểm dừng khi chưa tới đúng vị trí. Mở 5 phút, áp dụng cho mọi job của tài xế này.
                                    </p>
                                    {/* Open is a state, not a button to squint at: a
                                        disabled grey button read as broken. */}
                                    {unlockedUntil ? (
                                      <p role="status" className="flex items-center gap-1.5 text-xs font-medium text-emerald-800">
                                        <LockOpen className="size-3.5" aria-hidden />
                                        Đang mở đến {hhmm(unlockedUntil)}
                                      </p>
                                    ) : (
                                      <Button size="sm" variant="outline" onClick={doGeofenceBypass} disabled={unlocking}>
                                        {unlocking ? "Đang mở…" : "Mở khóa 5 phút"}
                                      </Button>
                                    )}
                                  </section>
                                )}

                                {/* ── Complete: the one that cannot be undone ── */}
                                <section className="space-y-1.5 border-t border-slate-200 pt-3" aria-label="Hoàn thành job">
                                  <h4 className="text-xs font-semibold text-slate-800">Hoàn thành job</h4>
                                  {!driverId ? (
                                    <p className="text-xs leading-snug text-slate-600">
                                      Chỉ hoàn thành được job đã có tài xế. Giao tài xế ở danh sách Cần xử lý trước.
                                    </p>
                                  ) : confirming === "complete" ? (
                                    <ConfirmBox
                                      title={`Hoàn thành Job ${job.job_id}?`}
                                      lines={[
                                        routeOf(job),
                                        driverName ? `Tài xế: ${driverDisplayName(driverName) || driverName}` : "",
                                        "Job sẽ được đánh dấu đã xong. Không thể hoàn tác.",
                                      ].filter(Boolean)}
                                      confirmLabel={completing ? "Đang hoàn thành…" : "Xác nhận hoàn thành"}
                                      busy={completing}
                                      tone="emerald"
                                      onConfirm={doComplete}
                                      onCancel={() => setConfirming(null)}
                                    />
                                  ) : (
                                    <Button size="sm" variant="outline" onClick={() => setConfirming("complete")}>
                                      Hoàn thành job…
                                    </Button>
                                  )}
                                </section>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * An inline confirm, in place of window.confirm: it restates WHAT is about to
 * change in the panel's own words, where the browser dialog carried only a job
 * number and hid the page it was asking about.
 */
function ConfirmBox({
  title,
  lines,
  confirmLabel,
  busy,
  tone,
  onConfirm,
  onCancel,
}: {
  title: string;
  lines: string[];
  confirmLabel: string;
  busy: boolean;
  tone: "emerald" | "indigo";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { confirmRef.current?.focus(); }, []);
  return (
    <div
      role="group"
      aria-label={title}
      className="space-y-2 rounded-md border border-slate-300 bg-white px-3 py-2.5"
      onKeyDown={(e) => { if (e.key === "Escape" && !busy) onCancel(); }}
    >
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      <ul className="space-y-0.5 text-xs text-slate-700">
        {lines.map((l) => <li key={l} className="break-words">{l}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          ref={confirmRef}
          size="sm"
          onClick={onConfirm}
          disabled={busy}
          className={tone === "emerald" ? "bg-emerald-700 text-white hover:bg-emerald-800" : "bg-indigo-700 text-white hover:bg-indigo-800"}
        >
          {confirmLabel}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
          Huỷ
        </Button>
      </div>
    </div>
  );
}

/**
 * Pick a PSC. Same contract as DriverCombobox: picked, never typed, arrow keys
 * and Enter work, the search folds accents, and the menu is positioned FIXED so
 * the panel's own scroller cannot clip it — the old absolutely-positioned list
 * showed about ten pixels of itself inside a 30vh box.
 */
function PscCombobox({
  value,
  onChange,
  excludeId,
}: {
  value: DiagLocation | null;
  onChange: (l: DiagLocation | null) => void;
  /** The job's current dropoff — changing to it would be a no-op. */
  excludeId: string | null;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);
  const listId = useId();
  const optId = (i: number) => `${listId}-o${i}`;

  const matches = useMemo(() => {
    const needle = foldName(q.trim());
    return DIAG_LOCATIONS.filter(
      (l) =>
        l.customer_id !== excludeId &&
        (!needle || foldName(`${l.customer_name} ${l.address}`).includes(needle)),
    );
  }, [q, excludeId]);

  const place = useCallback(() => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(Math.max(r.width, 260), 460);
    // Flip above the field when there is not room for the menu below it — the
    // panel often ends near the bottom of the window.
    const below = window.innerHeight - r.bottom;
    setPos(below < 240 && r.top > below
      ? { left: r.left, width, bottom: window.innerHeight - r.top + 2 }
      : { left: r.left, width, top: r.bottom + 2 });
  }, []);

  const openMenu = useCallback(() => { place(); setOpen(true); }, [place]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    document.addEventListener("mousedown", onDoc);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [open, place]);

  // Keep the highlighted option in view while arrowing through ~45 places.
  useEffect(() => {
    if (open) document.getElementById(optId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open]);

  const pick = (l: DiagLocation) => {
    onChange(l);
    setQ(""); setActive(0); setOpen(false);
  };

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { openMenu(); return; }
      setActive((i) => {
        const n = matches.length;
        return n === 0 ? 0 : (e.key === "ArrowDown" ? i + 1 : i - 1 + n) % n;
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && matches[active]) pick(matches[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-indigo-950">{value.customer_name}</div>
          <div className="truncate text-[11px] text-indigo-900" title={value.address}>{value.address}</div>
        </div>
        <button
          type="button"
          onClick={() => { onChange(null); requestAnimationFrame(() => inputRef.current?.focus()); }}
          aria-label={`Bỏ chọn ${value.customer_name}`}
          className="flex size-7 shrink-0 items-center justify-center rounded text-indigo-800 hover:bg-indigo-100 hover:text-indigo-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div ref={boxRef}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? optId(active) : undefined}
        aria-label="Điểm giao mới"
        placeholder="Chọn PSC mới — gõ mã (D003) hoặc địa chỉ"
        value={q}
        onChange={(e) => { setQ(e.target.value); setActive(0); openMenu(); }}
        onFocus={openMenu}
        onKeyDown={onKeyDown}
        className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm placeholder:text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      />
      {open && pos && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Danh sách PSC"
          style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, zIndex: 50 }}
          className="max-h-64 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg"
        >
          {matches.length === 0 && (
            <li className="px-3 py-1.5 text-xs text-slate-700">Không có PSC nào khớp</li>
          )}
          {matches.map((l, i) => (
            <li
              key={l.customer_id}
              id={optId(i)}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              // mousedown, not click: keeps focus in the field, so the menu is
              // not torn down by the blur before the pick lands.
              onMouseDown={(e) => { e.preventDefault(); pick(l); }}
              className={`cursor-pointer px-3 py-1.5 ${i === active ? "bg-indigo-50" : ""}`}
            >
              <div className="text-sm font-medium text-slate-900">{l.customer_name}</div>
              <div className="truncate text-[11px] text-slate-600">{l.address}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The "Điều chỉnh" chip on a Cần xử lý row: opens that job in the Điều chỉnh job panel
 * without retyping its eight-digit number. Styled like the row's Cartrack chip —
 * one more way to look at the same job, not a new kind of action.
 */
export function OpenInAdminButton({ jobId, onOpen }: { jobId: number; onOpen: (jobId: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(jobId)}
      aria-label={`Mở Job ${jobId} trong Điều chỉnh job`}
      className="shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
    >
      Điều chỉnh
    </button>
  );
}
