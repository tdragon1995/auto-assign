"use client";

import dynamic from "next/dynamic";
import type { Driver, Job } from "@/lib/types";

const FleetMapInner = dynamic(() => import("./fleet-map-inner"), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full flex items-center justify-center bg-muted rounded-lg">
      <p className="text-muted-foreground text-sm">Loading map...</p>
    </div>
  ),
});

interface FleetMapProps {
  drivers: Driver[];
  jobs: Job[];
}

export function FleetMap({ drivers, jobs }: FleetMapProps) {
  return <FleetMapInner drivers={drivers} jobs={jobs} />;
}
