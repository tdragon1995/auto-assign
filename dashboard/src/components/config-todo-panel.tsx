"use client";

import { useId, useState } from "react";
import { ClipboardList } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { CoverageGap, UnfinishedConfigRow, ConfigDriver, BranchRule } from "@/lib/types";
import { resolveDriverCell, splitDriverNames } from "@/lib/driver-cell";

/**
 * What the CONFIG is waiting on a person for — its own card, beside the leave
 * one, rather than a section buried in the failures list.
 *
 * The distinction is what earns the separate card. Everything in the failures
 * panel is a job stuck right now, and stays there only until someone deals with
 * it. These are the opposite: a branch with no driver, or an hour nobody is
 * rostered for, both of which sit until a person edits the config, and neither
 * of which is urgent in the way a late pickup is. Mixed in, they buried the
 * things that were.
 *
 * Two shapes of the same problem, folded away together:
 *   * an hour a job fell into that no rule covers — fixed by moving a boundary
 *     or splitting a rule out;
 *   * a branch with a line but no driver — fixed by naming one.
 */

/**
 * Five-minute grid, the whole day.
 *
 * Finer than the leave form's half-hour slots, and for a different reason: a
 * leave window is somebody's shift, which lands on the half hour, while these
 * are collection boundaries that genuinely sit at 15:15 or 06:45 — the live
 * sheet has both. Rounding those to the nearest half hour would silently move
 * cover the supervisor did not ask to move.
 *
 * The whole day rather than 05:00–22:00, because the config already carries
 * overnight rules (22:00–06:00) that the leave form has no reason to offer.
 */
const TIME_SLOTS_5: string[] = (() => {
  const slots: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 5) {
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return slots;
})();

/**
 * A prefilled value off the grid is kept as an extra option rather than
 * discarded — the sheet holds times typed by hand, and one landing on 08:54
 * would otherwise render the select blank while still holding that time, so the
 * supervisor could not see what they were about to save.
 */
function TimeSelect({
  value, onChange, label, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  /** Times that would produce an invalid or overlapping rule. Greyed out rather
   *  than hidden, so the shape of what is already taken stays visible. */
  disabled?: (t: string) => boolean;
}) {
  const options = value && !TIME_SLOTS_5.includes(value) ? [...TIME_SLOTS_5, value].sort() : TIME_SLOTS_5;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className="rounded border border-slate-300 bg-white px-1 py-1 text-xs font-mono"
    >
      <option value="">--:--</option>
      {options.map((t) => (
        <option key={t} value={t} disabled={disabled?.(t) && t !== value}>{t}</option>
      ))}
    </select>
  );
}

const toMin = (v: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};

/**
 * Whether a time falls INSIDE a rule that already exists — strictly inside, so a
 * clean handover is still allowed.
 *
 * Windows here are half-open: a rule covers (start, end], so a new rule may
 * begin exactly where another ends and they will never both be on duty. Only
 * the minutes properly between the two ends are taken.
 */
function insideBusy(t: string, busy: readonly [string, string][]): boolean {
  const m = toMin(t);
  if (m < 0) return false;
  return busy.some(([f, e]) => {
    const a = toMin(f), b = toMin(e);
    if (a < 0 || b < 0 || a === b) return false;
    return a < b ? m > a && m < b : m > a || m < b;   // the second case wraps midnight
  });
}

const CONFIG_NAMES_LIST_ID = "config-driver-names";

/** A line as the editor holds it while being worked on. */
interface Line {
  /** The sheet row this came from, or undefined for one being added. */
  row?: number;
  driver: string;
  start: string;
  end: string;
}

const asLine = (r: BranchRule): Line => ({ row: r.row, driver: r.driver, start: r.start, end: r.end });

/**
 * The driver cell: one name, or several for a smart row.
 *
 * A datalist matches against the WHOLE field, so the shared list of bare names
 * goes dead the moment a comma is typed and the picker stops helping for exactly
 * the case that needs it most — the second and third driver, whose long
 * code-prefixed names are the ones nobody wants to type by hand. So once the
 * cell holds a comma it gets its own list of "everything typed so far + each
 * roster name", and picking one appends rather than replaces.
 */
