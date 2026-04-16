"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { StatsSidebar } from "./stats-sidebar";
import { ActivityLog } from "./activity-log";
import { toast } from "sonner";
import type { LogEntry } from "@/lib/types";

type Env = "prod" | "uat";

export function Dashboard() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [mappingCount, setMappingCount] = useState(0);
  const [pscRouteCount, setPscRouteCount] = useState(0);
  const [env, setEnv] = useState<Env>("prod");
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
  const runAssignCycle = useCallback(async (targetEnv?: Env) => {
    if (cycleInProgressRef.current) return;
    cycleInProgressRef.current = true;
    const e = targetEnv ?? env;
    try {
      const res = await fetch(`/api/assign?env=${e}`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data.logs?.length) {
          setLogs((prev) => [...prev, ...data.logs]);
        }
      }
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
  }, [env]);

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

        {/* Right: activity log */}
        <div className="flex-1 min-w-0">
          <ActivityLog logs={logs} />
        </div>
      </div>
    </div>
  );
}
