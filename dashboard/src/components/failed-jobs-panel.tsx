"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DIAG_LOCATIONS } from "@/lib/diag-locations";
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

function FailedRow({
  job,
  drivers,
  onAssign,
  assigning,
}: {
  job: FailedJob;
  drivers: ConfigDriver[];
  onAssign: (jobId: number, driverId: string) => Promise<void>;
  assigning: boolean;
}) {
  const meta = metaFor(job.reason);
  const tone = TONE_STYLES[meta.tone];
  const [showDriverSelect, setShowDriverSelect] = useState(false);
  const [selectedDriver, setSelectedDriver] = useState<string>("");
  const [assignError, setAssignError] = useState<string>("");

  const handleAssign = async () => {
    if (!selectedDriver) return;
    try {
      setAssignError("");
      await onAssign(job.job_id, selectedDriver);
      setShowDriverSelect(false);
      setSelectedDriver("");
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : "Gán job thất bại");
    }
  };

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

      {job.reason === "NO_DRIVER" || job.reason === "CLASH" ? (
        <div className="mt-2">
          {!showDriverSelect ? (
            <Button
              size="sm"
              variant="outline"
              className="text-[10px] h-6 px-2"
              onClick={() => setShowDriverSelect(true)}
            >
              Gán thủ công
            </Button>
          ) : (
            <div className="space-y-1.5 mt-2">
              <select
                value={selectedDriver}
                onChange={(e) => {
                  setSelectedDriver(e.target.value);
                  setAssignError("");
                }}
                className="w-full px-2 py-1 text-[10px] border border-slate-300 rounded"
              >
                <option value="">Chọn Giao Nhận Mẫu...</option>
                {drivers.map((d) => (
                  <option key={d.driver_id} value={d.driver_id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  className="flex-1 h-6 text-[10px] bg-blue-600 hover:bg-blue-700"
                  disabled={!selectedDriver || assigning}
                  onClick={handleAssign}
                >
                  {assigning ? "Đang gán..." : "Gán"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 h-6 text-[10px]"
                  disabled={assigning}
                  onClick={() => {
                    setShowDriverSelect(false);
                    setSelectedDriver("");
                    setAssignError("");
                  }}
                >
                  Hủy
                </Button>
              </div>
              {assignError && (
                <p className="text-[10px] text-red-600">{assignError}</p>
              )}
            </div>
          )}
        </div>
      ) : null}
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
  drivers,
  onRetrySchedule,
  retryingSchedule,
}: {
  failed: FailedJob[];
  warnings: PickupWarning[];
  scheduleErrors: ScheduleErrorRow[];
  drivers: ConfigDriver[];
  onRetrySchedule: () => void;
  retryingSchedule: boolean;
}) {
  const [assigning, setAssigning] = useState(false);

  const handleAssign = async (jobId: number, driverId: string) => {
    setAssigning(true);
    try {
      const res = await fetch("/api/admin/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId, driver_id: driverId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Gán job thất bại");
      }
      // Job assigned successfully — refresh will pick up the change
    } finally {
      setAssigning(false);
    }
  };
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
                  <FailedRow
                    key={job.job_id}
                    job={job}
                    drivers={drivers}
                    onAssign={handleAssign}
                    assigning={assigning}
                  />
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
                    <p className="mt-0.5 font-medium text-slate-800 break-words">
                      {w.pickup_customer_name ?? "—"} <span className="text-slate-400">→</span> {w.dropoff_customer_name ?? "—"}
                    </p>
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