function DriverInput({
  value, onChange, drivers,
}: {
  value: string;
  onChange: (v: string) => void;
  drivers: ConfigDriver[];
}) {
  const ownList = useId();
  const cut = value.lastIndexOf(",");
  const multi = cut >= 0;
  const prefix = multi ? `${value.slice(0, cut + 1)} ` : "";
  // Whoever is already named earlier in the cell is not offered again — picking
  // them would build a cell the save then refuses for being a duplicate, and a
  // picker that offers an invalid choice is worse than one that offers fewer.
  const taken = new Set(splitDriverNames(prefix));
  return (
    <>
      <input
        type="text"
        list={multi ? ownList : CONFIG_NAMES_LIST_ID}
        placeholder="Tên tài xế…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-[140px] flex-1 rounded border border-slate-300 px-1.5 py-1 text-xs"
      />
      {multi && (
        <datalist id={ownList}>
          {drivers.filter((d) => !taken.has(d.name))
                   .map((d) => <option key={d.driver_id} value={prefix + d.name} />)}
        </datalist>
      )}
    </>
  );
}

/** Minutes a line is on duty, as inclusive blocks. Mirrors the engine: a blank
 *  window is all day, the window is half-open so the start minute belongs to the
 *  OUTGOING rule, and a start after the end wraps past midnight. */
function blocks(l: Line): Array<[number, number]> {
  const a = toMin(l.start), b = toMin(l.end);
  if (a < 0 || b < 0) return [[0, 1439]];
  if (a === b) return [];
  return a < b ? [[a + 1, b]] : [[a + 1, 1439], [0, b]];
}

/**
 * The first pair of lines that would be on duty at the same minute, if any.
 *
 * Checked over the branch as a WHOLE rather than field by field, which is the
 * point of editing it as a whole: moving one boundary is only safe in the
 * context of everything beside it, and two rules live at the same minute make
 * the engine refuse the job outright.
 */
function findClash(lines: Line[]): [Line, Line] | null {
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      for (const x of blocks(lines[i])) {
        for (const y of blocks(lines[j])) {
          if (Math.max(x[0], y[0]) <= Math.min(x[1], y[1])) return [lines[i], lines[j]];
        }
      }
    }
  }
  return null;
}

/**
 * The whole of one branch's day, editable in one go.
 *
 * Opened from either kind of row, because both ask the same question — who
 * collects from this place, and when — and answering it needs the branch's
 * whole day in view. An hour with nobody on it and a line with no driver are
 * two symptoms of one thing.
 *
 * Every existing rule can have its hours changed or its driver replaced, and a
 * line can be added. Nothing is written until Lưu, and then the branch is
 * validated as a unit: overlap is caught before anything is saved rather than
 * discovered afterwards by a job that would not assign.
 *
 * Existing lines cannot be REMOVED here. Taking cover away is a different kind
 * of decision from adjusting it, and there is nothing on the writing side that
 * does it; only a line added and not yet saved can be dropped again.
 */
