"use client";

import type { Ref } from "react";

/**
 * Day-chip + 30-minute time chooser, shared by every "hẹn giờ" flow in the
 * "Cần xử lý" tab (note-held jobs and unconfigured-customer jobs). Fully
 * controlled — the parent owns `dayOffset` / `timeLabel` and decides what the
 * chosen slot means.
 */

export const DAY_LABELS = ["Hôm nay", "Ngày mai", "Ngày mốt"] as const;

function vnNow(): { h: number; m: number } {
  const d = new Date(Date.now() + 7 * 60 * 60 * 1000); // UTC+7
  return { h: d.getUTCHours(), m: d.getUTCMinutes() };
}

/** Current VN wall-clock as "HH:MM" — the floor for a same-day time pick. */
export function vnNowLabel(): string {
  const { h, m } = vnNow();
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function vnDateOffset(offset: number): string {
  const d = new Date(Date.now() + 7 * 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD HH:MM:SS" for the picked day + slot — the `scheduledAt` the
 *  /api/assign/held POST expects. */
export function scheduledAtFor(dayOffset: number, timeLabel: string): string {
  return `${vnDateOffset(dayOffset)} ${timeLabel}:00`;
}

/** A same-day pick that has already gone by can't be scheduled. */
export function isTimePast(dayOffset: number, timeLabel: string | null): boolean {
  return dayOffset === 0 && !!timeLabel && timeLabel <= vnNowLabel();
}

// Schedule times are offered on a 30-minute grid via an explicit dropdown. A
// native <input type=time step=1800> ignores the step in its clock popup and
// still lists every minute, so our own option list is the only way to actually
// show 30-min slots. A native <select> also renders its menu at the OS level,
// so it's never clipped by an overflow container.
const TIME_SLOTS_30: string[] = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2);
  const m = (i % 2) * 30;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
});

/** 30-min slots for a day. Today drops past slots but keeps the current
 *  selection visible even if it just went by. */
function availableSlots(dayOffset: number, selected: string | null): string[] {
  if (dayOffset > 0) return TIME_SLOTS_30;
  const now = vnNowLabel();
  return TIME_SLOTS_30.filter((s) => s > now || s === selected);
}

export function DayTimePicker({
  dayOffset,
  timeLabel,
  timeIsPast,
  onDay,
  onTime,
  warnId,
  inputRef,
}: {
  dayOffset: number;
  timeLabel: string | null;
  timeIsPast: boolean;
  onDay: (offset: number) => void;
  onTime: (label: string | null) => void;
  warnId: string;
  inputRef?: Ref<HTMLSelectElement>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {[0, 1, 2].map((offset) => (
        <button
          key={offset}
          type="button"
          onClick={() => onDay(offset)}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50 ${
            dayOffset === offset
              ? "bg-indigo-600 text-white"
              : "bg-white text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-100"
          }`}
        >
          {DAY_LABELS[offset]}
        </button>
      ))}
      <select
        ref={inputRef}
        aria-label="Giờ giao"
        aria-invalid={timeIsPast || undefined}
        aria-describedby={timeIsPast ? warnId : undefined}
        value={timeLabel ?? ""}
        onChange={(e) => onTime(e.target.value || null)}
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs tabular-nums focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/40 aria-invalid:border-red-400 aria-invalid:focus:ring-red-400/40"
      >
        <option value="">-- giờ --</option>
        {availableSlots(dayOffset, timeLabel).map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </div>
  );
}
