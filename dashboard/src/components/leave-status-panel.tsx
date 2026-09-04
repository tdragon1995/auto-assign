"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Palmtree } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "./section-header";
import { toast } from "sonner";
import type { LeaveOnDate, InvalidLeaveRow, SpanningLeaveRow } from "@/lib/leave-config";
import type { LeaveSuppression } from "@/lib/leave-suppression";
import type { ConfigDriver } from "@/lib/types";
import { addDays, vnDate } from "@/lib/time";
import { splitDriverName, compareDriverNames, compareByDriverThenWindow } from "@/lib/driver-label";
import { DriverName } from "./driver-name";

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


interface LeaveRowView {
  timeLabel: string | null;
  subs: LeaveOnDate["subs"];
  leave_from: string;
  duplicate: boolean;
}

/** One card per driver: same-driver entries (split-shift coverage) merge into
 *  window rows so a two-window day doesn't read as a duplicate listing. */
interface DriverGroup {
  driver_id: string;
  driver_name: string;
  loai_nghi: string;
  leave_from: string;
  rows: LeaveRowView[];
}

function groupByDriver(drivers: LeaveOnDate[]): DriverGroup[] {
  const map = new Map<string, DriverGroup>();
  for (const d of drivers) {
    const g = map.get(d.driver_id);
    const row = { timeLabel: d.timeLabel, subs: d.subs, leave_from: d.leave_from, duplicate: d.duplicate };
    if (!g) {
      map.set(d.driver_id, {
        driver_id: d.driver_id,
        driver_name: d.driver_name,
        loai_nghi: d.loai_nghi,
        leave_from: d.leave_from,
        rows: [row],
      });
    } else {
      // "Nghỉ việc" outranks day-leave labels for the card chip.
      if (d.loai_nghi === "Nghỉ việc") g.loai_nghi = d.loai_nghi;
      g.rows.push(row);
    }
  }
  // By the person, not by the label: the label leads with employment type and
  // area, so raw sheet order buries the name being looked for. Sorting on the
  // name also lands a driver's full-time and part-time accounts side by side —
  // both are off on the same day now that the MISA sync files the twin too.
  // Each driver's own windows are ordered morning-first below.
  for (const g of map.values()) {
    g.rows.sort((a, b) => (a.timeLabel ?? "").localeCompare(b.timeLabel ?? ""));
  }
  return [...map.values()].sort((a, b) => compareDriverNames(a.driver_name, b.driver_name));
}

interface SubBlock {
  name: string;
  from: string;
  to: string;
}

/** 30-minute grid, 05:00–22:00 — the same slots the driver's leave form offers
 *  (cham-cong TIME_SLOTS), so a substitute window lines up with the leave window
 *  it covers instead of landing on an arbitrary minute. */
