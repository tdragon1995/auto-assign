"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PickupWarning } from "@/lib/types";

// Reference time the lateness is measured against: a delivery window for windowed
// pickups, else the job's creation time. Window times are raw "HH:mm:ss+07:00"
// (slice HH:mm); create_ts is a Cartrack ts ("2026-06-20 08:31:47" → HH:mm).
function refTimeLabel(w: PickupWarning): string | null {
  if (w.window_time_from) {
    const from = w.window_time_from.slice(0, 5);
    const to = w.window_time_to?.slice(0, 5);
    return `Khung giờ ${from}${to ? `–${to}` : ""}`;
  }
  if (w.create_ts) {
    const m = /[ T](\d{2}:\d{2})/.exec(w.create_ts);
    if (m) return `Tạo lúc ${m[1]}`;
  }
  return null;
}

export function PickupWarningPanel({ warnings }: { warnings: PickupWarning[] }) {
  if (warnings.length === 0) return null;

  return (
    <Card className="py-4 border-amber-400 bg-amber-50">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-amber-800 flex items-center gap-1.5">
          <span className="text-base leading-none">⚠</span>
          <span>Chưa lấy mẫu ({warnings.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {warnings.map((w) => (
          <div
            key={w.job_id}
            className="rounded-lg border border-amber-200 bg-white p-2 space-y-0.5"
          >
            <div className="flex items-center justify-between gap-1">
              <span className="font-mono text-xs font-semibold text-slate-700">
                #{w.job_id}
              </span>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700">
                Trễ
              </span>
            </div>
            {w.pickup_customer_name && (
              <p className="text-xs text-slate-700 font-medium truncate">
                {w.pickup_customer_name}
              </p>
            )}
            {w.driver_name && (
              <p className="text-[11px] text-slate-400 truncate">{w.driver_name}</p>
            )}
            {refTimeLabel(w) && (
              <p className="text-[11px] text-slate-400 truncate">{refTimeLabel(w)}</p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
