"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DIAG_LOCATIONS } from "@/lib/diag-locations";
import type { FailedJob, FailedReason, PickupWarning } from "@/lib/types";

export interface ScheduleErrorRow {
  pickup_id: string;
  pickup_name?: string;
  dropoff_id: string;
  dropoff_name?: string;
  delivery_window: string;
  reference_number: string;
  message: string;
  job_id?: number;
}

const NAME_BY_ID = new Map(DIAG_LOCATIONS.map((l) => [l.customer_id, l.name]));
// Prefer the sheet's own name; fall back to the branch list, then the raw id.
const labelFor = (name: string | undefined, id: string) => name || NAME_BY_ID.get(id) || id;

// Reason → label + tone. Tone drives the chip/border colour: red = blocking
// (nothing the engine can do — needs a person), amber = config/ambiguity that a
// supervisor resolves (Sheet edit, pick a driver). Order = display priority.
const REASON_META: Record<
  FailedReason,
  { label: string; tone: "red" | "amber"; order: number }
> = {
  NO_DRIVER:      { label: "Không có tài xế trực", tone: "red",   order: 0 },
  UNAVAILABLE:    { label: "Tài xế bận / offline", tone: "red", order: 1 },
  ON_LEAVE:       { label: "Nghỉ, không người thay", tone: "amber", order: 2 },
  CLASH:          { label: "Trùng tài xế trực", tone: "amber", order: 3 },
  SUB_CLASH:      { label: "Trùng người thay", tone: "amber", order: 4 },
  NO_MAPPING:     { label: "Chưa cấu hình (Sheet)", tone: "amber", order: 5 },
  INVALID_DRIVER: { label: "Sai driver_id (Sheet)", tone: "red", order: 6 },
  NO_GPS:         { label: "Thiếu toạ độ GPS", tone: "red", order: 7 },
};

const TONE_STYLES: Record<"red" | "amber", { chip: string; border: string }> = {
  red:   { chip: "bg-red-100 text-red-700 border-red-300",     border: "border-l-red-500" },
  amber: { chip: "bg-amber-100 text-amber-800 border-amber-300", border: "border-l-amber-500" },
};

function metaFor(reason: FailedReason) {
  return REASON_META[reason] ?? { label: reason, tone: "red" as const, order: 99 };
}

/** Late duration: under 60 min as +N', otherwise +Xh / +Xh YY'. */
function fmtLate(m: number): string {
  if (m < 60) return `+${m}'`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `+${h}h${mm}'` : `+${h}h`;
}

function SectionHeader({ label, count, tone = "slate" }: { label: string; count: number; tone?: "slate" | "amber" | "red" }) {
  const color =
    tone === "amber" ? "text-amber-700" : tone === "red" ? "text-red-700" : "text-slate-500";
  return (
    <div className="flex items-center gap-1.5 pt-1">
      <span className={`text-[11px] font-bold uppercase tracking-wide ${color}`}>{label}</span>
      <span className="rounded-full bg-slate-100 border border-slate-200 px-1.5 leading-none py-0.5 text-[10px] text-slate-600">
        {count}
      </span>
    </div>
  );
}

function FailedRow({ job }: { job: FailedJob }) {
  const meta = metaFor(job.reason);
  const tone = TONE_STYLES[meta.tone];
  return (
    <div className={`rounded border border-l-4 bg-white p-2 ${tone.border}`}>
      <div className="flex items-center justify-between gap-2">
        <a
          href={`https://fleetweb-vn.cartrack.com/delivery/map?job=${job.job_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono font-semibold text-indigo-600 underline hover:text-indigo-800"
        >
          Job {job.job_id}
        </a>
        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-none ${tone.chip}`}>
          {meta.label}
        </span>
      </div>
      <p className="mt-0.5 font-medium text-slate-800 break-words">{job.customer}</p>
      <p className="mt-0.5 text-[11px] text-slate-500 break-words">{job.detail}</p>
      <p className="mt-0.5 text-[10px] text-slate-400">Lần cuối: {job.ts.slice(11, 19)}</p>
    </div>
  );
}