const TIME_SLOTS: string[] = (() => {
  const slots: string[] = [];
  for (let h = 5; h <= 22; h++) {
    for (let m = 0; m < 60; m += 30) {
      if (h === 22 && m > 0) break;
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return slots;
})();

/** Half-hour picker. Leave windows are typed into the sheet by hand and aren't
 *  always on the half hour, so a prefilled off-grid value (from "+ Chia ca")
 *  is kept as an extra option — otherwise the select would render blank while
 *  still holding that time, and the supervisor couldn't see what they'd save. */
function TimeSelect({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  const options = value && !TIME_SLOTS.includes(value) ? [...TIME_SLOTS, value].sort() : TIME_SLOTS;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className="rounded border border-slate-300 bg-white px-1 py-1 text-xs"
    >
      <option value="">--:--</option>
      {options.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

const SUB_NAMES_LIST_ID = "leave-sub-names";

/** The driver-name options a sub input autocompletes against. Rendered once per
 *  place the editor can appear — two <datalist>s cannot share an id. */
function SubNamesDatalist({ id, drivers }: { id: string; drivers: ConfigDriver[] }) {
  return (
    <datalist id={id}>
      {drivers.map((d) => (
        <option key={d.driver_id} value={d.name} />
      ))}
    </datalist>
  );
}

/** Write substitutes back to the Leave sheet. Shared so the "Cần xử lý" section
 *  and the reference panel below it save through exactly one path. */
function makeFillSubs(onRefresh: () => void): FillSubsFn {
  return async (identity, subs) => {
    try {
      const res = await fetch("/api/leave-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...identity, subs }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? `HTTP ${res.status}`);
        return false;
      }
      if (data.warning) toast.warning(data.warning);
      else toast.success("Đã lưu người thay vào sheet");
      onRefresh();
      return true;
    } catch (e) {
      toast.error(`Không lưu được: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };
}

export type FillSubsFn = (
  identity: { driver_id: string; leave_from: string; timeLabel: string | null },
  subs: { name: string; from: string | null; to: string | null }[],
) => Promise<boolean>;

/** The identity of one leave row, as the sheet writers re-resolve it: driver +
 *  start date + window. Never a row number — the sheet moves under us. */
export type LeaveRowIdentity = {
  driver_id: string;
  leave_from: string;
  timeLabel: string | null;
};

export type DeleteRowFn = (identity: LeaveRowIdentity) => Promise<boolean>;

/** "2026-09-04" → "04/09"; a range collapses to one date when both ends match. */
function rangeLabel(from: string, to: string | null): string {
  return !to || to === from ? ddmm(from) : `${ddmm(from)}–${ddmm(to)}`;
}

/** Delete one leave row from the sheet. Shared by the "Cần xử lý" list and the
 *  reference panel, exactly as makeFillSubs is, so both go through one path. */
function makeDeleteRow(onRefresh: () => void): DeleteRowFn {
  return async (identity) => {
    try {
      const res = await fetch("/api/leave-status", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(identity),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? `HTTP ${res.status}`);
        return false;
      }
      const d = data.deleted ?? {};
      // Name the dates that actually went. A hand-typed row can span several
      // days, and deleting it removes all of them — the supervisor should see
      // that immediately, not discover it tomorrow.
      toast.success(
        `Đã xoá dòng nghỉ ${rangeLabel(d.leave_from ?? identity.leave_from, d.leave_to ?? null)}` +
          (d.remaining > 0 ? ` — còn ${d.remaining} dòng trùng` : ""),
      );
      onRefresh();
      return true;
    } catch (e) {
      toast.error(`Không xoá được: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };
}

/**
 * Two-click delete for one leave row.
 *
 * Armed state rather than a window.confirm: this sits inside a list that
 * refreshes under the pointer, and a native dialog on a phone is the one place
 * a supervisor cannot see WHICH row they are about to remove. The armed button
 * names the row it belongs to and disarms on a second thought.
 */
function DeleteRowButton({
  identity,
  onDelete,
}: {
  identity: LeaveRowIdentity;
  onDelete: DeleteRowFn;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        title="Xoá dòng nghỉ này khỏi sheet (đơn MISA bị duyệt một phần, dòng trùng…)"
        className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] text-slate-500 hover:border-red-300 hover:bg-red-50 hover:text-red-700"
      >
        Xoá
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-[11px] font-semibold text-red-700">Xoá dòng này?</span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const ok = await onDelete(identity);
          setBusy(false);
          if (!ok) setArmed(false);
        }}
        className="rounded border border-red-500 bg-red-600 px-1.5 py-0.5 text-[11px] font-semibold text-white hover:bg-red-700 disabled:opacity-60"
      >
        {busy ? "Đang xoá…" : "Xoá"}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setArmed(false)}
        className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
      >
        Hủy
      </button>
    </span>
  );
}

/**
 * Inline editor for filling substitutes on an uncovered leave row. One block =
 * one sub; "+ Chia ca" splits coverage into up to 3 blocks, each with its own
 * HH:MM window (required once there's more than one block — an open window
 * would cover the whole day and clash with the others). A single block may
 * leave the window blank to inherit the leave's own hours.
 */
function SubEditor({
  row,
  driverNames,
  onSave,
  onCancel,
  listId = SUB_NAMES_LIST_ID,
}: {
  row: LeaveRowView;
  driverNames: Set<string>;
  onSave: (subs: { name: string; from: string | null; to: string | null }[]) => Promise<boolean>;
  onCancel: () => void;
  /** Which <datalist> of driver names to bind the input to. The editor renders
   *  in two places now, and each owns its own list. */
  listId?: string;
}) {
  // Leave window bounds (for prefilling a split) — "06:30–15:00" → ["06:30","15:00"]
  const bounds = row.timeLabel ? row.timeLabel.split("–") : null;
  const [blocks, setBlocks] = useState<SubBlock[]>([{ name: "", from: "", to: "" }]);
  const [busy, setBusy] = useState(false);

  const patch = (i: number, p: Partial<SubBlock>) =>
    setBlocks((prev) => prev.map((b, j) => (j === i ? { ...b, ...p } : b)));

  const addBlock = () => {
    setBlocks((prev) => {
      if (prev.length >= 3) return prev;
      const next = [...prev];
      // Prefill the split edges from the leave window: first block starts at
      // the window start, new last block ends at the window end. The boundary
      // between them is the supervisor's call.
      if (bounds) {
        if (next.length === 1 && !next[0].from) next[0] = { ...next[0], from: bounds[0] };
        return [...next, { name: "", from: "", to: bounds[1] }];
      }
      return [...next, { name: "", from: "", to: "" }];
    });
  };

  const removeBlock = (i: number) =>
    setBlocks((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev));

  const save = async () => {
    for (const b of blocks) {
      if (!b.name.trim()) return toast.error("Chọn người thay từ danh sách");
      if (!driverNames.has(b.name.trim()))
        return toast.error(`"${b.name.trim()}" không có trong danh sách tài xế`);
      if (!!b.from !== !!b.to) return toast.error("Khung giờ thay phải đủ cả từ và đến");
      if (b.from && b.to && b.from >= b.to)
        return toast.error(`Khung giờ không hợp lệ: ${b.from}–${b.to}`);
    }
    if (blocks.length > 1) {
      if (blocks.some((b) => !b.from || !b.to))
        return toast.error("Nhiều người thay thì mỗi người cần khung giờ riêng");
      const sorted = [...blocks].sort((a, b) => a.from.localeCompare(b.from));
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].from < sorted[i - 1].to)
          return toast.error(
            `Khung giờ bị chồng: ${sorted[i - 1].from}–${sorted[i - 1].to} và ${sorted[i].from}–${sorted[i].to}`,
          );
      }
    }
    setBusy(true);
    const ok = await onSave(
      blocks.map((b) => ({ name: b.name.trim(), from: b.from || null, to: b.to || null })),
    );
    setBusy(false);
    if (ok) onCancel();
  };

  return (
    <div className="mt-1 space-y-1 rounded border border-slate-300 bg-white p-1.5">
      {blocks.map((b, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1">
          <input
            type="text"
            list={listId}
            placeholder="Tên người thay…"
            value={b.name}
            onChange={(e) => patch(i, { name: e.target.value })}
            className="min-w-[140px] flex-1 rounded border border-slate-300 px-1.5 py-1 text-xs"
          />
          <TimeSelect label="Từ giờ" value={b.from} onChange={(v) => patch(i, { from: v })} />
          <span className="text-slate-400 text-[11px]">→</span>
          <TimeSelect label="Đến giờ" value={b.to} onChange={(v) => patch(i, { to: v })} />
          {blocks.length > 1 && (
            <button
              type="button"
              onClick={() => removeBlock(i)}
              className="text-slate-400 hover:text-red-600 text-[11px] px-0.5"
              title="Bỏ dòng này"
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <div className="flex items-center gap-1">
        {blocks.length < 3 && (
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={addBlock} disabled={busy}>
            + Chia ca
          </Button>
        )}
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={onCancel} disabled={busy}>
            Hủy
          </Button>
          <Button
            size="sm"
            className="h-6 px-2 text-[11px] bg-indigo-600 hover:bg-indigo-700"
            onClick={save}
            disabled={busy}
          >
            {busy ? "Đang lưu…" : "Lưu"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** "HH:MM–HH:MM" for a suppression's window, or null for a whole day — the same
 *  label shape the leave rows use, so the same identity reaches the API. */
function suppressionTimeLabel(s: LeaveSuppression): string | null {
  return s.gio_bat_dau && s.gio_ket_thuc ? `${s.gio_bat_dau}–${s.gio_ket_thuc}` : null;
}

/**
 * One deliberately-removed day, with the way to put it back.
 *
 * The whole risk of a suppression list is that it outlives the reason for it and
 * nobody remembers it is there — so it is rendered while it can still block
 * anything, saying who, which day, and when it was removed. "Khôi phục" only
 * lifts the bar; the day itself returns at the next sync if MISA still charges
 * it, and stays gone if it does not. That is the correct answer either way, and
 * it is why this is a one-click action rather than a trip into the workbook.
 */
function SuppressionRow({ s, onRestore }: { s: LeaveSuppression; onRestore: DeleteRowFn }) {
  const [busy, setBusy] = useState(false);
  const label = suppressionTimeLabel(s);
  return (
    <li className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
      <DriverName full={s.driver_name || s.driver_id} className="font-semibold text-slate-900" />
      <span className="text-[11px] text-slate-600">{rangeLabel(s.leave_from, s.leave_to)}</span>
      {label && <span className="font-mono text-[11px] text-slate-500">{label}</span>}
      {s.deleted_at && (
        <span className="text-[11px] text-slate-500">xoá {s.deleted_at.slice(0, 16)}</span>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onRestore({ driver_id: s.driver_id, leave_from: s.leave_from, timeLabel: label });
          setBusy(false);
        }}
        className="ml-auto rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-slate-600 hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-60"
        title="Bỏ chặn ngày này — lần đồng bộ MISA tới sẽ tạo lại nếu MISA vẫn tính nghỉ"
      >
        {busy ? "…" : "Khôi phục"}
      </button>
    </li>
  );
}

/** Lift one suppression. Same shape as the other two writers so every path in
 *  this panel refreshes the same way. */
function makeRestoreRow(onRefresh: () => void): DeleteRowFn {
  return async (identity) => {
    try {
      const res = await fetch("/api/leave-status/suppression", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(identity),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? `HTTP ${res.status}`);
        return false;
      }
      toast.success("Đã bỏ chặn — lần đồng bộ MISA tới sẽ tạo lại nếu MISA vẫn tính nghỉ");
      onRefresh();
      return true;
    } catch (e) {
      toast.error(`Không khôi phục được: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };
}

/**
 * Severity signalling: an on-leave driver with NO substitute is the actionable
 * case (the engine will fail their jobs with "Nghỉ, không người thay"), so the
 * card goes amber, says so, and offers to fill the sub in place. Covered
 * drivers stay quiet with a green check. Resigned drivers (permanent — routing
 * needs a re-plan, not a sub) get a red chip plus their first day off.
 */
function DriverCard({
  g,
  driverNames,
  onFill,
  onDelete,
}: {
  g: DriverGroup;
  driverNames: Set<string>;
  onFill: FillSubsFn;
  onDelete: DeleteRowFn;
}) {
  const resigned = g.loai_nghi === "Nghỉ việc";
  const uncovered = !resigned && g.rows.some((r) => r.subs.length === 0);
  const [editRow, setEditRow] = useState<number | null>(null);
  // Leading dot carries state: red = resigned, amber = uncovered, grey = covered.
  const dotClass = resigned ? "bg-red-500" : uncovered ? "bg-amber-500" : "bg-slate-300";
  const typeClass = resigned ? "text-red-700" : "text-amber-700";
  return (
    <div className="px-2 py-1.5 text-xs hover:bg-slate-50">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`size-1.5 shrink-0 rounded-full ${dotClass}`} />
        <DriverName full={g.driver_name || g.driver_id} />
        <span className={`shrink-0 text-[11px] font-semibold ${typeClass}`}>
          {typeLabel(g.loai_nghi)}
        </span>
        {resigned && <span className="text-[11px] text-slate-500">từ {ddmm(g.leave_from)}</span>}
      </div>
      {/* Coverage rows: window → sub (sub shown by name only; the full sheet
          label is in the title attr). Wraps on mobile — nothing truncates. */}
      {!resigned &&
        g.rows.map((r, i) => (
          <div key={i}>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-xs">
              {r.timeLabel && <span className="font-mono text-slate-500">{r.timeLabel}</span>}
              {r.subs.length > 0 ? (
                <span
                  className="text-emerald-700 break-words"
                  title={`Thay: ${r.subs.map((s) => s.name || s.id).join(", ")}`}
                >
                  ✓ {r.subs.map((s) => splitDriverName(s.name || s.id).name).join(", ")}
                </span>
              ) : (
                <>
                  <span className="font-semibold text-amber-700">Chưa có người thay</span>
                  {editRow !== i && (
                    <button
                      type="button"
                      onClick={() => setEditRow(i)}
                      className="rounded border border-amber-400 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-amber-700 hover:bg-amber-100"
                    >
                      + Thêm
                    </button>
                  )}
                </>
              )}
              {r.duplicate && (
                <span
                  className="inline-flex items-center gap-1 rounded-full border border-orange-200 bg-orange-100 px-1.5 py-0 text-[11px] font-semibold text-orange-700"
                  title="Sheet có nhiều dòng nghỉ trùng cho tài xế này cùng khung giờ — xoá bớt dòng thừa để tránh nhầm lẫn."
                >
                  <AlertTriangle className="size-3" strokeWidth={2} />
                  Trùng dòng — dọn sheet
                </span>
              )}
              <span className="ml-auto shrink-0">
                <DeleteRowButton
                  identity={{ driver_id: g.driver_id, leave_from: r.leave_from, timeLabel: r.timeLabel }}
                  onDelete={onDelete}
                />
              </span>
            </div>
            {editRow === i && (
              <SubEditor
                row={r}
                driverNames={driverNames}
                onCancel={() => setEditRow(null)}
                onSave={(subs) =>
                  onFill(
                    { driver_id: g.driver_id, leave_from: r.leave_from, timeLabel: r.timeLabel },
                    subs,
                  )
                }
              />
            )}
          </div>
        ))}
    </div>
  );
}

function DaySection({
  label,
  groups,
  driverNames,
  onFill,
  onDelete,
}: {
  label: string;
  groups: DriverGroup[];
  driverNames: Set<string>;
  onFill: FillSubsFn;
  onDelete: DeleteRowFn;
}) {
  return (
    <div className="flex-1 min-w-[220px]">
      {/* Count = people off, not sheet rows */}
      <SectionHeader label={label} count={groups.length} className="mb-1" />
      {groups.length === 0 ? (
        <p className="text-xs text-slate-500">Không có ai nghỉ</p>
      ) : (
        <div className="divide-y divide-slate-100 overflow-hidden rounded-md border border-slate-200">
          {groups.map((g) => (
            <DriverCard
              key={g.driver_id}
              g={g}
              driverNames={driverNames}
              onFill={onFill}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Uncovered = day-leave drivers (not resigned) with a window that has no
 *  substitute — the actionable count surfaced in the collapsed header. */
function uncoveredCount(groups: DriverGroup[]): number {
  return groups.filter(
    (g) => g.loai_nghi !== "Nghỉ việc" && g.rows.some((r) => r.subs.length === 0),
  ).length;
}

/** Drivers with at least one duplicated leave row — a sheet-cleanup prompt,
 *  surfaced in the collapsed header so it's not missed while the panel is shut. */
function duplicateCount(groups: DriverGroup[]): number {
  return groups.filter((g) => g.rows.some((r) => r.duplicate)).length;
}

/** One uncovered window, flattened out of the day groups so the section can list
 *  the thing that actually needs doing (a window with nobody covering it) rather
 *  than a driver who might be half-covered. */
interface UncoveredRow {
  driver_id: string;
  driver_name: string;
  loai_nghi: string;
  row: LeaveRowView;
}

function uncoveredWindows(groups: DriverGroup[]): UncoveredRow[] {
  const out: UncoveredRow[] = [];
  for (const g of groups) {
    // Resigned drivers are excluded on purpose: a substitute is the wrong answer
    // for a permanent departure — that needs the mapping sheet re-planned, which
    // is what the reference panel below says. Same rule as uncoveredCount.
    if (g.loai_nghi === "Nghỉ việc") continue;
    for (const row of g.rows) {
      if (row.subs.length === 0) {
        out.push({ driver_id: g.driver_id, driver_name: g.driver_name, loai_nghi: g.loai_nghi, row });
      }
    }
  }
  // Flat rather than grouped, so the person AND their window both carry into the
  // order — one driver's morning gap reads before their afternoon one.
  return out.sort((a, b) =>
    compareByDriverThenWindow(
      { driver_name: a.driver_name, timeLabel: a.row.timeLabel },
      { driver_name: b.driver_name, timeLabel: b.row.timeLabel },
    ),
  );
}


function UncoveredRowItem({
  item,
  driverNames,
  onFill,
  onDelete,
  listId,
}: {
  item: UncoveredRow;
  driverNames: Set<string>;
  onFill: FillSubsFn;
  onDelete: DeleteRowFn;
  listId: string;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="px-2 py-1.5 hover:bg-slate-50">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
        <DriverName full={item.driver_name || item.driver_id} className="text-sm font-medium text-slate-800" />
        <span className="text-[11px] font-semibold text-amber-700">{typeLabel(item.loai_nghi)}</span>
        {item.row.timeLabel && (
          <span className="font-mono text-[11px] text-slate-500">{item.row.timeLabel}</span>
        )}
        {!editing && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {/* Not every uncovered window needs a substitute: a MISA request
                approved only in part leaves days off that nobody is actually
                taking, and the fix for those is removing the row, not staffing
                it. Both answers live on the row that raises the question. */}
            <DeleteRowButton
              identity={{
                driver_id: item.driver_id,
                leave_from: item.row.leave_from,
                timeLabel: item.row.timeLabel,
              }}
              onDelete={onDelete}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => setEditing(true)}
            >
              Thêm người thay
            </Button>
          </span>
        )}
      </div>
      {editing && (
        <SubEditor
          row={item.row}
          driverNames={driverNames}
          listId={listId}
          onSave={(subs) =>
            onFill(
              { driver_id: item.driver_id, leave_from: item.row.leave_from, timeLabel: item.row.timeLabel },
              subs,
            )
          }
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  );
}

/**
 * Leave with nobody covering it, as a section of the "Cần xử lý" list — same
 * shape as the assign-failure sections beside it, with the substitute editor on
 * the row.
 *
 * Rendered once per day, both inside that list: today's is work the engine will
 * refuse to assign today, tomorrow's is the same problem while it is still free
 * to fix. `label` names the day, since the rows themselves carry no date.
 *
 * Renders nothing when its day is fully covered, so a covered day costs no space.
 */
export function UncoveredLeaveSection({
  entries,
  label,
  drivers,
  onRefresh,
}: {
  entries: LeaveOnDate[];
  label: string;
  drivers: ConfigDriver[];
  onRefresh: () => void;
}) {
  // Per-instance: the substitute editor also renders inside the panel below, and
  // two <datalist>s cannot share an id.
  const listId = useId();
  const items = uncoveredWindows(groupByDriver(entries));
  const fillSubs = makeFillSubs(onRefresh);
  const deleteRow = makeDeleteRow(onRefresh);
  const driverNames = new Set(drivers.map((d) => d.name));
  if (items.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <SubNamesDatalist id={listId} drivers={drivers} />
      <SectionHeader label={label} count={items.length} tone="amber" />
      <div className="divide-y divide-slate-100 overflow-hidden rounded-md border border-slate-200">
        {items.map((item) => (
          <UncoveredRowItem
            key={`${item.driver_id}-${item.row.leave_from}-${item.row.timeLabel ?? "full"}`}
            item={item}
            driverNames={driverNames}
            onFill={fillSubs}
            onDelete={deleteRow}
            listId={listId}
          />
        ))}
      </div>
    </div>
  );
}

/** Uncovered leave windows across the days the "Cần xử lý" list shows, so the
 *  tab badge counts exactly what the list renders. */
export function uncoveredLeaveCount(...days: LeaveOnDate[][]): number {
  return days.reduce((n, d) => n + uncoveredWindows(groupByDriver(d)).length, 0);
}

/**
 * Any other day's leave, fetched on demand.
 *
 * The panel has always shown today and tomorrow, which is what the ENGINE cares
 * about — today's uncovered leave is a job it will refuse in an hour. But that
 * is the last moment to fix it, not the useful one: a day off filed for next
 * Tuesday with nobody covering it is the same problem while there is still time
 * to arrange a substitute, and until now the only way to see it was to open the
 * sheet.
 *
 * It costs nothing to serve. The route already loads the WHOLE leave tab —
 * today and tomorrow are two filters over one cached parse — so another day is a
 * third filter over the same copy: no sheet read, no upstream call, and no
 * `fresh`, since browsing a date is not a reason to re-download the tab. Nothing
 * is fetched at all until a date is chosen, so the panel's normal cost is
 * unchanged.
 *
 * The rows come back in the same shape as today's, so they get the same sections
 * and the same substitute editor. That is the point rather than a convenience:
 * the writes behind those rows address a row by driver + date + window, never by
 * a row number, so filling in next Tuesday's substitute here is the identical
 * operation to filling in today's.
 */
function OtherDaySection({
  today,
  driverNames,
  onFill,
  onDelete,
  registerReload,
}: {
  /** Saigon's today, as the floor for the picker. */
  today: string;
  driverNames: Set<string>;
  onFill: FillSubsFn;
  onDelete: DeleteRowFn;
  /** Hands the parent a way to re-read the chosen day after a write, so a
   *  substitute filled in here does not leave the row still reading uncovered. */
  registerReload: (fn: (() => void) | null) => void;
}) {
  const [date, setDate] = useState("");
  const [state, setState] = useState<{
    loading: boolean;
    error: string | null;
    /** The day actually loaded — not `date`, which changes the moment the input
     *  does. Keeping them apart is what stops one day's rows being labelled with
     *  another day while a fetch is in flight. */
    shown: string | null;
    entries: LeaveOnDate[];
    invalid: InvalidLeaveRow[];
  }>({ loading: false, error: null, shown: null, entries: [], invalid: [] });

  const load = useCallback(async (d: string) => {
    if (!d) {
      setState({ loading: false, error: null, shown: null, entries: [], invalid: [] });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch(`/api/leave-status?date=${encodeURIComponent(d)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.picked) throw new Error(data.error || `Lỗi ${res.status}`);
      setState({
        loading: false,
        error: null,
        shown: String(data.picked.date ?? d),
        entries: Array.isArray(data.picked.entries) ? data.picked.entries : [],
        invalid: Array.isArray(data.picked.invalid) ? data.picked.invalid : [],
      });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  // A write from inside this section refreshes THIS day, not the panel's two.
  useEffect(() => {
    registerReload(state.shown ? () => void load(state.shown!) : null);
    return () => registerReload(null);
  }, [registerReload, load, state.shown]);

  const pick = (d: string) => { setDate(d); void load(d); };

  const groups = groupByDriver(state.entries);
  const uncovered = uncoveredCount(groups);
  const ignored = state.invalid.filter((r) => !r.recovered);

  return (
    <div className="mt-2 border-t border-slate-200 pt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <label htmlFor="leave-other-day" className="text-[11px] font-medium text-slate-700">
          Xem ngày khác
        </label>
        <input
          id="leave-other-day"
          type="date"
          value={date}
          min={today}
          onChange={(e) => pick(e.target.value)}
          className="rounded border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-900 outline-none focus:ring-2 focus:ring-indigo-400/50"
        />
        {/* Two clicks that cover most of what this is for — checking the rest of
            the week — without making the date field decoration. Named by what
            they mean, not by their date: a bare "06/09" beside a field already
            showing a date is one more number to decode, and the date it lands on
            is on the section header a line below either way. */}
        {([["Ngày kia", 2], ["Tuần sau", 7]] as const).map(([label, n]) => {
          const d = addDays(today, n);
          const sel = state.shown === d;
          return (
            <Button
              key={n}
              size="sm" variant="outline"
              // Selected is a STATE, so it has to be visible and not only
              // announced: a chip carrying aria-pressed and no styling tells a
              // screen reader which day is on screen and tells everyone else
              // nothing.
              className={`h-6 px-2 text-[11px] ${sel ? "border-indigo-400 bg-indigo-50 text-indigo-900" : ""}`}
              aria-pressed={sel}
              title={ddmm(d)}
              onClick={() => pick(d)}
            >
              {label}
            </Button>
          );
        })}
        {(date || state.shown) && (
          <Button
            size="sm" variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={() => { setDate(""); void load(""); }}
          >
            Bỏ chọn
          </Button>
        )}
      </div>

      {state.loading && (
        <div className="mt-1.5 space-y-1" aria-hidden>
          {[0, 1].map((i) => (
            <div key={i} className="h-7 animate-pulse rounded border border-slate-200 bg-slate-100 motion-reduce:animate-none" />
          ))}
        </div>
      )}
      <span role="status" className="sr-only">
        {state.loading ? "Đang tải ngày nghỉ" : ""}
      </span>

      {state.error && (
        <div role="alert" className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-red-600">
          <span className="min-w-0 break-words">{state.error}</span>
          {date && (
            <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[11px]" onClick={() => void load(date)}>
              Thử lại
            </Button>
          )}
        </div>
      )}

      {!state.loading && !state.error && !state.shown && (
        <p className="mt-1.5 text-[11px] text-slate-600">
          Chọn một ngày để xem ai nghỉ và ai chưa có người thay — sửa được từ đây, trước khi tới ngày đó.
        </p>
      )}

      {!state.loading && !state.error && state.shown && (
        <div className="mt-1.5">
          {/* The uncovered count is stated here rather than only coloured: the
              collapsed header above counts today and tomorrow only, and a day
              this far out has nothing else pointing at it. */}
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold text-slate-700">{ddmm(state.shown)}</span>
            {uncovered > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-100 px-1.5 py-0 text-[11px] font-semibold text-amber-800">
                <AlertTriangle className="size-3" strokeWidth={2} />
                {uncovered} chưa có người thay
              </span>
            )}
            {ignored.length > 0 && (
              <span className="rounded-full border border-red-200 bg-red-50 px-1.5 py-0 text-[11px] font-semibold text-red-700">
                {ignored.length} dòng lỗi
              </span>
            )}
          </div>
          {groups.length === 0 ? (
            <p className="text-xs text-slate-600">Không có ai nghỉ ngày {ddmm(state.shown)}.</p>
          ) : (
            <div className="divide-y divide-slate-100 overflow-hidden rounded-md border border-slate-200">
              {groups.map((g) => (
                <DriverCard
                  key={g.driver_id}
                  g={g}
                  driverNames={driverNames}
                  onFill={onFill}
                  onDelete={onDelete}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Leave-status summary for the "Cần xử lý" tab: who's off today and tomorrow,
 * with their coverage window and substitute (if any). Uncovered rows can be
 * filled in place (writes sub#_name/from/to back to the Leave sheet; the
 * sheet's xlookup resolves the id). Collapsed by default into a counts header
 * — expanded on demand — since it sits below the actionable list; the header
 * still flags any uncovered driver in amber so it's never missed while closed.
 */
export function LeaveStatusPanel({
  today,
  tomorrow,
  invalid = [],
  spanning = [],
  suppressed = [],
  suppressedUnreadable = false,
  error = false,
  drivers,
  onRefresh,
}: {
  today: LeaveOnDate[];
  tomorrow: LeaveOnDate[];
  /** Rows whose driver_id came back blank. Both kinds are a sheet repair, but
   *  they are not equally urgent: a recovered row IS being honoured (the name
   *  matched exactly one working driver), while an unrecovered one is still
   *  being ignored and its driver is still being given work. */
  invalid?: InvalidLeaveRow[];
  /** Rows covering 2+ days. Never written by the app — always hand-typed — and
   *  their hour window repeats on every day of the span, which is rarely what
   *  was meant. Honoured as written; shown here so it can be split per day. */
  spanning?: SpanningLeaveRow[];
  /** Days a supervisor deliberately removed, which the MISA sync is barred from
   *  writing back. Only the ones that can still block something. */
  suppressed?: LeaveSuppression[];
  /** The tab exists but would not read, so the bar is currently off. */
  suppressedUnreadable?: boolean;
  error?: boolean;
  drivers: ConfigDriver[];
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const noData = today.length === 0 && tomorrow.length === 0;
  const driverNames = new Set(drivers.map((d) => d.name));
  const todayGroups = groupByDriver(today);
  const tomorrowGroups = groupByDriver(tomorrow);
  const totalUncovered = uncoveredCount(todayGroups) + uncoveredCount(tomorrowGroups);
  const totalDuplicate = duplicateCount(todayGroups) + duplicateCount(tomorrowGroups);
  // Kept apart everywhere below: red means the engine still cannot see this
  // leave, blue means it can and the sheet is merely out of date.
  // Sorted like every other driver list in the panel, and for the same reason —
  // these are read looking for a particular person to repair.
  const byDriver = (a: InvalidLeaveRow, b: InvalidLeaveRow) =>
    compareByDriverThenWindow(a, b);
  const invalidIgnored = invalid.filter((r) => !r.recovered).sort(byDriver);
  const invalidRecovered = invalid.filter((r) => r.recovered).sort(byDriver);

  const fillSubs = makeFillSubs(onRefresh);
  const deleteRow = makeDeleteRow(onRefresh);
  const restoreRow = makeRestoreRow(onRefresh);

  /**
   * A write inside the other-day section has to refresh THAT day too.
   *
   * `onRefresh` re-reads the panel's own two days and nothing else, so filling
   * in next Tuesday's substitute through it left the row still reading
   * "uncovered" — the one state this panel exists to clear, still on screen
   * after the thing that clears it. The section hands up a reloader for the day
   * it is currently showing; a ref rather than state because it changes on every
   * day change and nothing renders from it.
   */
  const otherDayReload = useRef<(() => void) | null>(null);
  const registerOtherDayReload = useCallback((fn: (() => void) | null) => {
    otherDayReload.current = fn;
  }, []);
  const refreshBoth = useCallback(() => { onRefresh(); otherDayReload.current?.(); }, [onRefresh]);
  const otherDayFill = makeFillSubs(refreshBoth);
  const otherDayDelete = makeDeleteRow(refreshBoth);

  if (error && noData) {
    return (
      <Card className="py-2 shrink-0 border-slate-200">
        <CardContent className="px-3">
          <p className="flex items-center gap-1.5 text-xs text-red-600">
            <Palmtree className="size-3.5 shrink-0" strokeWidth={2} />
            Không tải được trạng thái nghỉ phép — thử Làm mới.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="py-2 shrink-0 border-slate-200">
      <CardContent className="px-3">
        {/* Shared datalist for every sub picker in the panel */}
        <SubNamesDatalist id={SUB_NAMES_LIST_ID} drivers={drivers} />

        {/* Collapsed header: counts + uncovered flag, click to expand */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 text-left"
        >
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            <Palmtree className="size-4 text-emerald-600" strokeWidth={2} />
            Nghỉ phép
          </span>
          <span className="text-[11px] text-slate-500">
            Hôm nay {todayGroups.length} · Ngày mai {tomorrowGroups.length}
          </span>
          {totalUncovered > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 border border-amber-200 px-1.5 py-0 text-[11px] font-semibold leading-relaxed">
              <AlertTriangle className="size-3" strokeWidth={2} />
              {totalUncovered} chưa có người thay
            </span>
          )}
          {invalidIgnored.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-700 border border-red-200 px-1.5 py-0 text-[11px] font-semibold leading-relaxed">
              <AlertTriangle className="size-3" strokeWidth={2} />
              {invalidIgnored.length} thiếu driver_id
            </span>
          )}
          {invalidRecovered.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 text-sky-800 border border-sky-200 px-1.5 py-0 text-[11px] font-semibold leading-relaxed">
              {invalidRecovered.length} tự nhận ra tên
            </span>
          )}
          {spanning.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 text-violet-800 border border-violet-200 px-1.5 py-0 text-[11px] font-semibold leading-relaxed">
              <AlertTriangle className="size-3" strokeWidth={2} />
              {spanning.length} dòng nhiều ngày
            </span>
          )}
          {suppressed.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-700 border border-slate-300 px-1.5 py-0 text-[11px] font-semibold leading-relaxed">
              {suppressed.length} đã xoá, không đồng bộ lại
            </span>
          )}
          {suppressedUnreadable && (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-700 border border-red-200 px-1.5 py-0 text-[11px] font-semibold leading-relaxed">
              <AlertTriangle className="size-3" strokeWidth={2} />
              bảng &quot;đã xoá&quot; lỗi
            </span>
          )}
          {totalDuplicate > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 text-orange-700 border border-orange-200 px-1.5 py-0 text-[11px] font-semibold leading-relaxed">
              <AlertTriangle className="size-3" strokeWidth={2} />
              {totalDuplicate} trùng dòng
            </span>
          )}
          <span className="ml-auto text-slate-400 text-xs">{open ? "▾" : "▸"}</span>
        </button>

        {open && (
          <div className="mt-2 max-h-[38vh] overflow-y-auto">
            {invalidRecovered.length > 0 && (
              <div className="mb-2 rounded-md border border-sky-300 bg-sky-50 px-2 py-1.5">
                <div className="text-[11px] font-semibold text-sky-900">
                  Dòng nghỉ thiếu driver_id — hệ thống đã tự nhận ra tên, vẫn cần sửa sheet
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-sky-900/80">
                  Cột driver_id trống, nhưng tên chỉ khớp đúng một tài xế đang làm nên ngày nghỉ
                  VẪN được áp dụng — không ai bị giao việc nhầm. Sửa tên trong cột{" "}
                  <span className="font-mono">driver</span> cho khớp tab Driver để dòng tự resolve lại.
                </p>
                <ul className="mt-1 space-y-0.5">
                  {invalidRecovered.map((r, i) => (
                    <li key={`ok-${r.driver_name}-${r.leave_from}-${r.timeLabel ?? "full"}-${i}`} className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
                      <DriverName full={r.driver_name} className="font-semibold text-slate-900" />
                      <span className="text-[11px] text-slate-600">{ddmm(r.leave_from)}</span>
                      {r.timeLabel && <span className="font-mono text-[11px] text-slate-500">{r.timeLabel}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {invalidIgnored.length > 0 && (
              <div className="mb-2 rounded-md border border-red-300 bg-red-50 px-2 py-1.5">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-red-800">
                  <AlertTriangle className="size-3.5 shrink-0" strokeWidth={2} />
                  Dòng nghỉ thiếu driver_id — hệ thống KHÔNG thấy, cần sửa sheet
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-red-900/80">
                  Cột driver_id trống và tên không khớp duy nhất một tài xế nào, nên dòng bị bỏ qua
                  hoàn toàn: không hiện ở trên, và engine vẫn giao việc cho tài xế này trong khung
                  giờ đó. Sửa tên trong cột{" "}
                  <span className="font-mono">driver</span> cho khớp tab Driver để xlookup ra id.
                </p>
                <ul className="mt-1 space-y-0.5">
                  {invalidIgnored.map((r, i) => {
                    return (
                      <li key={`${r.driver_name}-${r.leave_from}-${r.timeLabel ?? "full"}-${i}`} className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
                        <DriverName full={r.driver_name} className="font-semibold text-slate-900" />
                        <span className="text-[11px] text-slate-600">{ddmm(r.leave_from)}</span>
                        {r.timeLabel && <span className="font-mono text-[11px] text-slate-500">{r.timeLabel}</span>}
                        {!r.hasSub && (
                          <span className="text-[11px] font-semibold text-red-700">chưa có người thay</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {spanning.length > 0 && (
              <div className="mb-2 rounded-md border border-violet-300 bg-violet-50 px-2 py-1.5">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-900">
                  <AlertTriangle className="size-3.5 shrink-0" strokeWidth={2} />
                  Dòng nghỉ kéo dài nhiều ngày — nên tách mỗi ngày một dòng
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-violet-900/80">
                  Khung giờ trên dòng này được hiểu là khung giờ CỦA MỖI NGÀY trong khoảng, không
                  phải nghỉ liên tục từ giờ bắt đầu ngày đầu đến giờ kết thúc ngày cuối. Người thay
                  cũng vậy: cùng một người, cùng khung giờ đó, lặp lại mọi ngày. Đơn nghỉ nộp qua
                  app luôn tách sẵn mỗi ngày một dòng — các dòng dưới đây là gõ tay.
                </p>
                <ul className="mt-1 space-y-0.5">
                  {spanning.map((r, i) => {
                    return (
                      <li key={`span-${r.driver_name}-${r.leave_from}-${r.leave_to}-${i}`} className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
                        <DriverName full={r.driver_name} className="font-semibold text-slate-900" />
                        <span className="text-[11px] text-slate-600">
                          {ddmm(r.leave_from)}–{ddmm(r.leave_to)}
                        </span>
                        <span className="text-[11px] font-semibold text-violet-800">{r.days} ngày</span>
                        {r.timeLabel && <span className="font-mono text-[11px] text-slate-500">{r.timeLabel}</span>}
                        <span className="text-[11px] text-slate-600">
                          {r.hasSub ? "người thay lặp lại mỗi ngày" : "chưa có người thay"}
                        </span>
                        {!r.linked && (
                          <span className="text-[11px] font-semibold text-red-700">thiếu driver_id</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {suppressedUnreadable && (
              <div className="mb-2 rounded-md border border-red-300 bg-red-50 px-2 py-1.5">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-red-800">
                  <AlertTriangle className="size-3.5 shrink-0" strokeWidth={2} />
                  Không đọc được bảng &quot;Nghỉ phép đã xoá&quot;
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-red-900/80">
                  Danh sách ngày đã xoá đang KHÔNG chặn được, nên lần đồng bộ MISA tới có thể
                  tạo lại những dòng đã xoá thủ công. Kiểm tra tên/cột của tab này trong workbook.
                </p>
              </div>
            )}
            {suppressed.length > 0 && (
              <div className="mb-2 rounded-md border border-slate-300 bg-slate-50 px-2 py-1.5">
                <div className="text-[11px] font-semibold text-slate-800">
                  Ngày nghỉ đã xoá thủ công — MISA sẽ không tạo lại
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-700">
                  Đơn nghỉ được duyệt một phần thường để lại dòng thừa; những ngày dưới đây đã
                  được xoá và bị chặn không cho đồng bộ lại. Đơn nghỉ do người nộp (app hoặc
                  dashboard) KHÔNG bị chặn. Bấm Khôi phục để bỏ chặn — ngày sẽ quay lại ở lần
                  đồng bộ tới nếu MISA vẫn tính nghỉ.
                </p>
                <ul className="mt-1 space-y-0.5">
                  {suppressed.map((s, i) => (
                    <SuppressionRow
                      key={`sup-${s.driver_id}-${s.leave_from}-${suppressionTimeLabel(s) ?? "full"}-${i}`}
                      s={s}
                      onRestore={restoreRow}
                    />
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              <DaySection
                label="Hôm nay"
                groups={todayGroups}
                driverNames={driverNames}
                onFill={fillSubs}
                onDelete={deleteRow}
              />
              <DaySection
                label="Ngày mai"
                groups={tomorrowGroups}
                driverNames={driverNames}
                onFill={fillSubs}
                onDelete={deleteRow}
              />
            </div>
            <OtherDaySection
              today={vnDate()}
              driverNames={driverNames}
              onFill={otherDayFill}
              onDelete={otherDayDelete}
              registerReload={registerOtherDayReload}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
