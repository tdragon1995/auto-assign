"use client";

import { useState } from "react";
import { CheckCircle2, Clock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DIAG_LOCATIONS } from "@/lib/diag-locations";
import { DriverPicker } from "./driver-picker";
import { NoteReviewPanel, type HeldJob } from "./note-review-panel";
import { SectionHeader } from "./section-header";
import type { FailedJob, FailedReason, PickupWarning, ConfigDriver } from "@/lib/types";

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

// Reason → label + tone. Tone colours the section header (red = blocking,
// nothing the engine can do — needs a person; amber = config/ambiguity a
// supervisor resolves via Sheet edit or driver pick). Order = display priority.
const REASON_META: Record<
  FailedReason,
  { label: string; tone: "red" | "amber"; order: number }
> = {
  NO_DRIVER:      { label: "Không có tài xế trực", tone: "red",   order: 0 },
  UNAVAILABLE:    { label: "Giao Nhận Mẫu bận / offline", tone: "red", order: 1 },
  ON_LEAVE:       { label: "Nghỉ, không người thay", tone: "amber", order: 2 },
  CLASH:          { label: "Trùng tài xế trực", tone: "amber", order: 3 },
  SUB_CLASH:      { label: "Trùng người thay", tone: "amber", order: 4 },
  NO_MAPPING:     { label: "Chưa cấu hình (Sheet)", tone: "amber", order: 5 },
  INVALID_DRIVER: { label: "Sai driver_id (Sheet)", tone: "red", order: 6 },
  DEACTIVATED:    { label: "Tài khoản tài xế đã bị khoá", tone: "red", order: 7 },
  NO_GPS:         { label: "Thiếu toạ độ GPS", tone: "red", order: 8 },
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

/** Reference time the "+N'" delay is counted from: the start of the working day
 *  for pickups whose own anchor fell before it (clock_from), else the
 *  delivery-window start (the "arrive-at" time) for windowed pickups, else the
 *  job's creation time. `time` is
 *  the compact HH:mm shown next to the delay badge; `full` is the labelled form for
 *  the tooltip (carries the window's end time too). Window times are raw
 *  "HH:mm:ss+07:00" (slice HH:mm); create_ts is a Cartrack ts → HH:mm. */
function refTime(w: PickupWarning): { time: string; full: string } | null {
  // A floored clock wins: the delay is counted from the start of the working day,
  // not from a window or creation time that fell before it.
  if (w.clock_from) return { time: w.clock_from, full: `Tính từ ${w.clock_from}` };
  if (w.window_time_from) {
    const from = w.window_time_from.slice(0, 5);
    const to = w.window_time_to?.slice(0, 5);
    return { time: from, full: `Khung giờ ${from}${to ? `–${to}` : ""}` };
  }
  if (w.create_ts) {
    const m = /[ T](\d{2}:\d{2})/.exec(w.create_ts);
    if (m) return { time: m[1], full: `Tạo lúc ${m[1]}` };
  }
  return null;
}

function FailedRow({
  job,
  drivers,
  onAssign,
}: {
  job: FailedJob;
  drivers: ConfigDriver[];
  onAssign: (job: FailedJob, driverId: string) => void;
}) {
  const [showDriverSelect, setShowDriverSelect] = useState(false);

  return (
    <div className="px-2 py-1.5 hover:bg-slate-50">
      {/* Line 1: job link · route (reason lives in the section header) */}
      <div className="flex items-center gap-2 min-w-0">
        <a
          href={`https://fleetweb-vn.cartrack.com/delivery/map?job=${job.job_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 font-mono font-semibold text-indigo-600 underline hover:text-indigo-800"
        >
          Job {job.job_id}
        </a>
        {/* Mobile has no hover for the title tooltip, so wrap there; truncate from md up. */}
        <span className="min-w-0 flex-1 break-words md:truncate text-sm font-medium text-slate-800" title={job.customer}>
          {job.customer}
        </span>
        {/* Appointment time (pickup delivery window) when the job has one — a job
            only fails with its window already due, so this is what the manual pick
            is racing. ASAP jobs have none and show nothing. */}
        {job.delivery_window && (
          <span
            className="shrink-0 flex items-center gap-1 text-xs font-semibold tabular-nums text-slate-700 whitespace-nowrap"
            title={`Khung giờ ${job.delivery_window}`}
          >
            <Clock className="w-3.5 h-3.5 text-slate-400" aria-hidden />
            {job.delivery_window}
          </span>
        )}
      </div>
      {/* Line 2: detail · last-seen · manual-assign trigger */}
      <div className="mt-0.5 flex items-center gap-2 min-w-0">
        <span className="min-w-0 flex-1 break-words md:truncate text-[11px] text-slate-500" title={job.detail}>
          {job.detail}
        </span>
        <span className="shrink-0 text-[11px] text-slate-500">{job.ts.slice(11, 19)}</span>
        {!showDriverSelect && (
          <Button
            size="sm"
            variant="outline"
            className="text-[11px] h-6 px-2 shrink-0"
            onClick={() => setShowDriverSelect(true)}
          >
            Gán thủ công
          </Button>
        )}
      </div>

      {/* Every failed-assign reason ends with the job unassigned, so all of them
          allow a manual pick. (Manual assign is a direct Cartrack assign by
          job_id + driver_id — independent of the sheet mapping.) */}
      {showDriverSelect && (
        <DriverPicker
          drivers={drivers}
          onConfirm={(driverId) => onAssign(job, driverId)}
          onCancel={() => setShowDriverSelect(false)}
        />
      )}
    </div>
  );
}

/**
 * The dashboard's attention hub: jobs the engine couldn't auto-assign, plus late
 * pickups ("Lấy mẫu chậm") and fixed-schedule (Lịch cố định) run errors — all the
 * things a supervisor needs to act on, in one place.
 */
export function FailedJobsPanel({
  held,
  env,
  onNoteRefresh,
  onNoteAssigned,
  onNoteManualAssign,
  failed,
  warnings,
  scheduleErrors,
  drivers,
  onAssign,
  onRetrySchedule,
  retryingSchedule,
}: {
  held: HeldJob[];
  env: "prod" | "uat";
  onNoteRefresh: () => void;
  onNoteAssigned: (jobId: number) => void;
  onNoteManualAssign: (job: HeldJob, driverId: string) => void;
  failed: FailedJob[];
  warnings: PickupWarning[];
  scheduleErrors: ScheduleErrorRow[];
  drivers: ConfigDriver[];
  onAssign: (job: FailedJob, driverId: string) => void;
  onRetrySchedule: () => void;
  retryingSchedule: boolean;
}) {
  const total = held.length + failed.length + warnings.length + scheduleErrors.length;

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

  // Now the landing tab, so an empty list shows a friendly all-clear state
  // instead of vanishing.
  if (total === 0) {
    return (
      <Card className="flex h-full flex-col items-center justify-center gap-1.5 py-8">
        <CheckCircle2 className="size-8 text-emerald-500" strokeWidth={1.75} />
        <p className="text-sm font-medium text-slate-600">Không có mục nào cần xử lý</p>
        <p className="text-xs text-slate-400">
          Job không gán được, chờ duyệt ghi chú và lấy mẫu chậm sẽ hiện ở đây
        </p>
      </Card>
    );
  }

  // Each section is a divided list (one bordered container, hairline rows) —
  // the tone-coloured header carries severity, so rows stay quiet.
  const listBox = "divide-y divide-slate-100 overflow-hidden rounded-md border border-slate-200";

  return (
    <Card className="flex h-full flex-col gap-2 py-2 border-slate-200">
      {/* No card header: the "Cần xử lý" tab already names this panel and shows the
          count, and each section below carries its own labelled header. */}
      <CardContent className="px-3 flex-1 min-h-0">
        {/* Full-height scroll. Order: notes → other unassignable → late pickups. */}
        <div className="h-full max-w-5xl overflow-y-auto space-y-3 text-xs pr-1">
            {/* ── Tasks with note (part of "unassignable") ─────────────────── */}
            {held.length > 0 && (
              <NoteReviewPanel
                held={held}
                env={env}
                onRefresh={onNoteRefresh}
                onAssigned={onNoteAssigned}
                drivers={drivers}
                onManualAssign={onNoteManualAssign}
                embedded
              />
            )}

            {/* ── Other unassignable: assign failures ─────────────────────── */}
            {groups.map(([reason, jobs]) => (
              <div key={reason} className="space-y-1.5">
                <SectionHeader label={metaFor(reason).label} count={jobs.length} tone={metaFor(reason).tone} />
                <div className={listBox}>
                  {jobs.map((job) => (
                    <FailedRow
                      key={job.job_id}
                      job={job}
                      drivers={drivers}
                      onAssign={onAssign}
                    />
                  ))}
                </div>
              </div>
            ))}

            {/* ── Other unassignable: fixed-schedule run errors ───────────── */}
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
                <div className={listBox}>
                  {scheduleErrors.map((e, i) => (
                    <div
                      key={`${e.reference_number}-${i}`}
                      className="px-2 py-1.5 hover:bg-slate-50"
                    >
                      <div className="text-sm font-semibold text-slate-800 break-words md:truncate" title={`${labelFor(e.pickup_name, e.pickup_id)} → ${labelFor(e.dropoff_name, e.dropoff_id)}`}>
                        {labelFor(e.pickup_name, e.pickup_id)} <span className="text-slate-400">→</span> {labelFor(e.dropoff_name, e.dropoff_id)}
                        {e.delivery_window && (
                          <span className="ml-1.5 font-mono text-[11px] text-indigo-600">{e.delivery_window}</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-red-700 break-words md:truncate" title={e.message}>{e.message}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Late pickups ("Lấy mẫu chậm") — last ─────────────────────── */}
            {warnings.length > 0 && (
              <div className="space-y-1.5">
                <SectionHeader label="Lấy mẫu chậm" count={warnings.length} tone="amber" />
                <div className={listBox}>
                  {warnings.map((w) => {
                    const ref = refTime(w);
                    return (
                    <div
                      key={w.job_id}
                      className="px-2 py-1.5 hover:bg-slate-50"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <a
                          href={`https://fleetweb-vn.cartrack.com/delivery/map?job=${w.job_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 font-mono font-semibold text-indigo-600 underline hover:text-indigo-800"
                        >
                          Job {w.job_id}
                        </a>
                        <span
                          className="min-w-0 flex-1 break-words md:truncate text-sm font-medium text-slate-800"
                          title={`${w.pickup_customer_name ?? "—"} → ${w.dropoff_customer_name ?? "—"}`}
                        >
                          {w.pickup_customer_name ?? "—"} <span className="text-slate-400">→</span> {w.dropoff_customer_name ?? "—"}
                        </span>
                        {/* Anchor time + delay read as one unit: "since HH:MM, +N' late". */}
                        {ref && (
                          <span
                            className="shrink-0 flex items-center gap-1 text-xs font-semibold tabular-nums text-slate-700 whitespace-nowrap"
                            title={ref.full}
                          >
                            <Clock className="w-3.5 h-3.5 text-slate-400" aria-hidden />
                            {ref.time}
                          </span>
                        )}
                        <span className="shrink-0 font-bold text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-0.5 leading-none whitespace-nowrap">
                          {fmtLate(w.minutes_late ?? 0)}
                        </span>
                      </div>
                      {w.driver_name && (
                        <p className="mt-0.5 text-[11px] text-slate-500 break-words md:truncate" title={w.driver_name}>{w.driver_name}</p>
                      )}
                    </div>
                    );
                  })}
                </div>
              </div>
            )}
        </div>
      </CardContent>
    </Card>
  );
}
