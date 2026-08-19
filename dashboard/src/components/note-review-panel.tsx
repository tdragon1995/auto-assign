"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Clock, StickyNote, UserRoundCog } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { DriverPicker } from "./driver-picker";
import { DayTimePicker, DAY_LABELS, vnNowLabel, vnDateOffset } from "./day-time-picker";
import type { ConfigDriver } from "@/lib/types";

export interface HeldJob {
  job_id: number;
  customer: string;
  note: string;
  /** Present when a background approve/schedule failed and the job was put back. */
  error?: string;
  /** Who "Giao ngay" would hand the job to. Set only for fixed-path jobs, where
   *  the driver is a roster lookup and therefore the same answer at assign time.
   *  Smart jobs leave it unset — their driver is ranked live, so a name shown
   *  now could be wrong by the next cycle. Resolved to a name against `drivers`. */
  driver_id?: string;
  /** Name when the engine already knows one (a substitute); usually absent. */
  driver_name?: string;
  /** The on-leave driver being covered for, when the pick is a substitute. */
  sub_for?: string;
}

const NOTE_PREVIEW_LIMIT = 100;

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
 * `onRefresh` then confirms server state. `onManualAssign` is the third way out
 * of the queue — a direct Cartrack assign to a chosen driver, owned by the
 * parent (it needs its own optimistic-hide window).
 */
