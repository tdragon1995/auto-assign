"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DIAG_LOCATIONS } from "@/lib/diag-locations";
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

// Reason → label + tone. Tone drives the chip/border colour: red = blocking
// (nothing the engine can do — needs a person), amber = config/ambiguity that a
// supervisor resolves (Sheet edit, pick a driver). Order = display priority.
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
  NO_GPS:         { label: "Thiếu toạ độ GPS", tone: "red", order: 7 },
};

const TONE_STYLES: Record<"red" | "amber", { chip: string; card: string }> = {
  red:   { chip: "bg-red-100 text-red-700 border-red-300",     card: "border-red-200 bg-red-50/50" },
  amber: { chip: "bg-amber-100 text-amber-800 border-amber-300", card: "border-amber-200 bg-amber-50/50" },
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

function FailedRow({
  job,
  drivers,
  onAssign,
}: {
  job: FailedJob;
  drivers: ConfigDriver[];
  onAssign: (job: FailedJob, driverId: string) => void;
}) {
  const meta = metaFor(job.reason);
  const tone = TONE_STYLES[meta.tone];
  const [showDriverSelect, setShowDriverSelect] = useState(false);
  const [selectedDriver, setSelectedDriver] = useState<string>("");
  const [searchInput, setSearchInput] = useState<string>("");

  const filteredDrivers = drivers.filter(d =>
    d.name.toLowerCase().includes(searchInput.toLowerCase()) ||
    d.driver_id.toLowerCase().includes(searchInput.toLowerCase())
  );

  const handleSelectDriver = (driverId: string) => {
    setSelectedDriver(driverId);
    setSearchInput("");
  };

  const handleAssign = () => {
    if (!selectedDriver) return;
    onAssign(job, selectedDriver);
  };

  const selectedDriverName = drivers.find(d => d.driver_id === selectedDriver)?.name;

  return (
    <div className={`rounded border px-2 py-1.5 ${tone.card}`}>
      {/* Line 1: job link · route · reason chip */}
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
        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-semibold leading-none ${tone.chip}`}>
          {meta.label}
        </span>
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
          <div className="space-y-1.5 mt-1.5">
            <div className="flex items-center gap-1">
              <div className="relative flex-1">
                <input
                  type="text"
                  placeholder="Tìm tài xế..."
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="w-full px-2 py-1 text-xs border border-slate-300 rounded"
                  autoFocus
                />
                {selectedDriver && (
                  <button
                    onClick={() => {
                      setSelectedDriver("");
                      setSearchInput("");
                    }}
                    className="absolute right-1 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
            {selectedDriver && selectedDriverName && (
              <div className="text-xs px-2 py-1 bg-indigo-50 border border-indigo-200 rounded text-indigo-800">
                Đã chọn: {selectedDriverName}
              </div>
            )}
            {searchInput && filteredDrivers.length > 0 && (
              <div className="border border-slate-300 rounded max-h-32 overflow-y-auto">
                {filteredDrivers.map((d) => (
                  <button
                    key={d.driver_id}
                    onClick={() => handleSelectDriver(d.driver_id)}
                    className="block w-full text-left px-2 py-1.5 text-xs hover:bg-slate-100 border-b border-slate-200 last:border-b-0"
                  >
                    {d.name}
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-1">
              <Button
                size="sm"
                className="flex-1 h-6 text-[11px] bg-indigo-600 hover:bg-indigo-700"
                disabled={!selectedDriver}
                onClick={handleAssign}
              >
                Gán
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1 h-6 text-[11px]"
                onClick={() => {
                  setShowDriverSelect(false);
                  setSelectedDriver("");
                  setSearchInput("");
                }}
              >
                Hủy
              </Button>
            </div>
          </div>
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
      <Card className="flex h-full flex-col items-center justify-center gap-1 py-8">
        <div className="text-3xl">✅</div>
        <p className="text-sm font-medium text-slate-600">Không có mục nào cần xử lý</p>
        <p className="text-xs text-slate-400">
          Job không gán được, chờ duyệt ghi chú và lấy mẫu chậm sẽ hiện ở đây
        </p>
      </Card>
    );
  }

  // Rows inside each section pack into a responsive grid so a full screen shows
  // as many items as possible; section headers stay full-width above their grid.
  const rowGrid = "grid grid-cols-1 gap-1.5 md:grid-cols-2";

  return (
    <Card className="flex h-full flex-col gap-2 py-2 border-orange-300">
      <CardHeader className="px-3 pb-0 shrink-0">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">⚠️ Cần xử lý</CardTitle>
          <span className="text-xs text-muted-foreground">{total} mục</span>
        </div>
      </CardHeader>
      <CardContent className="px-3 flex-1 min-h-0">
        {/* Full-height scroll. Order: notes → other unassignable → late pickups. */}
        <div className="h-full max-w-5xl overflow-y-auto space-y-2 text-xs pr-1">
            {/* ── Tasks with note (part of "unassignable") ─────────────────── */}
            {held.length > 0 && (
              <NoteReviewPanel
                held={held}
                env={env}
                onRefresh={onNoteRefresh}
                onAssigned={onNoteAssigned}
                embedded
              />
            )}

            {/* ── Other unassignable: assign failures ─────────────────────── */}
            {groups.map(([reason, jobs]) => (
              <div key={reason} className="space-y-1.5">
                <SectionHeader label={metaFor(reason).label} count={jobs.length} />
                <div className={rowGrid}>
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
                <div className={rowGrid}>
                  {scheduleErrors.map((e, i) => (
                    <div
                      key={`${e.reference_number}-${i}`}
                      className="rounded border border-red-200 bg-red-50/50 px-2 py-1.5"
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
                <div className={rowGrid}>
                  {warnings.map((w) => (
                    <div
                      key={w.job_id}
                      className="rounded border border-amber-200 bg-amber-50/60 px-2 py-1.5"
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
                        <span className="shrink-0 font-bold text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-0.5 leading-none whitespace-nowrap">
                          {fmtLate(w.minutes_late ?? 0)}
                        </span>
                      </div>
                      {w.driver_name && (
                        <p className="mt-0.5 text-[11px] text-slate-500 break-words md:truncate" title={w.driver_name}>{w.driver_name}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
        </div>
      </CardContent>
    </Card>
  );
}
