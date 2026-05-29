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
        <p className="text-xs text-muted-foreground mt-1">
          System last checked: {lastCheckedLabel ?? "—"}
        </p>
      </CardContent>
    </Card>
  );
}
