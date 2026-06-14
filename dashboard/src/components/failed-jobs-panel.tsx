"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { FailedJob, FailedReason } from "@/lib/types";

// Reason → label + tone. Tone drives the chip/border colour: red = blocking
// (nothing the engine can do — needs a person), amber = config/ambiguity that a
// supervisor resolves (Sheet edit, pick a driver). Order = display priority.
const REASON_META: Record<
  FailedReason,
  { label: string; tone: "red" | "amber"; order: number }
> = {
  NO_DRIVER:      { label: "Không có tài xế trực", tone: "red",   order: 0 },
  UNAVAILABLE:    { label: "Tài xế đều bận / offline", tone: "red", order: 1 },
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
 * Jobs the engine couldn't auto-assign for a deterministic, recurring reason.
 * Fed by the dashboard status poll (a live snapshot, replaced each cycle), so a
 * resolved job drops off on its own. Shown here instead of re-printing the same
 * ERROR to the live log every 3 minutes.
 */
export function FailedJobsPanel({ failed }: { failed: FailedJob[] }) {
  // Group by reason in display-priority order; sort jobs within a group by id.
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
          <span className="text-xs text-muted-foreground">{failed.length} job</span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Job không thể tự động giao — đã gom lại đây thay vì lặp lỗi ở Live Log. Tự biến mất khi xử lý xong.
        </p>
      </CardHeader>
      <CardContent className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="space-y-2 text-xs pr-3">
            {failed.length === 0 && (
              <p className="text-muted-foreground text-center py-8">
                Không có job nào cần xử lý 🎉
              </p>
            )}
            {groups.map(([reason, jobs]) => (
              <div key={reason} className="space-y-1.5">
                <div className="flex items-center gap-1.5 pt-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    {metaFor(reason).label}
                  </span>
                  <span className="rounded-full bg-slate-100 border border-slate-200 px-1.5 leading-none py-0.5 text-[10px] text-slate-600">
                    {jobs.length}
                  </span>
                </div>
                {jobs.map((job) => (
                  <FailedRow key={job.job_id} job={job} />
                ))}
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
