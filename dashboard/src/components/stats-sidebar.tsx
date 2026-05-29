"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface StatsSidebarProps {
  isRunning: boolean;
  mappingCount: number;
  pscRouteCount: number;
  lastChecked: string | null;
}

export function StatsSidebar({ isRunning, mappingCount, pscRouteCount, lastChecked }: StatsSidebarProps) {
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
    <Card className="py-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Service</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <div
            className={`w-2.5 h-2.5 rounded-full ${isRunning ? "bg-green-500 animate-pulse" : "bg-red-500"}`}
          />
          <span className="text-sm font-medium">
            {isRunning ? "Running" : "Stopped"}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {mappingCount} mapping(s) loaded
        </p>
        <p className="text-xs text-muted-foreground">
          {pscRouteCount} PSC route(s) loaded
        </p>
        <div
          className={`mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-semibold ${
            fresh ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
          }`}
        >
          <span className={`w-2 h-2 rounded-full ${fresh ? "bg-green-500 animate-pulse" : "bg-red-500"}`} />
          System last checked: {lastCheckedLabel ?? "—"}
        </div>
      </CardContent>
    </Card>
  );
}
