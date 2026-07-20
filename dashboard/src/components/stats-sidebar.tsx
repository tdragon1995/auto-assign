"use client";

interface ServiceStatusProps {
  mappingCount: number;
  pscRouteCount: number;
  lastChecked: string | null;
}

/**
 * Minimal service health: just the heartbeat. Rendered as a compact pill in the
 * header. The config counts (a sanity check that the sheet loaded) live in the
 * tooltip rather than taking visual space — the Refresh toast also reports them.
 */
export function ServiceStatus({ mappingCount, pscRouteCount, lastChecked }: ServiceStatusProps) {
  const lastCheckedLabel = lastChecked
    ? new Date(lastChecked).toLocaleTimeString("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Ho_Chi_Minh",
      })
    : null;
  // Fresh = checked within the last 6 min (~2 missed cron pings = stale).
  const checkedMs = lastChecked ? new Date(lastChecked).getTime() : 0;
  const fresh = checkedMs > 0 && Date.now() - checkedMs < 6 * 60 * 1000;

  return (
    <div
      title={`${mappingCount} mapping(s) · ${pscRouteCount} PSC route(s) loaded`}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${
        fresh
          ? "border-green-500/40 bg-green-500/15 text-green-300"
          : "border-red-500/40 bg-red-500/15 text-red-300"
      }`}
    >
      <span className={`w-2 h-2 rounded-full ${fresh ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
      <span className="hidden sm:inline">Cập nhật</span>
      <span>{lastCheckedLabel ?? "—"}</span>
    </div>
  );
}
