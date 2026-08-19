"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ServiceStatus } from "./stats-sidebar";
import { ActivityLog } from "./activity-log";
import { ScheduleListPanel } from "./schedule-list-panel";
import { type HeldJob } from "./note-review-panel";
import { JobAdminPanel } from "./job-admin-panel";
import { DistanceTab } from "./distance-tab";
import { FailedJobsPanel, type ScheduleErrorRow } from "./failed-jobs-panel";
import { LeaveStatusPanel } from "./leave-status-panel";
import { toast } from "sonner";
import type { LogEntry, PickupWarning, FailedJob, ConfigDriver } from "@/lib/types";
import type { DeploymentBeat } from "@/lib/smart-log-kv";
import type { LeaveOnDate } from "@/lib/leave-config";

type Env = "prod" | "uat";
type RightTab = "attention" | "live" | "admin" | "schedule" | "distance";

export function Dashboard() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [armUntil, setArmUntil] = useState<number | null>(null);
  const [armedBy, setArmedBy] = useState<string>("");
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [deployments, setDeployments] = useState<DeploymentBeat[]>([]);
  const [held, setHeld] = useState<HeldJob[]>([]);
  const [warnings, setWarnings] = useState<PickupWarning[]>([]);
  const [failed, setFailed] = useState<FailedJob[]>([]);
  const [mappingCount, setMappingCount] = useState(0);
  const [pscRouteCount, setPscRouteCount] = useState(0);
  const [drivers, setDrivers] = useState<ConfigDriver[]>([]);
  const [env, setEnv] = useState<Env>("prod");
  const [rightTab, setRightTab] = useState<RightTab>("attention");
  const [scheduleErrors, setScheduleErrors] = useState<ScheduleErrorRow[]>([]);
  const [retryingSchedule, setRetryingSchedule] = useState(false);
  const [leave, setLeave] = useState<{ today: LeaveOnDate[]; tomorrow: LeaveOnDate[]; error: boolean }>({
    today: [],
    tomorrow: [],
    error: false,
  });

  // Single source of truth: one KV read returns switch state, live log, held
  // jobs, and pickup warnings — all updated by the cron cycle, zero extra calls.
  // After the first full fetch, polls send ?since=<newest ts we have> and merge
  // the few new entries instead of re-downloading the same 100 every 90s. The
  // boundary second is requested inclusively, so dedupe by ts|level|msg.
  const lastLogTsRef = useRef<string | null>(null);
  // Jobs just approved/scheduled via the panel, mapped to a dismissal expiry. We
  // hide them only during the background-write window (~15s) — covering the
  // immediate refresh and any cron cycle that re-writes the pre-mark job. After
  // it expires we reconcile with the server, so a job whose background work FAILED
  // (server puts it back, with an error) reappears instead of staying hidden.
  const HELD_DISMISS_MS = 30_000;
  const dismissedHeldRef = useRef<Map<number, number>>(new Map());
  // Same optimistic-hide trick for manually-assigned failed jobs ("Gán thủ công"):
  // hide on click, don't wait on the Cartrack assign. The failed snapshot is only
  // rewritten each assign cycle (~3 min), so the window must outlast one cycle or a
  // successful assign would flicker back from the stale snapshot. On error we
  // re-emerge the row immediately (handleManualAssign), independent of this window.
  const FAILED_DISMISS_MS = 4 * 60_000;
  const dismissedFailedRef = useRef<Map<number, number>>(new Map());

  // Mirrors REDIS_TTL_S in lib/leave-config: below this the leave endpoint answers from
  // its own Redis copy, so an automatic reload cannot return anything new. Raising it
  // there means raising it here.
  const LEAVE_CACHE_MS = 5 * 60_000;
  const lastLeaveAtRef = useRef(0);
  const lastLeaveDayRef = useRef("");
  const syncStatus = useCallback(async () => {
    try {
      const since = lastLogTsRef.current;
      const qs = since ? `?since=${encodeURIComponent(since)}` : "";
      const res = await fetch(`/api/assign/status${qs}`);
      const data = await res.json();
      setIsRunning(!!data.armed);
      setArmUntil(data.state?.armedUntil ?? null);
      setArmedBy(data.state?.armedBy ?? "");
      setLastChecked(data.lastChecked ?? null);
      setDeployments(Array.isArray(data.deployments) ? data.deployments : []);
      if (Array.isArray(data.logs)) {
        const incoming = data.logs as LogEntry[];
        if (!since) {
          setLogs(incoming);
          if (incoming.length) lastLogTsRef.current = incoming[incoming.length - 1].ts;
        } else if (incoming.length) {
          setLogs((prev) => {
            const seen = new Set(
              prev.filter((l) => l.ts >= since).map((l) => `${l.ts}|${l.level}|${l.msg}`)
            );
            const fresh = incoming.filter((l) => !seen.has(`${l.ts}|${l.level}|${l.msg}`));
            if (fresh.length === 0) return prev;
            const merged = [...prev, ...fresh].slice(-300);
            lastLogTsRef.current = merged[merged.length - 1].ts;
            return merged;
          });
        }
      }
      if (Array.isArray(data.held)) {
        const dismissed = dismissedHeldRef.current;
        const now = Date.now();
        for (const [id, exp] of dismissed) if (exp <= now) dismissed.delete(id);
        setHeld((data.held as HeldJob[]).filter((j) => !dismissed.has(j.job_id)));
      }
      if (Array.isArray(data.warnings)) setWarnings(data.warnings);
      if (Array.isArray(data.failed)) {
        const dismissed = dismissedFailedRef.current;
        const now = Date.now();
        for (const [id, exp] of dismissed) if (exp <= now) dismissed.delete(id);
        setFailed((data.failed as FailedJob[]).filter((j) => !dismissed.has(j.job_id)));
      }
    } catch {
      /* transient network error — keep last known state */
    }
  }, []);

  // Fixed-schedule run errors → surfaced in the Cần xử lý tab. The schedule runs
  // once a day, so this only needs loading on mount + manual refresh (not polled).
  const loadScheduleErrors = useCallback(async () => {
    try {
      const res = await fetch("/api/schedule-job/log", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const errs = (data.record?.results ?? []).filter(
        (r: { status?: string }) => r.status === "ERROR",
      ) as ScheduleErrorRow[];
      setScheduleErrors(errs);
    } catch {
      /* leave last known */
    }
  }, []);

  // Leave status (today + tomorrow) for the Cần xử lý tab. Backed by a 5-min
  // sheet cache server-side, so loading on mount + manual refresh is enough —
  // no need to poll it on the 90s status cadence.
  // `fresh` (used by Refresh) busts the server-side 5-min sheet cache so a
  // supervisor's edit shows at once. On failure we flag an error but keep the
  // last-known lists — the panel shows an error line only when it has nothing,
  // so a transient blip never renders as a false "nobody's on leave".
  const loadLeaveStatus = useCallback(async (fresh = false) => {
    // Skip an automatic reload the server could only answer from cache. This fires on
    // every visibility resume, and loadLeaveEntries holds a 5-minute Redis copy — so
    // inside that window the response is identical by construction, and 255 calls in 12h
    // bought 30s of CPU re-parsing an unchanged value. Two things still always go through:
    // `fresh` (the Refresh button, which busts the server cache), and a change of VN date,
    // so a tab left open past midnight still drops yesterday's roster from "Hôm nay".
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()).slice(0, 10);
    if (!fresh && today === lastLeaveDayRef.current && Date.now() - lastLeaveAtRef.current < LEAVE_CACHE_MS) return;
    lastLeaveAtRef.current = Date.now();
    lastLeaveDayRef.current = today;
    try {
      const res = await fetch(`/api/leave-status${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      if (!res.ok) {
        setLeave((prev) => ({ ...prev, error: true }));
        return;
      }
      const data = await res.json();
      setLeave({
        today: Array.isArray(data.today) ? data.today : [],
        tomorrow: Array.isArray(data.tomorrow) ? data.tomorrow : [],
        error: false,
      });
    } catch {
      setLeave((prev) => ({ ...prev, error: true }));
    }
  }, []);

  // The one Cartrack assign call behind every "Gán thủ công" picker. Throws with
  // the server's message so each caller can put its own row back.
  const postManualAssign = useCallback(
    async (jobId: number, driverId: string) => {
      const res = await fetch("/api/admin/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId, driver_id: driverId, env }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    },
    [env],
  );

  // Manual assign from the Cần xử lý panel. Like "Giao ngay": hide the row at
  // once and fire the Cartrack assign in the background — don't make the user wait
  // on the round trip. If the assign errors, re-emerge the exact same row
  // immediately (drop the dismissal + re-add the job object) and toast why.
  const handleManualAssign = useCallback(
    (job: FailedJob, driverId: string) => {
      dismissedFailedRef.current.set(job.job_id, Date.now() + FAILED_DISMISS_MS);
      setFailed((prev) => prev.filter((j) => j.job_id !== job.job_id));

      (async () => {
        try {
          await postManualAssign(job.job_id, driverId);
          toast.success(`Đã gán Job ${job.job_id}`);
          // Reconcile after the cycle that clears the snapshot, so a success stays gone.
          setTimeout(() => syncStatus(), FAILED_DISMISS_MS + 500);
        } catch (err) {
          dismissedFailedRef.current.delete(job.job_id);
          setFailed((prev) =>
            prev.some((j) => j.job_id === job.job_id) ? prev : [...prev, job],
          );
          toast.error(`Gán Job ${job.job_id} thất bại: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    },
    [postManualAssign, syncStatus],
  );

  // Same picker, same contract, for a job held on its note: name the driver and
  // assign now, instead of handing the job back to the engine ("Giao ngay") or
  // parking it ("Hẹn giờ"). The dismissal uses the 4-minute window, NOT
  // HELD_DISMISS_MS — an approval mark is visible to the server within seconds,
  // but a direct assign only leaves the held snapshot when the next cycle
  // rebuilds it (~3 min), so a shorter hide would flicker the row back.
  const handleHeldManualAssign = useCallback(
    (job: HeldJob, driverId: string) => {
      dismissedHeldRef.current.set(job.job_id, Date.now() + FAILED_DISMISS_MS);
      setHeld((prev) => prev.filter((j) => j.job_id !== job.job_id));

      (async () => {
        try {
          await postManualAssign(job.job_id, driverId);
          toast.success(`Đã gán Job ${job.job_id}`);
          setTimeout(() => syncStatus(), FAILED_DISMISS_MS + 500);
        } catch (err) {
          dismissedHeldRef.current.delete(job.job_id);
          setHeld((prev) =>
            prev.some((j) => j.job_id === job.job_id) ? prev : [...prev, job],
          );
          toast.error(`Gán Job ${job.job_id} thất bại: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    },
    [postManualAssign, syncStatus],
  );

  // "Hẹn giờ" on an unconfigured-customer row. Same endpoint and same parking
  // machinery as the note-held scheduler: /api/assign/held validates, answers at
  // once, and does the slow Cartrack writes in the background. Optimistically
  // hide for FAILED_DISMISS_MS — the row only really leaves the snapshot once the
  // next cycle rebuilds it, and a parked job is no longer unassigned so it will
  // not come back. On a rejected request, re-emerge the exact row and say why.
  const handleScheduleFailed = useCallback(
    (job: FailedJob, scheduledAt: string, label: string) => {
      dismissedFailedRef.current.set(job.job_id, Date.now() + FAILED_DISMISS_MS);
      setFailed((prev) => prev.filter((j) => j.job_id !== job.job_id));

      (async () => {
        try {
          const res = await fetch(`/api/assign/held?env=${env}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jobId: job.job_id, scheduledAt }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
          toast.success(`Đang lên lịch Job ${job.job_id} — ${label}…`);
          setTimeout(() => syncStatus(), FAILED_DISMISS_MS + 500);
        } catch (err) {
          dismissedFailedRef.current.delete(job.job_id);
          setFailed((prev) =>
            prev.some((j) => j.job_id === job.job_id) ? prev : [...prev, job],
          );
          toast.error(
            `Không lên lịch được Job ${job.job_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    },
    [env, syncStatus],
  );

  const retrySchedule = useCallback(async () => {
    setRetryingSchedule(true);
    try {
      const res = await fetch(`/api/schedule-job?mode=retry&env=${env}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) toast.error(`Lịch cố định: ${data.error ?? `HTTP ${res.status}`}`);
      else if (data.counts) {
        const { ok, error } = data.counts;
        toast.success(`Lịch cố định: ${ok} tạo / ${error} lỗi còn lại`);
      }
      await loadScheduleErrors();
    } catch (e) {
      toast.error(`Lịch cố định lỗi: ${String(e)}`);
    } finally {
      setRetryingSchedule(false);
    }
  }, [env, loadScheduleErrors]);

  // Load config once, then poll status every 30s — but only while the tab is
  // visible. A backgrounded tab pauses (and resumes + refreshes on return), so
  // it stops firing pointless invocations when nobody's looking.
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => {
        setMappingCount(d.mappingCount ?? 0);
        setPscRouteCount(d.pscRouteCount ?? 0);
        setDrivers(d.drivers ?? []);
      })
      .catch(() => {});
    loadScheduleErrors();
    loadLeaveStatus();

    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!id) id = setInterval(syncStatus, 90_000); };
    const stop = () => { if (id) { clearInterval(id); id = null; } };
    const onVisibility = () => {
      if (document.hidden) stop();
      // Refetch leave on resume too: a tab left open past midnight would
      // otherwise keep yesterday's roster under the "Hôm nay" header.
      else { syncStatus(); loadLeaveStatus(); start(); }
    };

    syncStatus();
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [syncStatus, loadScheduleErrors, loadLeaveStatus]);

  // Turn the switch ON — arm the server-side engine until the next 22:00 VN.
  const arm = useCallback(async () => {
    let by = "";
    if (typeof window !== "undefined") {
      by = localStorage.getItem("dashboard:admin_name") ?? "";
      if (!by) {
        by = (window.prompt("Tên người bật (để ghi nhận):") ?? "").trim();
        if (by) localStorage.setItem("dashboard:admin_name", by);
      }
    }
    try {
      const res = await fetch("/api/assign/arm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env, by }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.armed) {
        toast.error(data.error ?? "Không thể bật tự động");
        return;
      }
      setIsRunning(true);
      setArmUntil(data.state?.armedUntil ?? null);
      setArmedBy(data.state?.armedBy ?? by);
      toast.success("Đã bật — System tự động chạy đến 22:00");
    } catch {
      toast.error("Không thể bật tự động");
    }
  }, [env]);

  // Turn the switch OFF immediately. `reason` is set for auto-disarm (env/mode
  // switch); a manual off leaves it empty. Both record who, for the alert email.
  const disarm = useCallback(async (reason?: string) => {
    try {
      const by =
        typeof window !== "undefined"
          ? localStorage.getItem("dashboard:admin_name") ?? ""
          : "";
      const qs = new URLSearchParams();
      if (by) qs.set("by", by);
      if (reason) qs.set("reason", reason);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      await fetch(`/api/assign/arm${suffix}`, { method: "DELETE" });
    } catch {
      /* best effort — next poll reflects true state */
    }
    setIsRunning(false);
    setArmUntil(null);
    setArmedBy("");
    toast.info("Đã tắt tự động");
  }, []);

  const toggleService = useCallback((next: boolean) => {
    if (next) arm(); else disarm();
  }, [arm, disarm]);

  // Switch environment — disarm first so a stale env can't keep assigning.
  const handleEnvSwitch = useCallback((checked: boolean) => {
    const newEnv: Env = checked ? "uat" : "prod";
    setEnv(newEnv);
    if (isRunning) {
      disarm("đổi môi trường");
      toast.info("Tự động đã tắt do đổi môi trường");
    }
    toast.info(`Switched to ${newEnv.toUpperCase()}`);
  }, [isRunning, disarm]);

  // Refresh handler with toast
  const handleRefresh = useCallback(async () => {
    syncStatus();
    loadScheduleErrors();
    loadLeaveStatus(true);
    try {
      const configRes = await fetch("/api/config");
      if (!configRes.ok) throw new Error(`Config returned ${configRes.status}`);
      const configData = await configRes.json();
      if (configData.status === "error") throw new Error(configData.error);
      setMappingCount(configData.mappingCount ?? 0);
      setPscRouteCount(configData.pscRouteCount ?? 0);
      setDrivers(configData.drivers ?? []);
      toast.success(`Google Sheet reloaded: ${configData.mappingCount} mapping(s), ${configData.pscRouteCount} PSC route(s) fetched`);
    } catch (err) {
      toast.error(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Shift/leave sync from MISA. It can't run in this app — the login needs a
    // real browser — so this only dispatches the GitHub Actions run that does,
    // and the sheet updates a couple of minutes later. Reported separately from
    // the cache reload above because it completes long after this click.
    try {
      const res = await fetch("/api/misa-sync", { method: "POST" });
      const data = await res.json();
      if (data.status === "dispatched") {
        toast.success("Đang đồng bộ ca làm việc từ MISA — bảng cập nhật sau ~2 phút");
      } else if (data.status === "already_running") {
        toast.success("Đồng bộ MISA đang chạy…");
      } else if (data.status === "error") {
        toast.error(`Đồng bộ MISA thất bại: ${data.error}`);
      }
      // status "disabled" (no GitHub token configured) stays silent.
    } catch (err) {
      toast.error(`Đồng bộ MISA thất bại: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [syncStatus, loadScheduleErrors, loadLeaveStatus]);

  const isProd = env === "prod";
  const attentionCount = held.length + failed.length + warnings.length + scheduleErrors.length;

  const tabBtn = (active: boolean) =>
    `px-3 py-1.5 text-xs font-semibold rounded transition-colors border flex items-center gap-1.5 whitespace-nowrap ${
      active
        ? "bg-slate-800 text-white border-slate-700"
        : "text-slate-500 border-transparent hover:text-slate-800"
    }`;

  return (
    <div className="flex flex-col min-h-screen lg:h-screen">

      {/* Header — wraps to multiple rows on narrow screens */}
      <header className="bg-slate-900 text-white px-3 sm:px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="text-base sm:text-lg font-semibold truncate">Fleet Auto-Assign</h1>
          {/* Minimal Service: just the heartbeat */}
          <ServiceStatus
            mappingCount={mappingCount}
            pscRouteCount={pscRouteCount}
            lastChecked={lastChecked}
            deployments={deployments}
          />
        </div>

        <div className="flex items-center gap-3 sm:gap-4 ml-auto">
          {/* Environment — segmented control so the active env is unmistakable */}
          <div className="flex items-center rounded-md border border-slate-600 p-0.5 text-xs sm:text-sm font-semibold">
            <button
              type="button"
              onClick={() => { if (!isProd) handleEnvSwitch(false); }}
              className={`rounded px-2 py-0.5 transition-colors ${isProd ? "bg-red-500 text-white" : "text-slate-400 hover:text-slate-200"}`}
            >
              PROD
            </button>
            <button
              type="button"
              onClick={() => { if (isProd) handleEnvSwitch(true); }}
              className={`rounded px-2 py-0.5 transition-colors ${!isProd ? "bg-amber-500 text-white" : "text-slate-400 hover:text-slate-200"}`}
            >
              UAT
            </button>
          </div>

          <div className="w-px h-6 bg-slate-600" />

          {/* Auto-Assign switch */}
          <div className="flex items-center gap-2">
            <span className="text-xs sm:text-sm text-slate-300">Tự động</span>
            <Switch checked={isRunning} onCheckedChange={toggleService} />
          </div>

          <Button variant="outline" size="sm" className="text-slate-900" onClick={handleRefresh}>
            Làm mới
          </Button>
        </div>
      </header>

      {/* Body — single full-width column now (the sidebar is gone; Cần xử lý is
          the landing tab, Live Log is just the log). */}
      <div className="flex flex-col lg:flex-1 lg:min-h-0 p-2 sm:p-3">
        <div className="min-w-0 flex flex-col gap-1.5 lg:flex-1 lg:min-h-0">
          {/* Tab bar */}
          <div className="flex items-center gap-1 shrink-0 overflow-x-auto">
            <button onClick={() => setRightTab("attention")} className={tabBtn(rightTab === "attention")}>
              <AlertTriangle className="size-3.5" strokeWidth={2} />
              Cần xử lý
              {attentionCount > 0 && (
                <span className="rounded-full bg-red-600 text-white px-1.5 leading-none py-0.5 text-[11px] font-bold">
                  {attentionCount}
                </span>
              )}
            </button>
            <button onClick={() => setRightTab("live")} className={tabBtn(rightTab === "live")}>
              Nhật ký
            </button>
            <button onClick={() => setRightTab("admin")} className={tabBtn(rightTab === "admin")}>
              Quản trị công việc
            </button>
            <button onClick={() => setRightTab("schedule")} className={tabBtn(rightTab === "schedule")}>
              Lịch cố định
            </button>
            <button onClick={() => setRightTab("distance")} className={tabBtn(rightTab === "distance")}>
              Khoảng cách
            </button>
          </div>

          {/* Tab content. On mobile the page flows + scrolls (definite heights so
              each panel's ScrollArea renders); on lg it's a fixed flex-fill. */}
          <div className="lg:flex-1 lg:min-h-0">
            {rightTab === "attention" ? (
              <div className="flex flex-col gap-1.5 h-[72vh] lg:h-full">
                {/* Cần xử lý tab — note tasks + unassignable + late + schedule errors */}
                <div className="flex-1 min-h-0">
                  <FailedJobsPanel
                    held={held}
                    env={env}
                    onNoteRefresh={syncStatus}
                    onNoteAssigned={(jobId) => {
                      dismissedHeldRef.current.set(jobId, Date.now() + HELD_DISMISS_MS);
                      setHeld((prev) => prev.filter((j) => j.job_id !== jobId));
                      // After the background-write window, re-check the server so a
                      // failed job (which the server puts back) reappears promptly.
                      setTimeout(() => syncStatus(), HELD_DISMISS_MS + 500);
                    }}
                    onNoteManualAssign={handleHeldManualAssign}
                    failed={failed}
                    warnings={warnings}
                    scheduleErrors={scheduleErrors}
                    drivers={drivers}
                    onAssign={handleManualAssign}
                    onScheduleFailed={handleScheduleFailed}
                    onRetrySchedule={retrySchedule}
                    retryingSchedule={retryingSchedule}
                  />
                </div>

                {/* Leave status — reference, below the actionable list; collapsed
                    to counts by default but flags uncovered drivers in amber. */}
                <LeaveStatusPanel
                  today={leave.today}
                  tomorrow={leave.tomorrow}
                  error={leave.error}
                  drivers={drivers}
                  onRefresh={() => loadLeaveStatus()}
                />
              </div>
            ) : rightTab === "live" ? (
              <div className="h-[72vh] lg:h-full">
                <ActivityLog logs={logs} />
              </div>
            ) : rightTab === "schedule" ? (
              <div className="h-[72vh] lg:h-full">
                <ScheduleListPanel env={env} />
              </div>
            ) : rightTab === "admin" ? (
              <div className="h-[72vh] lg:h-full">
                <JobAdminPanel env={env} />
              </div>
            ) : (
              <div className="h-[72vh] lg:h-full">
                <DistanceTab env={env} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
