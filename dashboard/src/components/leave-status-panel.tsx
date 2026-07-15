"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionHeader } from "./section-header";
import type { LeaveOnDate } from "@/lib/leave-config";

const TYPE_LABEL: Record<string, string> = {
  "Nghỉ nguyên buổi": "Cả ngày",
  "Nghỉ nửa buổi": "Nửa buổi",
  "Nghỉ việc": "Nghỉ việc",
};

// Most rows use one of the three cham-cong labels (shortened above), but many
// are typed straight into the sheet with a free-text type ("Nghỉ phép", "Nghỉ
// không lương", …) or none at all — show the sheet's own text rather than
// flattening everything unrecognized into one generic label.
function typeLabel(loaiNghi: string): string {
  if (!loaiNghi) return "Nghỉ";
  return TYPE_LABEL[loaiNghi] ?? loaiNghi;
}

function DriverChip({ d }: { d: LeaveOnDate }) {
  const subNames = d.subs.map((s) => s.name).filter(Boolean);
  return (
    <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-medium text-slate-800">{d.driver_name || d.driver_id}</span>
        <span className="shrink-0 rounded-full bg-amber-100 text-amber-700 border border-amber-200 px-1.5 py-0 text-[10px] font-semibold leading-relaxed">
          {typeLabel(d.loai_nghi)}
        </span>
        {d.timeLabel && (
          <span className="shrink-0 font-mono text-[10px] text-slate-500">{d.timeLabel}</span>
        )}
      </div>
      {subNames.length > 0 && (
        // Mobile has no hover for the title tooltip, so wrap there; truncate from md up.
        <div className="mt-0.5 text-[10px] text-slate-500 break-words md:truncate" title={`Thay: ${subNames.join(", ")}`}>
          Thay: {subNames.join(", ")}
        </div>
      )}
    </div>
  );
}

function DaySection({ label, drivers }: { label: string; drivers: LeaveOnDate[] }) {
  return (
    <div className="flex-1 min-w-[220px]">
      <SectionHeader label={label} count={drivers.length} className="mb-1" />
      {drivers.length === 0 ? (
        <p className="text-[11px] text-slate-400">Không có ai nghỉ</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {drivers.map((d, i) => (
            <DriverChip key={`${d.driver_id}-${d.timeLabel ?? "full"}-${i}`} d={d} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Leave-status summary for the "Cần xử lý" tab: who's off today and tomorrow,
 * with their coverage window and substitute (if any). Read-only reference —
 * always visible (even when nobody's out) so a supervisor can trust an empty
 * list means "checked", not "not loaded". When the fetch fails and there's no
 * prior data, an explicit error line is shown instead of a misleading empty
 * state. Capped height with its own scroll so a long roster can't squeeze the
 * actionable list below it.
 */
export function LeaveStatusPanel({
  today,
  tomorrow,
  error = false,
}: {
  today: LeaveOnDate[];
  tomorrow: LeaveOnDate[];
  error?: boolean;
}) {
  const noData = today.length === 0 && tomorrow.length === 0;
  return (
    <Card className="py-2 shrink-0 border-slate-200">
      <CardHeader className="px-3 pb-0">
        <CardTitle className="text-sm">🌴 Nghỉ phép</CardTitle>
      </CardHeader>
      <CardContent className="px-3 max-h-[38vh] overflow-y-auto">
        {error && noData ? (
          <p className="text-xs text-red-600">Không tải được trạng thái nghỉ phép — thử Refresh.</p>
        ) : (
          <div className="flex gap-3 flex-wrap">
            <DaySection label="Hôm nay" drivers={today} />
            <DaySection label="Ngày mai" drivers={tomorrow} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
