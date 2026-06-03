"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { StatsSidebar } from "./stats-sidebar";
import { ActivityLog } from "./activity-log";
import { ScheduleJobPanel } from "./schedule-job-panel";
import { SmartLogHistory } from "./smart-log-history";
import { NoteReviewPanel, type HeldJob } from "./note-review-panel";
import { JobAdminPanel } from "./job-admin-panel";
import { PickupWarningPanel } from "./pickup-warning-panel";
import { toast } from "sonner";
import type { LogEntry, PickupWarning } from "@/lib/types";

type Env = "prod" | "uat";
type AssignMode = "smart" | "autoplan";
type RightTab = "live" | "history" | "admin";

export function Dashboard() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [armUntil, setArmUntil] = useState<number | null>(null);
  const [armedBy, setArmedBy] = useState<string>("");
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [held, setHeld] = useState<HeldJob[]>([]);
  const [warnings, setWarnings] = useState<PickupWarning[]>([]);
  const [mappingCount, setMappingCount] = useState(0);
  const [pscRouteCount, setPscRouteCount] = useState(0);
  const [env, setEnv] = useState<Env>("prod");
  const [assignMode, setAssignMode] = useState<AssignMode>("smart");
  const [rightTab, setRightTab] = useState<RightTab>("live");

  // Single source of truth: one KV read returns switch state, live log, held
  // jobs, and pickup warnings — all updated by the cron cycle, zero extra calls.
  const syncStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/assign/status");
      const data = await res.json();
      setIsRunning(!!data.armed);
      setArmUntil(data.state?.armedUntil ?? null);
      setArmedBy(data.state?.armedBy ?? "");
      setLastChecked(data.lastChecked ?? null);
      if (Array.isArray(data.logs)) setLogs(data.logs);
      if (Array.isArray(data.held)) setHeld(data.held);
      if (Array.isArray(data.warnings)) setWarnings(data.warnings);
    } catch {
      /* transient network error — keep last known state */
    }
  }, []);

  // Load config once, then poll status every 30s — but only while the tab is
  // visible. A backgrounded tab pauses (and resumes + refreshes on return), so
  // it stops firing pointless invocations when nobody's looking.
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => {
        setMappingCount(d.mappingCount ?? 0);
        setPscRouteCount(d.pscRouteCount ?? 0);
      })
      .catch(() => {});

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
  }, [syncStatus]);

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
        body: JSON.stringify({ env, mode: assignMode, by }),
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
  }, [env, assignMode]);

  // Turn the switch OFF immediately.
  const disarm = useCallback(async () => {
    try {
      await fetch("/api/assign/arm", { method: "DELETE" });
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
      disarm();
      toast.info("Tự động đã tắt do đổi môi trường");
    }
    toast.info(`Switched to ${newEnv.toUpperCase()}`);
  }, [isRunning, disarm]);

  // Switch assign mode — disarm first so a stale mode can't keep assigning.
  const handleModeSwitch = useCallback((mode: AssignMode) => {
    if (mode === assignMode) return;
    setAssignMode(mode);
    if (isRunning) {
      disarm();
      toast.info("Tự động đã tắt do đổi chế độ");
    }
    toast.info(`Switched to ${mode === "autoplan" ? "Auto-Plan" : "Smart-Assign"}`);
  }, [assignMode, isRunning, disarm]);

  // Refresh handler with toast
  const handleRefresh = useCallback(async () => {
    syncStatus();
    try {
      const configRes = await fetch("/api/config");
      if (!configRes.ok) throw new Error(`Config returned ${configRes.status}`);
      const configData = await configRes.json();
      if (configData.status === "error") throw new Error(configData.error);
      setMappingCount(configData.mappingCount ?? 0);
      setPscRouteCount(configData.pscRouteCount ?? 0);
      toast.success(`Google Sheet reloaded: ${configData.mappingCount} mapping(s), ${configData.pscRouteCount} PSC route(s) fetched`);
    } catch (err) {
      toast.error(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [syncStatus]);

  const isProd = env === "prod";

  return (
    <div className="flex flex-col h-screen">
      {/* Environment banner */}
      <div
        className={`px-4 py-1.5 text-center text-sm font-semibold tracking-wide shrink-0 ${
          isProd
            ? "bg-red-600 text-white"
            : "bg-amber-400 text-amber-950"
        }`}
      >
        {isProd ? "PRODUCTION" : "UAT"}
      </div>

      {/* Armed-status banner */}
      {isRunning && (
        <div className="bg-emerald-500 text-emerald-950 px-4 py-1.5 text-center text-sm font-medium shrink-0">
          🟢 Tự động đang BẬT — tự tắt lúc{" "}
          {armUntil
            ? new Date(armUntil).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" })
            : "22:00"}
          {armedBy ? ` · bật bởi ${armedBy}` : ""}
        </div>
      )}

      {/* Header */}
      <header className="bg-slate-900 text-white px-4 py-3 flex items-center justify-between shrink-0">
        <h1 className="text-lg font-semibold">Fleet Auto-Assign Dashboard</h1>
        <div className="flex items-center gap-4">
          {/* Environment switch */}
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${isProd ? "text-red-400" : "text-slate-400"}`}>PROD</span>
            <Switch
              checked={env === "uat"}
              onCheckedChange={handleEnvSwitch}
            />
            <span className={`text-sm font-medium ${!isProd ? "text-amber-400" : "text-slate-400"}`}>UAT</span>
          </div>

          <div className="w-px h-6 bg-slate-600" />

          {/* Mode toggle */}
          <div className="flex items-center rounded-lg overflow-hidden border border-slate-600 text-xs font-semibold">
            <button
              onClick={() => handleModeSwitch("smart")}
              className={`px-2.5 py-1 transition-colors ${assignMode === "smart" ? "bg-blue-600 text-white" : "text-slate-400 hover:text-white"}`}
            >
              Smart
            </button>
            <button
              onClick={() => handleModeSwitch("autoplan")}
              className={`px-2.5 py-1 transition-colors border-l border-slate-600 ${assignMode === "autoplan" ? "bg-violet-600 text-white" : "text-slate-400 hover:text-white"}`}
            >
              Auto-Plan
            </button>
          </div>

          <div className="w-px h-6 bg-slate-600" />

          {/* Auto-Assign switch */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-300">Auto-Assign</span>
            <Switch checked={isRunning} onCheckedChange={toggleService} />
          </div>

          <Button
            variant="outline"
            size="sm"
            className="text-slate-900"
            onClick={handleRefresh}
          >
            Refresh
          </Button>
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 min-h-0 p-3 gap-3">
        {/* Left sidebar */}
        <div className="flex flex-col gap-3 w-64 shrink-0">
          <StatsSidebar
            isRunning={isRunning}
            mappingCount={mappingCount}
            pscRouteCount={pscRouteCount}
            lastChecked={lastChecked}
          />
          <PickupWarningPanel warnings={warnings} />
          <NoteReviewPanel held={held} env={env} onRefresh={syncStatus} />
          <ScheduleJobPanel env={env} />
        </div>

        {/* Right: tabbed log panel */}
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          {/* Tab bar */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setRightTab("live")}
              className={`px-3 py-1 text-xs font-semibold rounded transition-colors border ${
                rightTab === "live"
                  ? "bg-slate-800 text-white border-slate-700"
                  : "text-slate-400 border-transparent hover:text-white"
              }`}
            >
              Live Log
            </button>
            <button
              onClick={() => setRightTab("history")}
              className={`px-3 py-1 text-xs font-semibold rounded transition-colors border ${
                rightTab === "history"
                  ? "bg-slate-800 text-white border-slate-700"
                  : "text-slate-400 border-transparent hover:text-white"
              }`}
            >
              Smart History
            </button>
            <button
              onClick={() => setRightTab("admin")}
              className={`px-3 py-1 text-xs font-semibold rounded transition-colors border ${
                rightTab === "admin"
                  ? "bg-slate-800 text-white border-slate-700"
                  : "text-slate-400 border-transparent hover:text-white"
              }`}
            >
              Quản trị job
            </button>
          </div>

          {/* Tab content */}
          <div className="flex-1 min-h-0">
            {rightTab === "live" ? (
              <ActivityLog logs={logs} />
            ) : rightTab === "history" ? (
              <SmartLogHistory />
            ) : (
              <JobAdminPanel env={env} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
