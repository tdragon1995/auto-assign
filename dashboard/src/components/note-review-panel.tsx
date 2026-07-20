"use client";

import { useCallback, useState } from "react";
import { StickyNote } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export interface HeldJob {
  job_id: number;
  customer: string;
  note: string;
  /** Present when a background approve/schedule failed and the job was put back. */
  error?: string;
}

const NOTE_PREVIEW_LIMIT = 100;

// 15-min time slots: 00:00 … 23:45
const TIME_SLOTS: { h: number; m: number; label: string }[] = Array.from(
  { length: 96 },
  (_, i) => {
    const h = Math.floor(i / 4);
    const m = (i % 4) * 15;
    return { h, m, label: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` };
  }
);

function vnNow(): { h: number; m: number } {
  const d = new Date(Date.now() + 7 * 60 * 60 * 1000); // UTC+7
  return { h: d.getUTCHours(), m: d.getUTCMinutes() };
}

function vnDateOffset(offset: number): string {
  const d = new Date(Date.now() + 7 * 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function availableSlots(dayOffset: number): typeof TIME_SLOTS {
  if (dayOffset > 0) return TIME_SLOTS;
  const { h, m } = vnNow();
  return TIME_SLOTS.filter((s) => s.h > h || (s.h === h && s.m > m));
}

function HeldNote({ note }: { note: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = note.length > NOTE_PREVIEW_LIMIT;
  return (
    <div className="rounded border border-amber-300 bg-amber-100/70 px-2 py-1">
      <span className="text-[11px] font-semibold text-amber-700">Ghi chú</span>
      {!isLong || expanded ? (
        <p className="mt-0.5 break-words font-medium text-amber-950">
          {note}
          {isLong && (
            <button type="button" onClick={() => setExpanded(false)} className="ml-1 font-semibold text-indigo-600 hover:text-indigo-800">
              Thu gọn
            </button>
          )}
        </p>
      ) : (
        <div className="mt-0.5 flex items-baseline gap-1 font-medium text-amber-950">
          <span className="min-w-0 truncate">{note}</span>
          <button type="button" onClick={() => setExpanded(true)} className="shrink-0 font-semibold text-indigo-600 hover:text-indigo-800">
            Xem thêm
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Lists note-held jobs. `held` is fed by the dashboard status poll (no polling
 * of its own). `onAssigned` removes the job immediately from the parent list;
 * `onRefresh` then confirms server state.
 */
export function NoteReviewPanel({
  held,
  env,
  onRefresh,
  onAssigned,
  embedded = false,
}: {
  held: HeldJob[];
  env: "prod" | "uat";
  onRefresh: () => void;
  onAssigned: (jobId: number) => void;
  // When true, render as a bare section (no Card) so it can sit inside the
  // unified "Cần xử lý" block alongside the unassignable + late sections.
  embedded?: boolean;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  // Per-job schedule state: dayOffset 0/1/2, selected time label "HH:MM" or null
  const [schedules, setSchedules] = useState<Record<number, { dayOffset: number; timeLabel: string | null }>>({});

  const getSched = (jobId: number) => schedules[jobId] ?? { dayOffset: 0, timeLabel: null };

  const patchSched = (jobId: number, patch: Partial<{ dayOffset: number; timeLabel: string | null }>) =>
    setSchedules((prev) => ({ ...prev, [jobId]: { ...getSched(jobId), ...patch } }));

  const handleDayOffset = (jobId: number, offset: number) => {
    const { timeLabel } = getSched(jobId);
    // If switching back to today and the selected time is now in the past, clear it.
    if (offset === 0 && timeLabel) {
      const [hStr, mStr] = timeLabel.split(":");
      const now = vnNow();
      if (parseInt(hStr) < now.h || (parseInt(hStr) === now.h && parseInt(mStr) <= now.m)) {
        patchSched(jobId, { dayOffset: 0, timeLabel: null });
        return;
      }
    }
    patchSched(jobId, { dayOffset: offset });
  };

  const assignAnyway = useCallback(
    async (job: HeldJob) => {
      if (!window.confirm(`Duyệt giao Job ${job.job_id} dù có ghi chú?\nHệ thống sẽ tự giao ở chu kỳ kế tiếp.\n\n"${job.note}"`)) return;
      setBusyId(job.job_id);
      // Stamps the approved mark on the note (a quick Cartrack edit) — the next
      // cron cycle does the assignment. No cycle lock, so no 409/retry queue.
      try {
        const res = await fetch(`/api/assign/held?env=${env}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: job.job_id }),
        });
        const data = await res.json();
        if (data.ok || data.approved) {
          toast.success(`Đã duyệt Job ${job.job_id} — sẽ giao ở chu kỳ kế tiếp`);
          onAssigned(job.job_id);
        } else {
          toast.error(data.error ?? `Không duyệt được Job ${job.job_id}`);
        }
      } catch {
        toast.error(`Không duyệt được Job ${job.job_id}`);
      } finally {
        setBusyId(null);
        onRefresh();
      }
    },
    [env, onRefresh, onAssigned],
  );

  if (held.length === 0) return null;

  const rows = held.map((job) => {
          const { dayOffset, timeLabel } = getSched(job.job_id);
          const isBusy = busyId === job.job_id;
          const slots = availableSlots(dayOffset);

          const scheduleJob = async () => {
            if (!timeLabel) return;
            const scheduledAt = `${vnDateOffset(dayOffset)} ${timeLabel}:00`;
            setBusyId(job.job_id);
            try {
              const res = await fetch(`/api/assign/held?env=${env}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jobId: job.job_id, scheduledAt }),
              });
              const data = await res.json();
              if (data.ok) {
                toast.success(`Đang lên lịch Job ${job.job_id} lúc ${timeLabel}…`);
                onAssigned(job.job_id);
              } else {
                toast.error(data.error ?? `Không lên lịch được Job ${job.job_id}`);
              }
            } catch {
              toast.error("Lỗi kết nối, vui lòng thử lại");
            } finally {
              setBusyId(null);
              onRefresh();
            }
          };

          return (
            <div
              key={job.job_id}
              className={`space-y-1 text-xs border rounded px-2 py-1.5 ${
                job.error ? "bg-red-50 border-red-300" : "bg-orange-50 border-orange-200"
              }`}
            >
              {/* Header */}
              <div className="font-medium">
                <a
                  href={`https://fleetweb-vn.cartrack.com/delivery/map?job=${job.job_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-indigo-600 hover:text-indigo-800"
                >
                  Job {job.job_id}
                </a>
                {" · "}
                {job.customer}
              </div>

              {job.error && (
                <div className="rounded border border-red-300 bg-red-100/70 px-2 py-1 text-[11px] font-semibold text-red-800">
                  ⚠ {job.error} — vui lòng thử lại
                </div>
              )}

              <HeldNote note={job.note} />

              {/* Schedule + actions on one row: date chips + time dropdown, then
                  the two buttons pushed right. Wraps gracefully when narrow. */}
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-[11px] font-semibold text-slate-600">Hẹn</span>
                {[0, 1, 2].map((offset) => (
                  <button
                    key={offset}
                    type="button"
                    onClick={() => handleDayOffset(job.job_id, offset)}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
                      dayOffset === offset
                        ? "bg-indigo-600 text-white"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    {offset === 0 ? "Hôm nay" : `+${offset}`}
                  </button>
                ))}
                <select
                  value={timeLabel ?? ""}
                  onChange={(e) => patchSched(job.job_id, { timeLabel: e.target.value || null })}
                  className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-indigo-400"
                >
                  <option value="">-- giờ --</option>
                  {slots.map((s) => (
                    <option key={s.label} value={s.label}>{s.label}</option>
                  ))}
                </select>
                <div className="ml-auto flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[11px] px-2 disabled:opacity-40"
                    disabled={isBusy || !!timeLabel}
                    onClick={() => assignAnyway(job)}
                  >
                    {isBusy ? "Đang xử lý…" : "Giao ngay"}
                  </Button>
                  <Button
                    size="sm"
                    className="h-6 text-[11px] px-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40"
                    disabled={isBusy || !timeLabel}
                    onClick={scheduleJob}
                  >
                    {isBusy ? "Đang xử lý…" : "Lên lịch"}
                  </Button>
                </div>
              </div>
            </div>
          );
  });

  const header = (
    <div className="flex items-center gap-1.5 pt-1">
      <StickyNote className="size-3.5 text-orange-600" strokeWidth={2} />
      <span className="text-xs font-semibold text-orange-700">Tasks có ghi chú</span>
      <span className="text-xs tabular-nums text-slate-400">{held.length}</span>
    </div>
  );

  // Embedded (Cần xử lý tab): note tasks are interactive scheduling forms, so
  // they stay as full-width stacked cards (not a grid) — one focus per row.
  if (embedded)
    return (
      <div className="space-y-1.5">
        {header}
        <div className="space-y-1.5">{rows}</div>
      </div>
    );

  return (
    <Card className="py-4 border-orange-300">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <StickyNote className="size-4 text-orange-600" strokeWidth={2} />
          Chờ duyệt ghi chú
          <span className="text-orange-600 font-semibold">{held.length}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">{rows}</CardContent>
    </Card>
  );
}
