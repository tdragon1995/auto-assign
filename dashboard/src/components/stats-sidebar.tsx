"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { Driver, Job } from "@/lib/types";
import { DRIVER_STATUS_CONFIG } from "@/lib/types";

interface StatsSidebarProps {
  drivers: Driver[];
  jobs: Job[];
  isRunning: boolean;
  mappingCount: number;
  pscRouteCount: number;
}

export function StatsSidebar({
  drivers,
  jobs,
  isRunning,
  mappingCount,
  pscRouteCount,
}: StatsSidebarProps) {
  const statusCounts = drivers.reduce(
    (acc, d) => {
      const id = d.driver_status_id;
      acc[id] = (acc[id] ?? 0) + 1;
      return acc;
    },
    {} as Record<number, number>
  );

  const activeDrivers = drivers.filter((d) => d.is_active).length;
  const withLocation = drivers.filter(
    (d) => d.latitude != null && d.longitude != null
  ).length;

  return (
    <div className="flex flex-col gap-3 w-64 shrink-0">
      {/* Service Status */}
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
        </CardContent>
      </Card>

      {/* Driver Stats */}
      <Card className="py-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Drivers</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Total</span>
              <span className="font-medium">{drivers.length}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Active</span>
              <span className="font-medium">{activeDrivers}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">With GPS</span>
              <span className="font-medium">{withLocation}</span>
            </div>
          </div>

          <Separator className="my-2" />

          <div className="space-y-1">
            {Object.entries(DRIVER_STATUS_CONFIG).map(
              ([id, { name, color }]) => {
                const count = statusCounts[Number(id)] ?? 0;
                if (count === 0) return null;
                return (
                  <div
                    key={id}
                    className="flex items-center justify-between text-xs"
                  >
                    <div className="flex items-center gap-1.5">
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: color }}
                      />
                      <span>{name}</span>
                    </div>
                    <Badge variant="secondary" className="text-xs px-1.5 py-0">
                      {count}
                    </Badge>
                  </div>
                );
              }
            )}
          </div>
        </CardContent>
      </Card>

      {/* Job Stats */}
      <Card className="py-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Unassigned Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{jobs.length}</div>
          <p className="text-xs text-muted-foreground">awaiting assignment</p>
        </CardContent>
      </Card>
    </div>
  );
}