function BranchEditor({
  pickupName, dropoffName, rules, extraLine, drivers, onDone, onCancel,
}: {
  pickupName: string;
  dropoffName: string;
  rules: BranchRule[];
  /** The unfinished row itself, when the editor was opened from one — it exists
   *  in the sheet but carries no driver, so it is not among the usable rules. */
  extraLine?: Line;
  drivers: ConfigDriver[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const initial: Line[] = [...rules.map(asLine), ...(extraLine ? [extraLine] : [])]
    .sort((x, y) => (toMin(x.start) - toMin(y.start)) || x.row! - y.row!);
  const [lines, setLines] = useState<Line[]>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const patch = (i: number, v: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...v } : l)));
  const addLine = () => setLines((ls) => [...ls, { driver: "", start: "", end: "" }]);
  const dropLine = (i: number) => setLines((ls) => ls.filter((_, j) => j !== i));

  const changed = (l: Line, i: number) => {
    const was = initial[i];
    return !was || !l.row || was.driver !== l.driver || was.start !== l.start || was.end !== l.end;
  };

  async function save() {
    setErr(null);

    // Resolve every driver first, so nothing is written if one name is wrong.
    const resolved: Line[] = [];
    for (const l of lines) {
      const r = resolveDriverCell(l.driver, drivers);
      if ("error" in r) { setErr(r.error); return; }
      if (lines.length > 1 && (!l.start || !l.end)) {
        setErr("Nhiều ca thì mỗi ca cần khung giờ riêng");
        return;
      }
      if (l.start && l.end && l.start === l.end) {
        setErr(`Ca ${l.start}–${l.end} không bao giờ trực`);
        return;
      }
      resolved.push({ ...l, driver: r.name });
    }

    const clash = findClash(resolved);
    if (clash) {
      setErr(`${clash[0].driver} (${clash[0].start}–${clash[0].end}) và ${clash[1].driver} (${clash[1].start}–${clash[1].end}) trùng giờ`);
      return;
    }

    setBusy(true);
    try {
      const post = async (url: string, body: unknown) => {
        const res = await fetch(url, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) throw new Error(j.error || `Lỗi ${res.status}`);
        return j;
      };
      // Sequential: a failure part way then leaves a clear picture rather than
      // an unknown number of half-written lines.
      let written = 0;
      for (let i = 0; i < resolved.length; i++) {
        const l = resolved[i];
        if (!changed(l, i)) continue;
        if (l.row) {
          await post("/api/config/complete-row", {
            row: l.row, pickup_name: pickupName, driver_name: l.driver,
            shift_start: l.start, shift_end: l.end,
          });
        } else {
          await post("/api/config/add-rule", {
            pickup_name: pickupName, dropoff_name: dropoffName,
            driver_name: l.driver, shift_start: l.start, shift_end: l.end,
          });
        }
        written++;
      }
      toast.success(written ? `Đã lưu ${written} dòng — ${pickupName}` : "Không có thay đổi nào");
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1 space-y-1 rounded border border-slate-300 bg-white p-1.5">
      {lines.map((l, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1">
          <DriverInput value={l.driver} onChange={(v) => patch(i, { driver: v })} drivers={drivers} />
          <TimeSelect label="Từ giờ" value={l.start} onChange={(v) => patch(i, { start: v })} />
          <span className="text-slate-400 text-[11px]">→</span>
          <TimeSelect label="Đến giờ" value={l.end} onChange={(v) => patch(i, { end: v })} />
          <span className="w-10 shrink-0 text-right font-mono text-[10px] text-slate-400">
            {l.row ? `#${l.row}` : "mới"}
          </span>
          {!l.row && (
            <button
              type="button" onClick={() => dropLine(i)}
              className="text-slate-400 hover:text-red-600 text-[11px] px-0.5"
              title="Bỏ dòng này"
            >
              ✕
            </button>
          )}
        </div>
      ))}
      {/* Says what the comma DOES, not just that it is allowed — the difference
          between one driver and several is the difference between a fixed rule
          and a smart one, and nothing else on this screen would tell you. */}
      <div className="text-[10px] text-slate-400">
        Nhiều tài xế trên một dòng, cách nhau bằng dấu phẩy → smart-assign: hệ thống chọn người gần điểm lấy mẫu nhất
      </div>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={addLine} disabled={busy}>
          + Thêm ca
        </Button>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={onCancel} disabled={busy}>
            Hủy
          </Button>
          <Button size="sm" className="h-6 px-2 text-[11px] bg-indigo-600 hover:bg-indigo-700" onClick={save} disabled={busy}>
            {busy ? "Đang lưu…" : "Lưu"}
          </Button>
        </div>
      </div>
      {err && <div className="text-[11px] text-red-600">{err}</div>}
    </div>
  );
}

