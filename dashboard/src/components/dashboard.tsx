"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { StatsSidebar } from "./stats-sidebar";
import { ActivityLog } from "./activity-log";
import { toast } from "sonner";
import type { LogEntry, QueuedJob } from "@/lib/types";

type Env = "prod" | "uat";
type AssignMode = "smart" | "autoplan";

export function Dashboard() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [queued, setQueued] = useState<QueuedJob[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [mappingCount, setMappingCount] = useState(0);
  const [pscRouteCount, setPscRouteCount] = useState(0);
  const [env, setEnv] = useState<Env>("prod");
  const [assignMode, setAssignMode] = useState<AssignMode>("smart");
  const assignIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cycleInProgressRef = useRef(false);

  // Fetch config on mount
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => {
        setMappingCount(d.mappingCount ?? 0);
        setPscRouteCount(d.pscRouteCount ?? 0);
      })
      .catch(() => {});
  }, []);

  // Auto-assign cycle
  // Smart mode: /api/assign handles all jobs (smart + fixed).
  // Auto-plan mode: /api/autoplan handles smart jobs via Cartrack planner + fixed jobs.
  const runAssignCycle = useCallback(async (targetEnv?: Env, targetMode?: AssignMode) => {
    if (cycleInProgressRef.current) return;
    cycleInProgressRef.current = true;
    const e = targetEnv ?? env;
    const m = targetMode ?? assignMode;
    const endpoints = m === "autoplan"
      ? [`/api/autoplan?env=${e}`]
      : [`/api/assign?env=${e}`];
    try {
      const responses = await Promise.all(endpoints.map((u) => fetch(u, { method: "POST" })));
      const allLogs: LogEntry[] = [];
      let latestQueued: QueuedJob[] | null = null;
      for (const res of responses) {
        if (!res.ok) continue;
        const data = await res.json();
        if (data.logs?.length) allLogs.push(...data.logs);
        if (Array.isArray(data.queued)) latestQueued = data.queued;
      }
      if (allLogs.length) setLogs((prev) => [...prev, ...allLogs]);
      if (latestQueued !== null) setQueued(latestQueued);
    } catch {
      setLogs((prev) => [
        ...prev,
        {
          ts: new Date().toISOString().replace("T", " ").slice(0, 19),
          level: "ERROR" as const,
          msg: "Failed to reach assign endpoint",
        },
      ]);
    } finally {
      cycleInProgressRef.current = false;
    }
  }, [env, assignMode]);

  // Toggle auto-assign
  const toggleService = useCallback(() => {
    setIsRunning((prev) => {
      const next = !prev;
      if (next) {
        // Start: run immediately then every 30s
        runAssignCycle();
        assignIntervalRef.current = setInterval(runAssignCycle, 30_000);
      } else {
        if (assignIntervalRef.current) {
          clearInterval(assignIntervalRef.current);
          assignIntervalRef.current = null;
        }
      }
      return next;
    });
  }, [runAssignCycle]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (assignIntervalRef.current) clearInterval(assignIntervalRef.current);
    };
  }, []);

  // Switch environment
  const handleEnvSwitch = useCallback((checked: boolean) => {
    const newEnv: Env = checked ? "uat" : "prod";
    setEnv(newEnv);
    if (isRunning) {
      setIsRunning(false);
      if (assignIntervalRef.current) {
        clearInterval(assignIntervalRef.current);
        assignIntervalRef.current = null;
      }
      toast.info(`Auto-assign stopped due to environment switch`);
    }
    setLogs([]);
    toast.info(`Switched to ${newEnv.toUpperCase()}`);
  }, [isRunning]);

  // Switch assign mode
  const handleModeSwitch = useCallback((mode: AssignMode) => {
    if (mode === assignMode) return;
    setAssignMode(mode);
    if (isRunning) {
      setIsRunning(false);
      if (assignIntervalRef.current) {
        clearInterval(assignIntervalRef.current);
        assignIntervalRef.current = null;
      }
      toast.info(`Auto-assign stopped due to mode switch`);
    }
    setLogs([]);
    toast.info(`Switched to ${mode === "autoplan" ? "Auto-Plan" : "Smart-Assign"}`);
  }, [assignMode, isRunning]);

  // Refresh handler with toast
  const handleRefresh = useCallback(async () => {
    try {
      const configRes = await fetch("/api/config");
      if (!configRes.ok) throw new Error(`Config returned ${configRes.status}`);
      const configData = await configRes.json();
      if (configData.status === "error") throw new Error(configData.error);
      setMappingCount(configData.mappingCount ?? 0);
      setPscRouteCount(configData.pscRouteCount ?? 0);

      if (isRunning) runAssignCycle();

      toast.success(`Google Sheet reloaded: ${configData.mappingCount} mapping(s), ${configData.pscRouteCount} PSC route(s) fetched`);
    } catch (err) {
      toast.error(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [isRunning, runAssignCycle]);

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
        <StatsSidebar
          isRunning={isRunning}
          mappingCount={mappingCount}
          pscRouteCount={pscRouteCount}
        />

        {/* Right: activity log + queued panel */}
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          <div className="flex-1 min-h-0">
            <ActivityLog logs={logs} />
          </div>
          {queued.length > 0 && (
            <div className="shrink-0 max-h-64 overflow-auto rounded-lg border border-slate-200 bg-white">
              <div className="px-3 py-2 border-b border-slate-200 text-sm font-semibold flex items-center justify-between">
                <span>Queued (scheduled / planned)</span>
                <span className="text-slate-500 font-normal">{queued.length}</span>
              </div>
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="text-left px-3 py-1.5">Eligible at</th>
                    <th className="text-left px-3 py-1.5">Job</th>
                    <th className="text-left px-3 py-1.5">Customer</th>
                    <th className="text-left px-3 py-1.5">Kind</th>
                    <th className="text-left px-3 py-1.5">Parked</th>
                  </tr>
                </thead>
                <tbody>
                  {queued.map((q) => (
                    <tr key={q.job_id} className="border-t border-slate-100">
                      <td className="px-3 py-1.5 font-mono">{q.eligible_at}</td>
                      <td className="px-3 py-1.5 font-mono">{q.job_id}</td>
                      <td className="px-3 py-1.5">{q.customer_name ?? q.customer_id ?? "—"}</td>
                      <td className="px-3 py-1.5">{q.kind}</td>
                      <td className="px-3 py-1.5">{q.parked_on_proxy ? "✓" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
