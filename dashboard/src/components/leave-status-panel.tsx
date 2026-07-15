"use client";

import { Card, CardContent } from "@/components/ui/card";
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

/** "2026-07-13" → "13/07" for compact date context on resigned drivers. */
function ddmm(date: string): string {
  return date.length >= 10 ? `${date.slice(8, 10)}/${date.slice(5, 7)}` : date;
}

/** Sheet driver names look like "F - P - DC101406 Bùi Hiền Anh Kiệt" — the
 *  fleet code drowns the actual name, so split code from name and let the
 *  caller de-emphasize the code. Names not following the "A - B - CODE Name"
 *  pattern render whole. */
function splitDriverName(full: string): { code: string | null; name: string } {
  const parts = full.split(" - ");
  if (parts.length >= 3) {
    const tail = parts[parts.length - 1]; // "DC101406 Bùi Hiền Anh Kiệt"
    const sp = tail.indexOf(" ");
    if (sp > 0) {
      return {
        code: [...parts.slice(0, -1), tail.slice(0, sp)].join(" - "),
        name: tail.slice(sp + 1),
      };
    }
  }
  return { code: null, name: full };
}

/** One card per driver: same-driver entries (split-shift coverage) merge into
 *  window rows so a two-window day doesn't read as a duplicate listing. */
interface DriverGroup {
  driver_id: string;
  driver_name: string;
  loai_nghi: string;
  leave_from: string;
  rows: { timeLabel: string | null; subs: LeaveOnDate["subs"] }[];
}

function groupByDriver(drivers: LeaveOnDate[]): DriverGroup[] {
  const map = new Map<string, DriverGroup>();
  for (const d of drivers) {
    const g = map.get(d.driver_id);
    if (!g) {
      map.set(d.driver_id, {
        driver_id: d.driver_id,
        driver_name: d.driver_name,
        loai_nghi: d.loai_nghi,
        leave_from: d.leave_from,
        rows: [{ timeLabel: d.timeLabel, subs: d.subs }],
      });
    } else {
      // "Nghỉ việc" outranks day-leave labels for the card chip.
      if (d.loai_nghi === "Nghỉ việc") g.loai_nghi = d.loai_nghi;
      g.rows.push({ timeLabel: d.timeLabel, subs: d.subs });
    }
  }
  return [...map.values()];
}

/**
 * Severity signalling: an on-leave driver with NO substitute is the actionable
 * case (the engine will fail their jobs with "Nghỉ, không người thay"), so the
 * card goes amber and says so. Covered drivers stay quiet with a green check.
 * Resigned drivers (permanent — routing needs a re-plan, not a sub) get a red
 * chip plus their first day off for context.
 */
function DriverCard({ g }: { g: DriverGroup }) {
  const resigned = g.loai_nghi === "Nghỉ việc";
  const uncovered = !resigned && g.rows.some((r) => r.subs.length === 0);
  const chipClass = resigned
    ? "bg-red-100 text-red-700 border-red-200"
    : "bg-amber-100 text-amber-700 border-amber-200";
  const cardClass = uncovered ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white";
  const { code, name } = splitDriverName(g.driver_name || g.driver_id);
  return (
    <div className={`rounded border px-2 py-1 text-xs ${cardClass}`}>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-semibold text-slate-800">{name}</span>
        {code && <span className="font-mono text-[9px] text-slate-400">{code}</span>}
        <span
          className={`shrink-0 rounded-full border px-1.5 py-0 text-[10px] font-semibold leading-relaxed ${chipClass}`}
        >
          {typeLabel(g.loai_nghi)}
        </span>
        {resigned && <span className="text-[10px] text-slate-400">từ {ddmm(g.leave_from)}</span>}
      </div>
      {/* Coverage rows: window → sub (sub shown by name only; the full sheet
          label is in the title attr). Wraps on mobile — nothing truncates. */}
      {!resigned &&
        g.rows.map((r, i) => (
          <div key={i} className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-[10px]">
            {r.timeLabel && <span className="font-mono text-slate-500">{r.timeLabel}</span>}
            {r.subs.length > 0 ? (
              <span
                className="text-emerald-700 break-words"
                title={`Thay: ${r.subs.map((s) => s.name || s.id).join(", ")}`}
              >
                ✓ {r.subs.map((s) => splitDriverName(s.name || s.id).name).join(", ")}
              </span>
            ) : (
              <span className="font-semibold text-amber-700">Chưa có người thay</span>
            )}
          </div>
        ))}
    </div>
  );
}

function DaySection({ label, drivers }: { label: string; drivers: LeaveOnDate[] }) {
  const groups = groupByDriver(drivers);
  return (
    <div className="flex-1 min-w-[220px]">
      {/* Count = people off, not sheet rows */}
      <SectionHeader label={label} count={groups.length} className="mb-1" />
      {groups.length === 0 ? (
        <p className="text-[11px] text-slate-400">Không có ai nghỉ</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {groups.map((g) => (
            <DriverCard key={g.driver_id} g={g} />
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
      <CardContent className="px-3 max-h-[38vh] overflow-y-auto">
        {error && noData ? (
          <p className="text-xs text-red-600">
            🌴 Không tải được trạng thái nghỉ phép — thử Refresh.
          </p>
        ) : (
          // Title sits inline with the day columns (wraps above them when
          // narrow) so the panel doesn't spend a whole row on a heading.
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            <div className="shrink-0 pt-0.5 text-sm font-semibold">🌴 Nghỉ phép</div>
            <DaySection label="Hôm nay" drivers={today} />
            <DaySection label="Ngày mai" drivers={tomorrow} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