/**
 * The dashboard's attention hub: jobs the engine couldn't auto-assign, plus late
 * pickups ("Lấy mẫu chậm") and fixed-schedule (Lịch cố định) run errors — all the
 * things a supervisor needs to act on, in one place.
 */
export function FailedJobsPanel({
  failed,
  warnings,
  scheduleErrors,
  onRetrySchedule,
  retryingSchedule,
}: {
  failed: FailedJob[];
  warnings: PickupWarning[];
  scheduleErrors: ScheduleErrorRow[];
  onRetrySchedule: () => void;
  retryingSchedule: boolean;
}) {
  const total = failed.length + warnings.length + scheduleErrors.length;

  // Group assign failures by reason in display-priority order.
  const byReason = new Map<FailedReason, FailedJob[]>();
  for (const job of failed) {
    const list = byReason.get(job.reason);
    if (list) list.push(job);
    else byReason.set(job.reason, [job]);
  }
  const groups = Array.from(byReason.entries())
    .sort((a, b) => metaFor(a[0]).order - metaFor(b[0]).order)
    .map(([reason, jobs]) => [reason, jobs.sort((a, b) => a.job_id - b.job_id)] as const);

  return (
    <Card className="flex flex-col h-full py-4">
      <CardHeader className="pb-2 shrink-0">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Cần xử lý</CardTitle>
          <span className="text-xs text-muted-foreground">{total} mục</span>
        </div>
      </CardHeader>
      <CardContent className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="space-y-2 text-xs pr-3">
            {total === 0 && (
              <p className="text-muted-foreground text-center py-8">Không có gì cần xử lý 🎉</p>
            )}

            {/* ── Assign failures ─────────────────────────────────────────── */}
            {groups.map(([reason, jobs]) => (
              <div key={reason} className="space-y-1.5">
                <SectionHeader label={metaFor(reason).label} count={jobs.length} />
                {jobs.map((job) => (
                  <FailedRow key={job.job_id} job={job} />
                ))}
              </div>
            ))}

            {/* ── Late pickups (consolidated from "Lấy mẫu chậm") ──────────── */}
            {warnings.length > 0 && (
              <div className="space-y-1.5">
                <SectionHeader label="Lấy mẫu chậm" count={warnings.length} tone="amber" />
                {warnings.map((w) => (
                  <div
                    key={w.job_id}
                    className="rounded border border-l-4 border-l-amber-500 bg-amber-50/60 p-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <a
                        href={`https://fleetweb-vn.cartrack.com/delivery/map?job=${w.job_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono font-semibold text-indigo-600 underline hover:text-indigo-800"
                      >
                        Job {w.job_id}
                      </a>
                      <span className="font-bold text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-0.5 leading-none whitespace-nowrap">
                        {fmtLate(w.minutes_late ?? 0)}
                      </span>
                    </div>
                    {w.pickup_customer_name && (
                      <p className="mt-0.5 font-medium text-slate-800 break-words">{w.pickup_customer_name}</p>
                    )}
                    {w.driver_name && (
                      <p className="mt-0.5 text-[11px] text-slate-500 break-words">{w.driver_name}</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* ── Fixed-schedule run errors ───────────────────────────────── */}
            {scheduleErrors.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 pt-1">
                  <SectionHeader label="Lịch cố định lỗi" count={scheduleErrors.length} tone="red" />
                  <Button
                    size="sm"
                    className="h-6 text-[11px] px-2 bg-red-600 hover:bg-red-700"
                    disabled={retryingSchedule}
                    onClick={onRetrySchedule}
                  >
                    {retryingSchedule ? "Đang chạy…" : "Chạy lại lỗi"}
                  </Button>
                </div>
                {scheduleErrors.map((e, i) => (
                  <div
                    key={`${e.reference_number}-${i}`}
                    className="rounded border border-l-4 border-l-red-500 bg-white p-2"
                  >
                    <div className="font-semibold text-slate-800">
                      {labelFor(e.pickup_name, e.pickup_id)} <span className="text-slate-400">→</span> {labelFor(e.dropoff_name, e.dropoff_id)}
                      {e.delivery_window && (
                        <span className="ml-1.5 font-mono text-[11px] text-indigo-600">{e.delivery_window}</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-red-700 break-words">{e.message}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
