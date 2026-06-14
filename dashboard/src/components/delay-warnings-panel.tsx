"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { PickupWarning } from "@/lib/types";

/** Late duration: under 60 min as +N', otherwise +Xh / +Xh YY'. */
function fmtLate(m: number): string {
  if (m < 60) return `+${m}'`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `+${h}h${mm}'` : `+${h}h`;
}

/**
 * Pickup jobs running late ("Lấy mẫu chậm") — one of the dashboard's primary
 * surfaces, so it gets its own always-visible card instead of being buried in the
 * activity-log header. Hidden entirely when there's nothing late.
 */
export function DelayWarningsPanel({ warnings }: { warnings: PickupWarning[] }) {
  if (warnings.length === 0) return null;

  return (
    <Card className="py-4 border-amber-300">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <span className="leading-none">⚠</span>
          Lấy mẫu chậm
          <span className="text-amber-600 font-semibold">{warnings.length}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="max-h-64">
          <div className="space-y-1.5 pr-2">
            {warnings.map((w) => (
              <div
                key={w.job_id}
                className="bg-amber-50 border border-amber-300 rounded-lg px-2.5 py-1.5 text-xs space-y-0.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <a
                    href={`https://fleetweb-vn.cartrack.com/delivery/map?job=${w.job_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono font-semibold text-indigo-600 underline hover:text-indigo-800"
                  >
                    {w.job_id}
                  </a>
                  <span className="font-bold text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-0.5 leading-none whitespace-nowrap">
                    {fmtLate(w.minutes_late ?? 0)}
                  </span>
                </div>
                {w.pickup_customer_name && (
                  <p className="text-slate-700 font-medium truncate leading-snug" title={w.pickup_customer_name}>
                    {w.pickup_customer_name}
                  </p>
                )}
                {w.driver_name && (
                  <p className="text-slate-400 truncate leading-snug" title={w.driver_name}>
                    {w.driver_name}
                  </p>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
