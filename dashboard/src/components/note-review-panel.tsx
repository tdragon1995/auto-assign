"use client";

import { useCallback, useState } from "react";
import { AlertTriangle, Clock, StickyNote } from "lucide-react";
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

const DAY_LABELS = ["Hôm nay", "Ngày mai", "Ngày mốt"] as const;

function vnNow(): { h: number; m: number } {
  const d = new Date(Date.now() + 7 * 60 * 60 * 1000); // UTC+7
  return { h: d.getUTCHours(), m: d.getUTCMinutes() };
}

/** Current VN wall-clock as "HH:MM" — used as the min for a same-day time pick. */
function vnNowLabel(): string {
  const { h, m } = vnNow();
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function vnDateOffset(offset: number): string {
  const d = new Date(Date.now() + 7 * 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function HeldNote({ note }: { note: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = note.length > NOTE_PREVIEW_LIMIT;
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-800">Ghi chú</span>
      {!isLong || expanded ? (
        <p className="mt-0.5 break-words text-[13px] leading-snug text-amber-950">
          {note}
          {isLong && (
            <button type="button" onClick={() => setExpanded(false)} className="ml-1 font-semibold text-indigo-600 hover:text-indigo-800">
              Thu gọn
            </button>
          )}
        </p>
      ) : (
        <div className="mt-0.5 flex items-baseline gap-1 text-[13px] leading-snug text-amber-950">
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
  // Which row has its scheduler open. Only one at a time — the queue is cleared
  // one job per focus, and a single open panel keeps the list scannable.
  const [openId, setOpenId] = useState<number | null>(null);
  // Per-job schedule state: dayOffset 0/1/2, selected time "HH:MM" or null.
  const [schedules, setSchedules] = useState<Record<number, { dayOffset: number; timeLabel: string | null }>>({});

  const getSched = (jobId: number) => schedules[jobId] ?? { dayOffset: 0, timeLabel: null };

  const patchSched = (jobId: number, patch: Partial<{ dayOffset: number; timeLabel: string | null }>) =>
    setSchedules((prev) => ({ ...prev, [jobId]: { ...getSched(jobId), ...patch } }));

  const handleDayOffset = (jobId: number, offset: number) => {
    const { timeLabel } = getSched(jobId);
    // Switching back to today with a now-past time selected: clear it.
    if (offset === 0 && timeLabel && timeLabel <= vnNowLabel()) {
      patchSched(jobId, { dayOffset: 0, timeLabel: null });
      return;
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
    const isOpen = openId === job.job_id;
    const timeIsPast = dayOffset === 0 && !!timeLabel && timeLabel <= vnNowLabel();
    const canSchedule = !!timeLabel && !timeIsPast;

    const scheduleJob = async () => {
      if (!canSchedule || !timeLabel) return;
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
          toast.success(`Đang lên lịch Job ${job.job_id} — ${DAY_LABELS[dayOffset]} ${timeLabel}…`);
          setOpenId(null);
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
        className={`space-y-1.5 rounded-md border px-2.5 py-2 ${
          job.error ? "border-red-300 bg-red-50" : "border-orange-200 bg-orange-50"
        }`}
      >
        {/* Header — customer leads (it's what tells the rows apart); the Job
            link is demoted to a quiet secondary line. */}
        <div className="space-y-0.5">
          <div className="text-sm font-semibold leading-snug text-slate-800 break-words">
            {job.customer}
          </div>
          <a
            href={`https://fleetweb-vn.cartrack.com/delivery/map?job=${job.job_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-[11px] font-medium text-slate-500 hover:text-indigo-700 hover:underline"
          >
            Job {job.job_id} · mở bản đồ ↗
          </a>
        </div>

        {job.error && (
          <div className="flex items-center gap-1.5 rounded border border-red-300 bg-red-100/70 px-2 py-1 text-[11px] font-semibold text-red-800">
            <AlertTriangle className="size-3.5 shrink-0" strokeWidth={2} />
            {job.error} — vui lòng thử lại
          </div>
        )}

        <HeldNote note={job.note} />

        {/* Two explicit choices; scheduling is revealed only on demand so the
            "now vs later" decision is never a hidden button-disabled mode. */}
        {!isOpen ? (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Button
              size="sm"
              variant="outline"
              className="text-xs"
              disabled={isBusy}
              onClick={() => assignAnyway(job)}
            >
              {isBusy ? "Đang xử lý…" : "Giao ngay"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-xs"
              disabled={isBusy}
              onClick={() => {
                if (!schedules[job.job_id]) patchSched(job.job_id, { dayOffset: 0, timeLabel: null });
                setOpenId(job.job_id);
              }}
            >
              <Clock className="size-3.5" strokeWidth={2} />
              Hẹn giờ
            </Button>
          </div>
        ) : (
          <div className="animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none space-y-2 rounded-md border border-indigo-200 bg-indigo-50/50 px-2 py-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">Hẹn giao lúc</span>
              <button
                type="button"
                onClick={() => setOpenId(null)}
                className="rounded px-1 text-xs font-medium text-slate-500 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
              >
                Hủy
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {[0, 1, 2].map((offset) => (
                <button
                  key={offset}
                  type="button"
                  onClick={() => handleDayOffset(job.job_id, offset)}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50 ${
                    dayOffset === offset
                      ? "bg-indigo-600 text-white"
                      : "bg-white text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-100"
                  }`}
                >
                  {DAY_LABELS[offset]}
                </button>
              ))}
              <input
                type="time"
                step={900}
                aria-label="Giờ giao"
                min={dayOffset === 0 ? vnNowLabel() : undefined}
                value={timeLabel ?? ""}
                onChange={(e) => patchSched(job.job_id, { timeLabel: e.target.value || null })}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs tabular-nums focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/40"
              />
            </div>
            {timeIsPast && (
              <p className="text-[11px] font-medium text-red-600">
                Giờ đã qua — chọn sau {vnNowLabel()} hoặc đổi sang ngày mai.
              </p>
            )}
            <div className="flex justify-end">
              <Button
                size="sm"
                className="bg-indigo-600 text-xs hover:bg-indigo-700"
                disabled={isBusy || !canSchedule}
                onClick={scheduleJob}
              >
                {isBusy
                  ? "Đang xử lý…"
                  : timeLabel
                    ? `Lên lịch ${DAY_LABELS[dayOffset]} ${timeLabel}`
                    : "Chọn giờ để lên lịch"}
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  });

  const header = (
    <div className="flex items-center gap-1.5 pt-1">
      <StickyNote className="size-3.5 text-orange-600" strokeWidth={2} />
      <span className="text-xs font-semibold text-orange-700">Việc có ghi chú</span>
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