/** A branch with a line but no driver on it. */
function UnfinishedRow({
  u, rules, drivers, onSaved,
}: {
  u: UnfinishedConfigRow;
  rules: BranchRule[];
  drivers: ConfigDriver[];
  onSaved: (key?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [from, to] = (u.window ?? "–").split("–");

  return (
    <div className="px-2 py-1.5 hover:bg-slate-50">
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0 font-mono text-[11px] text-slate-500" title="Dòng trong Google Sheet">
          #{u.row}
        </span>
        <span
          className="min-w-0 flex-1 break-words md:truncate text-sm font-medium text-slate-800"
          title={`${u.pickup_name}${u.dropoff_name ? ` → ${u.dropoff_name}` : ""}`}
        >
          {u.pickup_name}
          {u.dropoff_name && <span className="text-slate-400"> → {u.dropoff_name}</span>}
        </span>
        {!open && u.window && (
          <span className="shrink-0 text-[11px] text-slate-600 bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5">
            {u.window}
          </span>
        )}
        {!open && (
          <Button size="sm" className="h-6 shrink-0 text-[11px] px-2" onClick={() => setOpen(true)}>
            Sửa config
          </Button>
        )}
      </div>
      {open && (
        <BranchEditor
          pickupName={u.pickup_name}
          dropoffName={u.dropoff_name}
          rules={rules}
          extraLine={{ row: u.row, driver: "", start: from ?? "", end: to ?? "" }}
          drivers={drivers}
          onCancel={() => setOpen(false)}
          onDone={() => { setOpen(false); onSaved(`u:${u.row}`); }}
        />
      )}
    </div>
  );
}

/**
 * An hour a job needed and nobody was rostered for.
 *
 * The row states the diagnosis — what covers the branch either side of the hole
 * — and opens the same branch editor, because closing it is the same job: adjust
 * an hour, or add a line, in the context of the whole day.
 */
function GapRow({
  g, rules, drivers, onSaved,
}: {
  g: CoverageGap;
  rules: BranchRule[];
  drivers: ConfigDriver[];
  onSaved: (key?: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="px-2 py-1.5 hover:bg-slate-50">
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] text-amber-800">
          {g.at}
        </span>
        <span className="min-w-0 flex-1 break-words md:truncate text-sm font-medium text-slate-800" title={g.pickup_name}>
          {g.pickup_name}
        </span>
        {!open && (
          <Button size="sm" className="h-6 shrink-0 text-[11px] px-2" onClick={() => setOpen(true)}>
            Sửa config
          </Button>
        )}
      </div>
      <div className="mt-0.5 text-[11px] text-slate-500">
        {g.before ? `Ca trước ${g.before.window}` : "Không có ca trước"}
        {" · "}
        {g.after ? `ca sau ${g.after.window}` : "không có ca sau"}
        {/* One hole, several minutes: the same gap swallows a job at a slightly
            different time each day. Shown as a tally so it reads as one thing to
            fix, with the times themselves on hover. */}
        {(g.also?.length ?? 0) > 0 && (
          <>
            {" · "}
            <span title={g.also!.join(", ")}>còn {g.also!.length} giờ khác</span>
          </>
        )}
      </div>
      {open && (
        <BranchEditor
          pickupName={g.pickup_name}
          dropoffName=""
          rules={rules}
          drivers={drivers}
          onCancel={() => setOpen(false)}
          onDone={() => { setOpen(false); onSaved(`g:${g.customer_id}|${g.at}`); }}
        />
      )}
    </div>
  );
}

export function ConfigTodoPanel({
  gaps,
  unfinished,
  branchRules,
  drivers,
  parsedAt,
  onSaved,
}: {
  gaps: CoverageGap[];
  unfinished: UnfinishedConfigRow[];
  /** The rules each listed branch already has, keyed by branch. */
  branchRules: Record<string, BranchRule[]>;
  drivers: ConfigDriver[];
  /** When the sheet behind both lists was last read. */
  parsedAt: string;
  onSaved: (key?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (gaps.length === 0 && unfinished.length === 0) return null;

  const listBox = "divide-y divide-slate-100 overflow-hidden rounded-md border border-slate-200";

  return (
    <Card className="py-2 shrink-0 border-slate-200">
      <CardContent className="space-y-1.5 px-3">
        <datalist id={CONFIG_NAMES_LIST_ID}>
          {drivers.map((d) => <option key={d.driver_id} value={d.name} />)}
        </datalist>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 text-left"
          aria-expanded={open}
        >
          <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <ClipboardList className="size-4 text-amber-600" strokeWidth={2} />
            Cần tạo config
          </span>
          {gaps.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 border border-amber-200 px-1.5 py-0 text-[11px] font-semibold leading-relaxed">
              {gaps.length} thiếu ca
            </span>
          )}
          {unfinished.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200 px-1.5 py-0 text-[11px] font-semibold leading-relaxed">
              {unfinished.length} chưa có tài xế
            </span>
          )}
          {/* When the sheet was last READ, not when the cycle ran. The parse is
              event-based, so a hand-edit stays invisible until someone presses
              Refresh — without this, a row already fixed in the sheet reads as a
              bug rather than as a stale list. */}
          {parsedAt && (
            <span className="text-[11px] text-slate-400">
              đọc sheet {parsedAt.slice(11, 16)} · vừa sửa sheet thì bấm Làm mới
            </span>
          )}
          <span className="ml-auto shrink-0 text-xs text-slate-400">{open ? "▾" : "▸"}</span>
        </button>

        {open && gaps.length > 0 && (
          <div className={listBox}>
            {gaps.map((g) => (
              <GapRow key={`${g.customer_id}-${g.at}`} g={g} rules={branchRules[g.customer_id] ?? []} drivers={drivers} onSaved={onSaved} />
            ))}
          </div>
        )}
        {open && unfinished.length > 0 && (
          <div className={listBox}>
            {unfinished.map((u) => (
              <UnfinishedRow key={u.row} u={u} rules={branchRules[u.customer_id] ?? []} drivers={drivers} onSaved={onSaved} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
