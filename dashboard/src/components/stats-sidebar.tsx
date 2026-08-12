"use client";

import type { DeploymentBeat } from "@/lib/smart-log-kv";

interface ServiceStatusProps {
  mappingCount: number;
  pscRouteCount: number;
  lastChecked: string | null;
  /** One per deployment that pinged in the last 24h. Empty on a single-account
   *  setup, which keeps the pill on its original shared-heartbeat behaviour. */
  deployments?: DeploymentBeat[];
}

function hhmm(ts: string): string {
  return new Date(ts).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Ho_Chi_Minh",
  });
}

/**
 * Minimal service health: just the heartbeat. Rendered as a compact pill in the
 * header. The config counts (a sanity check that the sheet loaded) live in the
 * tooltip rather than taking visual space — the Refresh toast also reports them.
 */
export function ServiceStatus({ mappingCount, pscRouteCount, lastChecked, deployments = [] }: ServiceStatusProps) {
  const lastCheckedLabel = lastChecked ? hhmm(lastChecked) : null;
  // Fresh = checked within the last 6 min (~2 missed cron pings = stale).
  const checkedMs = lastChecked ? new Date(lastChecked).getTime() : 0;
  // With more than one deployment the shared stamp is not enough: the others keep
  // it green while one sits dead, losing its share of the cycles invisibly. So
  // every deployment must be fresh for the pill to be green.
  const staleCount = deployments.filter((d) => !d.fresh).length;
  const fresh =
    deployments.length > 0
      ? staleCount === 0
      : checkedMs > 0 && Date.now() - checkedMs < 6 * 60 * 1000;

  const tooltip = [
    `${mappingCount} mapping(s) · ${pscRouteCount} PSC route(s) loaded`,
    ...(deployments.length > 1
      ? deployments.map((d) => `${d.id}: ${d.fresh ? "OK" : "mất tín hiệu"} (${hhmm(d.ts)})`)
      : []),
  ].join("\n");

  return (
    <div
      title={tooltip}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${
        fresh
          ? "border-green-500/40 bg-green-500/15 text-green-300"
          : "border-red-500/40 bg-red-500/15 text-red-300"
      }`}
    >
      <span className={`w-2 h-2 rounded-full ${fresh ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
      <span className="hidden sm:inline">Cập nhật</span>
      <span>{lastCheckedLabel ?? "—"}</span>
      {deployments.length > 1 && (
        <span className="border-l border-current/30 pl-1.5 tabular-nums">
          {deployments.length - staleCount}/{deployments.length}
        </span>
      )}
    </div>
  );
}