export function NoteReviewPanel({
  held,
  env,
  onRefresh,
  onAssigned,
  drivers,
  onManualAssign,
  embedded = false,
}: {
  held: HeldJob[];
  env: "prod" | "uat";
  onRefresh: () => void;
  onAssigned: (jobId: number) => void;
  drivers: ConfigDriver[];
  onManualAssign: (job: HeldJob, driverId: string) => void;
  // When true, render as a bare section (no Card) so it can sit inside the
  // unified "Cần xử lý" block alongside the unassignable + late sections.
  embedded?: boolean;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  // Which row has its scheduler open. Only one at a time — the queue is cleared
  // one job per focus, and a single open panel keeps the list scannable.
  const [openId, setOpenId] = useState<number | null>(null);
  // Which row has its driver picker open. Same one-at-a-time rule, and mutually
  // exclusive with the scheduler above: "hẹn giờ" and "chọn tài xế" are two
  // different answers to the same job, so only one form is ever on screen.
  const [pickId, setPickId] = useState<number | null>(null);
  // Move focus to the revealed time input when a scheduler opens, so keyboard
  // and screen-reader users land on the next action instead of nowhere.
  const openTimeRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => {
    if (openId != null) openTimeRef.current?.focus();
  }, [openId]);
  // Per-job schedule state: dayOffset 0/1/2, selected time "HH:MM" or null.
  const [schedules, setSchedules] = useState<Record<number, { dayOffset: number; timeLabel: string | null }>>({});
  // Bulk selection + shared scheduler for clearing several look-alike jobs at once.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkSched, setBulkSched] = useState<{ dayOffset: number; timeLabel: string | null }>({ dayOffset: 0, timeLabel: null });
  const [bulkBusy, setBulkBusy] = useState(false);

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

  // ── Bulk selection helpers ──────────────────────────────────────────────
  const selectedIds = held.filter((j) => selected.has(j.job_id)).map((j) => j.job_id);
  const selectedCount = selectedIds.length;
  const allSelected = held.length > 0 && held.every((j) => selected.has(j.job_id));
  const someSelected = selectedCount > 0 && !allSelected;

  const toggleSelect = (jobId: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });

  const toggleSelectAll = () =>
    setSelected(allSelected ? new Set() : new Set(held.map((j) => j.job_id)));

  const clearSelection = () => {
    setSelected(new Set());
    setBulkOpen(false);
    setBulkSched({ dayOffset: 0, timeLabel: null });
  };

  const bulkTimeIsPast = bulkSched.dayOffset === 0 && !!bulkSched.timeLabel && bulkSched.timeLabel <= vnNowLabel();
  const bulkCanSchedule = !!bulkSched.timeLabel && !bulkTimeIsPast;

  const bulkDayOffset = (offset: number) => {
    if (offset === 0 && bulkSched.timeLabel && bulkSched.timeLabel <= vnNowLabel()) {
      setBulkSched({ dayOffset: 0, timeLabel: null });
      return;
    }
    setBulkSched((s) => ({ ...s, dayOffset: offset }));
  };

  const runBulk = async (body: (id: number) => Record<string, unknown>, verb: string) => {
    if (selectedCount === 0) return;
    const ids = [...selectedIds];
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(
        ids.map((id) =>
          fetch(`/api/assign/held?env=${env}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body(id)),
          }).then((r) => r.json()),
        ),
      );
      let ok = 0;
      results.forEach((res, i) => {
        if (res.status === "fulfilled" && (res.value?.ok || res.value?.approved)) {
          ok++;
          onAssigned(ids[i]);
        }
      });
      if (ok > 0) toast.success(`${verb} ${ok}/${ids.length} việc`);
      if (ok < ids.length) toast.error(`${ids.length - ok} việc chưa xử lý được`);
    } catch {
      toast.error("Lỗi kết nối, vui lòng thử lại");
    } finally {
      setBulkBusy(false);
      clearSelection();
      onRefresh();
    }
  };

  const bulkAssignNow = async () => {
    if (!window.confirm(`Duyệt giao ${selectedCount} việc dù có ghi chú?\nHệ thống sẽ tự giao ở chu kỳ kế tiếp.`)) return;
    await runBulk((id) => ({ jobId: id }), "Đã duyệt");
  };

  const bulkSchedule = async () => {
    if (!bulkCanSchedule || !bulkSched.timeLabel) return;
    const scheduledAt = `${vnDateOffset(bulkSched.dayOffset)} ${bulkSched.timeLabel}:00`;
    await runBulk((id) => ({ jobId: id, scheduledAt }), `Đang lên lịch ${DAY_LABELS[bulkSched.dayOffset]} ${bulkSched.timeLabel} —`);
  };

  if (held.length === 0) return null;

  const rows = held.map((job) => {
    const { dayOffset, timeLabel } = getSched(job.job_id);
    const isBusy = busyId === job.job_id;
    const isOpen = openId === job.job_id;
    const isPicking = pickId === job.job_id;
    const isSelected = selected.has(job.job_id);
    // Driver tab first (the mapping sheet carries no names), then anything the
    // engine already named. Neither → render no line at all.
    const previewName =
      (job.driver_id && drivers.find((d) => d.driver_id === job.driver_id)?.name) ||
      job.driver_name ||
      null;
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

    const assignAnyway = async () => {
      if (!window.confirm(`Duyệt giao Job ${job.job_id} dù có ghi chú?\nHệ thống sẽ tự giao ở chu kỳ kế tiếp.\n\n"${job.note}"`)) return;
      setBusyId(job.job_id);
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
    };

    return (
      <div
        key={job.job_id}
        className={`space-y-1.5 rounded-md border px-2.5 py-2 ${
          job.error
            ? "border-red-300 bg-red-50"
            : isSelected
              ? "border-indigo-300 bg-indigo-50/40"
              : "border-orange-200 bg-orange-50"
        }`}
      >
        {/* Header — a select checkbox, then customer-led text (customer is what
            tells the rows apart); the Job link is a quiet secondary line. */}
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => toggleSelect(job.job_id)}
            aria-label={`Chọn Job ${job.job_id}`}
            className="mt-0.5 size-4 shrink-0 accent-indigo-600"
          />
          <div className="min-w-0 flex-1 space-y-0.5">
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
        </div>

        {job.error && (
          <div className="flex items-center gap-1.5 rounded border border-red-300 bg-red-100/70 px-2 py-1 text-[11px] font-semibold text-red-800">
            <AlertTriangle className="size-3.5 shrink-0" strokeWidth={2} />
            {job.error} — vui lòng thử lại
          </div>
        )}

        <HeldNote note={job.note} />

        {/* Who "Giao ngay" lands on. Only fixed-path jobs carry a driver (the
            engine omits it for smart jobs, whose driver isn't chosen until assign
            time), so the line is simply absent rather than hedged when unknown.
            Name comes from the Driver tab; if the id resolves to nothing we show
            nothing rather than a UUID. */}
        {previewName && (
          <p className="text-[11px] text-slate-600">
            Giao ngay <span className="text-slate-400">→</span>{" "}
            <span className="font-semibold text-slate-900">{previewName}</span>
            {job.sub_for && <span className="text-slate-600"> (thay {job.sub_for})</span>}
          </p>
        )}

        {/* Three explicit choices; the scheduler and the driver picker are
            revealed only on demand, so "now vs later vs this driver" is never a
            hidden button-disabled mode. */}
        {!isOpen && !isPicking ? (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Button size="sm" variant="outline" className="text-xs" disabled={isBusy} onClick={assignAnyway}>
              {isBusy ? "Đang xử lý…" : "Giao ngay"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-xs"
              disabled={isBusy}
              onClick={() => {
                if (!schedules[job.job_id]) patchSched(job.job_id, { dayOffset: 0, timeLabel: null });
                setPickId(null);
                setOpenId(job.job_id);
              }}
            >
              <Clock className="size-3.5" strokeWidth={2} />
              Hẹn giờ
            </Button>
            {/* Skips the engine entirely: "Giao ngay" hands the job back for the
                next cycle to route, this names the driver here and now. */}
            <Button
              size="sm"
              variant="outline"
              className="text-xs"
              disabled={isBusy}
              onClick={() => {
                setOpenId(null);
                setPickId(job.job_id);
              }}
            >
              <UserRoundCog className="size-3.5" strokeWidth={2} />
              Chọn tài xế
            </Button>
          </div>
        ) : isPicking ? (
          <div className="animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none space-y-1 rounded-md border border-indigo-200 bg-indigo-50/50 px-2 py-2">
            <span className="text-xs font-semibold text-slate-700">Giao thẳng cho tài xế</span>
            <DriverPicker
              drivers={drivers}
              onConfirm={(driverId) => {
                setPickId(null);
                onManualAssign(job, driverId);
              }}
              onCancel={() => setPickId(null)}
            />
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
            <DayTimePicker
              dayOffset={dayOffset}
              timeLabel={timeLabel}
              timeIsPast={timeIsPast}
              onDay={(offset) => handleDayOffset(job.job_id, offset)}
              onTime={(label) => patchSched(job.job_id, { timeLabel: label })}
              warnId={`time-warn-${job.job_id}`}
              inputRef={openTimeRef}
            />
            {timeIsPast && (
              <p id={`time-warn-${job.job_id}`} role="alert" className="text-[11px] font-medium text-red-600">
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

  // Bulk toolbar — only meaningful with ≥2 jobs. A single select-all checkbox
  // that grows into bulk actions once anything is picked.
  const toolbar = held.length >= 2 && (
    <div
      className={`space-y-2 rounded-md border px-2.5 py-1.5 ${
        selectedCount > 0 ? "border-indigo-300 bg-indigo-50" : "border-slate-200 bg-slate-50"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = someSelected;
          }}
          onChange={toggleSelectAll}
          aria-label="Chọn tất cả"
          className="size-4 shrink-0 accent-indigo-600"
        />
        {selectedCount > 0 ? (
          <>
            <span className="font-semibold text-indigo-900">Đã chọn {selectedCount}</span>
            <button
              type="button"
              onClick={clearSelection}
              className="rounded px-1 text-[11px] font-medium text-slate-500 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
            >
              Bỏ chọn
            </button>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" className="text-xs" disabled={bulkBusy} onClick={bulkAssignNow}>
                {bulkBusy ? "Đang xử lý…" : "Giao ngay"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-xs"
                disabled={bulkBusy}
                aria-expanded={bulkOpen}
                onClick={() => setBulkOpen((o) => !o)}
              >
                <Clock className="size-3.5" strokeWidth={2} />
                Hẹn giờ
              </Button>
            </div>
          </>
        ) : (
          <span className="text-slate-500">Chọn để xử lý nhiều việc cùng lúc</span>
        )}
      </div>

      {selectedCount > 0 && bulkOpen && (
        <div className="animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none space-y-2 border-t border-indigo-200 pt-2">
          <span className="text-xs font-semibold text-slate-700">
            Hẹn {selectedCount} việc lúc
          </span>
          <DayTimePicker
            dayOffset={bulkSched.dayOffset}
            timeLabel={bulkSched.timeLabel}
            timeIsPast={bulkTimeIsPast}
            onDay={bulkDayOffset}
            onTime={(label) => setBulkSched((s) => ({ ...s, timeLabel: label }))}
            warnId="bulk-time-warn"
          />
          {bulkTimeIsPast && (
            <p id="bulk-time-warn" role="alert" className="text-[11px] font-medium text-red-600">
              Giờ đã qua — chọn sau {vnNowLabel()} hoặc đổi sang ngày mai.
            </p>
          )}
          <div className="flex justify-end">
            <Button
              size="sm"
              className="bg-indigo-600 text-xs hover:bg-indigo-700"
              disabled={bulkBusy || !bulkCanSchedule}
              onClick={bulkSchedule}
            >
              {bulkBusy
                ? "Đang xử lý…"
                : bulkSched.timeLabel
                  ? `Lên lịch ${selectedCount} việc · ${DAY_LABELS[bulkSched.dayOffset]} ${bulkSched.timeLabel}`
                  : "Chọn giờ để lên lịch"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );

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
        {toolbar}
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
      <CardContent className="space-y-2">
        {toolbar}
        {rows}
      </CardContent>
    </Card>
  );
}
