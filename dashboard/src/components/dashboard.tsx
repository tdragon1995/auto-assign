"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ServiceStatus } from "./stats-sidebar";
import { ActivityLog } from "./activity-log";
import { ScheduleListPanel } from "./schedule-list-panel";
import { SmartLogHistory } from "./smart-log-history";
import { NoteReviewPanel, type HeldJob } from "./note-review-panel";
import { JobAdminPanel } from "./job-admin-panel";
import { FailedJobsPanel, type ScheduleErrorRow } from "./failed-jobs-panel";
import { toast } from "sonner";
import type { LogEntry, PickupWarning, FailedJob, ConfigDriver } from "@/lib/types";

type Env = "prod" | "uat";
type RightTab = "live" | "failed" | "schedule" | "admin";
type LogMode = "live" | "smart";

export function Dashboard() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [armUntil, setArmUntil] = useState<number | null>(null);
  const [armedBy, setArmedBy] = useState<string>("");
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [held, setHeld] = useState<HeldJob[]>([]);
  const [warnings, setWarnings] = useState<PickupWarning[]>([]);
  const [failed, setFailed] = useState<FailedJob[]>([]);
  const [mappingCount, setMappingCount] = useState(0);
  const [pscRouteCount, setPscRouteCount] = useState(0);
  const [drivers, setDrivers] = useState<ConfigDriver[]>([]);
  const [env, setEnv] = useState<Env>("prod");
  const [rightTab, setRightTab] = useState<RightTab>("live");
  const [logMode, setLogMode] = useState<LogMode>("live");
  const [scheduleErrors, setScheduleErrors] = useState<ScheduleErrorRow[]>([]);
  const [retryingSchedule, setRetryingSchedule] = useState(false);

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
          const res = await fetch("/api/admin/assign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ job_id: job.job_id, driver_id: driverId, env }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
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

    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!id) id = setInterval(syncStatus, 90_000); };
    const stop = () => { if (id) { clearInterval(id); id = null; } };
    const onVisibility = () => {
      if (document.hidden) stop();
      else { syncStatus(); start(); }
    };

    syncStatus();
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [syncStatus, loadScheduleErrors]);

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
  }, [syncStatus, loadScheduleErrors]);

  const isProd = env === "prod";
  const attentionCount = failed.length + warnings.length + scheduleErrors.length;

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
          />
        </div>

        <div className="flex items-center gap-3 sm:gap-4 ml-auto">
          {/* Environment switch */}
          <div className="flex items-center gap-1.5">
            <span className={`text-xs sm:text-sm font-medium ${isProd ? "text-red-400" : "text-slate-400"}`}>PROD</span>
            <Switch checked={env === "uat"} onCheckedChange={handleEnvSwitch} />
            <span className={`text-xs sm:text-sm font-medium ${!isProd ? "text-amber-400" : "text-slate-400"}`}>UAT</span>
          </div>

          <div className="w-px h-6 bg-slate-600" />

          {/* Auto-Assign switch */}
          <div className="flex items-center gap-2">
            <span className="text-xs sm:text-sm text-slate-300">Auto-Assign</span>
            <Switch checked={isRunning} onCheckedChange={toggleService} />
          </div>

          <Button variant="outline" size="sm" className="text-slate-900" onClick={handleRefresh}>
            Refresh
          </Button>
        </div>
      </header>

      {/* Body — stacks on mobile, side-by-side from lg up */}
      <div className="flex flex-col lg:flex-row flex-1 lg:min-h-0 p-2 sm:p-3 gap-3">
        {/* Sidebar: only the note-review tasks live here now (delay + schedule
            moved into tabs). Rendered only when there's something to review, so a
            clean day gives the main panel the full width. */}
        {held.length > 0 && (
          <div className="flex flex-col gap-3 w-full lg:w-72 xl:w-80 shrink-0">
            <NoteReviewPanel
              held={held}
              env={env}
              onRefresh={syncStatus}
              onAssigned={(jobId) => {
                dismissedHeldRef.current.set(jobId, Date.now() + HELD_DISMISS_MS);
                setHeld((prev) => prev.filter((j) => j.job_id !== jobId));
                // After the background-write window, re-check the server so a failed
                // job (which the server puts back) reappears promptly.
                setTimeout(() => syncStatus(), HELD_DISMISS_MS + 500);
              }}
            />
          </div>
        )}

        {/* Right: tabbed panel. Fixed height on mobile so the inner ScrollArea
            works; fills the column on desktop. */}
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          {/* Tab bar */}
          <div className="flex items-center gap-1 shrink-0 overflow-x-auto">
            <button onClick={() => setRightTab("live")} className={tabBtn(rightTab === "live")}>
              Live Log
            </button>
            <button onClick={() => setRightTab("failed")} className={tabBtn(rightTab === "failed")}>
              Cần xử lý
              {attentionCount > 0 && (
                <span className="rounded-full bg-red-600 text-white px-1.5 leading-none py-0.5 text-[10px] font-bold">
                  {attentionCount}
                </span>
              )}
            </button>
            <button onClick={() => setRightTab("schedule")} className={tabBtn(rightTab === "schedule")}>
              Lịch cố định
            </button>
            <button onClick={() => setRightTab("admin")} className={tabBtn(rightTab === "admin")}>
              Quản trị job
            </button>
          </div>

          {/* Tab content */}
          <div className="flex-1 min-h-0 h-[65vh] lg:h-auto">
            {rightTab === "live" ? (
              <div className="flex flex-col h-full gap-1.5">
                {/* Smart History is now a mode inside Live Log, not a top tab */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => setLogMode("live")}
                    className={`px-2 py-0.5 text-[11px] font-semibold rounded-full transition-colors ${
                      logMode === "live" ? "bg-slate-200 text-slate-800" : "text-slate-400 hover:text-slate-700"
                    }`}
                  >
                    Hoạt động
                  </button>
                  <button
                    onClick={() => setLogMode("smart")}
                    className={`px-2 py-0.5 text-[11px] font-semibold rounded-full transition-colors ${
                      logMode === "smart" ? "bg-slate-200 text-slate-800" : "text-slate-400 hover:text-slate-700"
                    }`}
                  >
                    Smart History
                  </button>
                </div>
                <div className="flex-1 min-h-0">
                  {logMode === "live" ? <ActivityLog logs={logs} /> : <SmartLogHistory />}
                </div>
              </div>
            ) : rightTab === "failed" ? (
              <FailedJobsPanel
                failed={failed}
                warnings={warnings}
                scheduleErrors={scheduleErrors}
                drivers={drivers}
                onAssign={handleManualAssign}
                onRetrySchedule={retrySchedule}
                retryingSchedule={retryingSchedule}
              />
            ) : rightTab === "schedule" ? (
              <ScheduleListPanel env={env} />
            ) : (
              <JobAdminPanel env={env} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
