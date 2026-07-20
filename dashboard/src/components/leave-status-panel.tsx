"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "./section-header";
import { toast } from "sonner";
import type { LeaveOnDate } from "@/lib/leave-config";
import type { ConfigDriver } from "@/lib/types";

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

/** Sheet driver names look like "F - P - DC101406 Bùi Hiền Anh Kiệt" — the
 *  fleet code drowns the actual name, so split code from name and let the
 *  caller de-emphasize the code. Names not following the "A - B - CODE Name"
 *  pattern render whole. */
function splitDriverName(full: string): { code: string | null; name: string } {
  const parts = full.split(" - ");
  if (parts.length >= 3) {
    const tail = parts[parts.length - 1]; // "DC101406 Bùi Hiền Anh Kiệt"
    const sp = tail.indexOf(" ");
    if (sp > 0) {
      return {
        code: [...parts.slice(0, -1), tail.slice(0, sp)].join(" - "),
        name: tail.slice(sp + 1),
      };
    }
  }
  return { code: null, name: full };
}

interface LeaveRowView {
  timeLabel: string | null;
  subs: LeaveOnDate["subs"];
  leave_from: string;
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
    const row = { timeLabel: d.timeLabel, subs: d.subs, leave_from: d.leave_from };
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
  return [...map.values()];
}

interface SubBlock {
  name: string;
  from: string;
  to: string;
}

export type FillSubsFn = (
  identity: { driver_id: string; leave_from: string; timeLabel: string | null },
  subs: { name: string; from: string | null; to: string | null }[],
) => Promise<boolean>;

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
}: {
  row: LeaveRowView;
  driverNames: Set<string>;
  onSave: (subs: { name: string; from: string | null; to: string | null }[]) => Promise<boolean>;
  onCancel: () => void;
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
            list="leave-sub-names"
            placeholder="Tên người thay…"
            value={b.name}
            onChange={(e) => patch(i, { name: e.target.value })}
            className="min-w-[140px] flex-1 rounded border border-slate-300 px-1.5 py-1 text-xs"
          />
          <input
            type="time"
            value={b.from}
            onChange={(e) => patch(i, { from: e.target.value })}
            className="rounded border border-slate-300 px-1 py-1 text-xs"
          />
          <span className="text-slate-400 text-[11px]">→</span>
          <input
            type="time"
            value={b.to}
            onChange={(e) => patch(i, { to: e.target.value })}
            className="rounded border border-slate-300 px-1 py-1 text-xs"
          />
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
}: {
  g: DriverGroup;
  driverNames: Set<string>;
  onFill: FillSubsFn;
}) {
  const resigned = g.loai_nghi === "Nghỉ việc";
  const uncovered = !resigned && g.rows.some((r) => r.subs.length === 0);
  const [editRow, setEditRow] = useState<number | null>(null);
  const chipClass = resigned
    ? "bg-red-100 text-red-700 border-red-200"
    : "bg-amber-100 text-amber-700 border-amber-200";
  const cardClass = uncovered ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white";
  const { code, name } = splitDriverName(g.driver_name || g.driver_id);
  return (
    <div className={`rounded border px-2 py-1 text-xs ${cardClass}`}>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-sm font-semibold text-slate-900">{name}</span>
        {code && <span className="font-mono text-[11px] text-slate-500">{code}</span>}
        <span
          className={`shrink-0 rounded-full border px-1.5 py-0 text-[11px] font-semibold leading-relaxed ${chipClass}`}
        >
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
}: {
  label: string;
  groups: DriverGroup[];
  driverNames: Set<string>;
  onFill: FillSubsFn;
}) {
  return (
    <div className="flex-1 min-w-[220px]">
      {/* Count = people off, not sheet rows */}
      <SectionHeader label={label} count={groups.length} className="mb-1" />
      {groups.length === 0 ? (
        <p className="text-xs text-slate-500">Không có ai nghỉ</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-1.5">
          {groups.map((g) => (
            <DriverCard key={g.driver_id} g={g} driverNames={driverNames} onFill={onFill} />
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
  error = false,
  drivers,
  onRefresh,
}: {
  today: LeaveOnDate[];
  tomorrow: LeaveOnDate[];
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

  const fillSubs: FillSubsFn = async (identity, subs) => {
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

  if (error && noData) {
    return (
      <Card className="py-2 shrink-0 border-slate-200">
        <CardContent className="px-3">
          <p className="text-xs text-red-600">🌴 Không tải được trạng thái nghỉ phép — thử Refresh.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="py-2 shrink-0 border-slate-200">
      <CardContent className="px-3">
        {/* Shared datalist for every sub picker in the panel */}
        <datalist id="leave-sub-names">
          {drivers.map((d) => (
            <option key={d.driver_id} value={d.name} />
          ))}
        </datalist>

        {/* Collapsed header: counts + uncovered flag, click to expand */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 text-left"
        >
          <span className="text-sm font-semibold">🌴 Nghỉ phép</span>
          <span className="text-[11px] text-slate-500">
            Hôm nay {todayGroups.length} · Ngày mai {tomorrowGroups.length}
          </span>
          {totalUncovered > 0 && (
            <span className="rounded-full bg-amber-100 text-amber-700 border border-amber-200 px-1.5 py-0 text-[11px] font-semibold leading-relaxed">
              ⚠ {totalUncovered} chưa có người thay
            </span>
          )}
          <span className="ml-auto text-slate-400 text-xs">{open ? "▾" : "▸"}</span>
        </button>

        {open && (
          <div className="mt-2 max-h-[38vh] overflow-y-auto">
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              <DaySection label="Hôm nay" groups={todayGroups} driverNames={driverNames} onFill={fillSubs} />
              <DaySection label="Ngày mai" groups={tomorrowGroups} driverNames={driverNames} onFill={fillSubs} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
