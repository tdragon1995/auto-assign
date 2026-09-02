"use client";

import { useId, useState } from "react";
import { ClipboardList } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "./section-header";
import type { CoverageGap, UnfinishedConfigRow, ConfigDriver, BranchRule } from "@/lib/types";
import { resolveDriverCell, splitDriverNames } from "@/lib/driver-cell";
import {
  type Line, type Stretch, toMin, newLineKey, asLine, sig, findClash, stretchOptions,
} from "@/lib/config-shift";

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
      className="rounded border border-slate-300 bg-white px-1 py-1 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
    >
      <option value="">--:--</option>
      {options.map((t) => (
        <option key={t} value={t} disabled={disabled?.(t) && t !== value}>{t}</option>
      ))}
    </select>
  );
}



const CONFIG_NAMES_LIST_ID = "config-driver-names";
/** What the panel header discloses, so aria-expanded actually points at it. */
const LIST_ID = "config-todo-list";


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
        aria-label="Tên tài xế"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-[140px] flex-1 rounded border border-slate-300 px-1.5 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
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
  extraLine?: Omit<Line, "key">;
  drivers: ConfigDriver[];
  onDone: () => void;
  onCancel: () => void;
}) {
  /**
   * Frozen at mount, exactly like `lines` itself.
   *
   * The dashboard re-polls every 3 minutes, so `rules` can move underneath an
   * editor that is open and half-filled. Recomputing the baseline from live
   * props would then mark lines the supervisor never touched as changed and
   * write them straight back.
   */
  const [initial] = useState<Line[]>(() =>
    [...rules.map(asLine), ...(extraLine ? [{ ...extraLine, key: `row:${extraLine.row}` }] : [])]
      .sort((x, y) => (toMin(x.start) - toMin(y.start)) || x.row! - y.row!)
  );
  const [lines, setLines] = useState<Line[]>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /**
   * What each line looked like the last time it was successfully WRITTEN.
   *
   * This is what makes the retry after a partial failure safe. The save loop
   * writes one line at a time, so a failure on line 3 leaves 1 and 2 already in
   * the sheet — and because onDone never ran, the props they came from have not
   * refreshed, so against the baseline alone they still read as changed. Pressing
   * Lưu again then wrote them a second time: a harmless overwrite for a line that
   * has a row, but for a line still being ADDED it appended a duplicate rule, and
   * two rules alive at the same minute is exactly the clash findClash exists to
   * prevent — now sitting in the sheet, where this editor can no longer see it.
   */
  const [committed, setCommitted] = useState<Record<string, string>>({});

  const patch = (i: number, v: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...v } : l)));
  const addLine = () => setLines((ls) => [...ls, { key: newLineKey(), driver: "", start: "", end: "" }]);
  const dropLine = (key: string) => setLines((ls) => ls.filter((l) => l.key !== key));

  const baseline = new Map(initial.map((l) => [l.key, sig(l)]));

  /**
   * Whether this line still has something to write.
   *
   * Matched by KEY rather than by position — dropping a line used to shift every
   * line after it onto the wrong baseline, so an untouched line could be written
   * with its neighbour's old values.
   */
  const changed = (l: Line) => {
    if (committed[l.key] === sig(l)) return false;   // written already, unchanged since
    const was = baseline.get(l.key);
    return was === undefined || was !== sig(l);      // undefined = a line being added
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
    let written = 0;
    try {
      const post = async (url: string, body: unknown) => {
        const res = await fetch(url, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) throw new Error(j.error || `Lỗi ${res.status}`);
        return j;
      };
      // Sequential: a failure part way then leaves a clear picture rather than an
      // unknown number of half-written lines. Each line that lands is recorded
      // BEFORE the next is attempted, so that picture survives the throw.
      for (const l of resolved) {
        if (!changed(l)) continue;
        if (l.row) {
          await post("/api/config/complete-row", {
            row: l.row, pickup_name: pickupName, driver_name: l.driver,
            shift_start: l.start, shift_end: l.end,
          });
        } else {
          const res = await post("/api/config/add-rule", {
            pickup_name: pickupName, dropoff_name: dropoffName,
            driver_name: l.driver, shift_start: l.start, shift_end: l.end,
          });
          // Adopt the row the sheet just gave it. This line is an existing row
          // from here on, so a retry updates it in place instead of adding a
          // second one beside it.
          if (typeof res.row === "number") l.row = res.row;
        }
        // Record the RESOLVED driver name, and normalise the field to it, so the
        // signature still matches on a later pass — otherwise a name typed as
        // "nam" and saved as "D001 - Nguyễn Văn Nam" reads as changed again.
        const done = { ...l };
        setLines((ls) => ls.map((x) => (x.key === done.key ? { ...x, row: done.row, driver: done.driver } : x)));
        setCommitted((c) => ({ ...c, [done.key]: sig(done) }));
        written++;
      }
      toast.success(written ? `Đã lưu ${written} dòng — ${pickupName}` : "Không có thay đổi nào");
      onDone();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Say what landed. Without it the supervisor cannot tell a total failure
      // from a partial one, and the obvious recovery — press Lưu again — was the
      // move that used to duplicate rules.
      setErr(written > 0
        ? `Đã lưu ${written} dòng trước khi lỗi: ${msg} — bấm Lưu lại chỉ ghi phần còn thiếu`
        : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1 space-y-1 rounded border border-slate-300 bg-white p-1.5">
      {lines.map((l, i) => (
        <div key={l.key} className="flex flex-wrap items-center gap-1">
          <DriverInput value={l.driver} onChange={(v) => patch(i, { driver: v })} drivers={drivers} />
          <TimeSelect label="Từ giờ" value={l.start} onChange={(v) => patch(i, { start: v })} />
          <span aria-hidden className="text-slate-500 text-[11px]">→</span>
          <TimeSelect label="Đến giờ" value={l.end} onChange={(v) => patch(i, { end: v })} />
          <span className="w-10 shrink-0 text-right font-mono text-[10px] text-slate-600">
            {l.row ? `#${l.row}` : "mới"}
          </span>
          {!l.row && (
            <button
              type="button" onClick={() => dropLine(l.key)}
              aria-label="Bỏ dòng này"
              className="rounded px-1 py-0.5 text-[11px] text-slate-600 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
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
      <div className="text-[10px] text-slate-600">
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
      {/* A save that half-landed is the one message here nobody can afford to
          miss, and it is the one that decides whether pressing Lưu again is
          safe — so it is announced, not just coloured. */}
      {err && <div role="alert" className="text-[11px] text-red-600">{err}</div>}
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
          {u.dropoff_name && <span className="text-slate-500"> → {u.dropoff_name}</span>}
        </span>
        {!open && u.window && (
          <span className="shrink-0 text-[11px] text-slate-600 bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5">
            {u.window}
          </span>
        )}
        {!open && (
          <Button
            size="sm" variant="outline" className="h-6 shrink-0 text-[11px] px-2"
            onClick={() => setOpen(true)}
          >
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
  const [stretching, setStretching] = useState<string | null>(null);
  const [stretchErr, setStretchErr] = useState<string | null>(null);
  const repeats = g.also?.length ?? 0;
  const options = stretchOptions(g, rules);

  /** Close the hole by moving one boundary — the whole fix, in one request. */
  async function stretch(s: Stretch) {
    setStretchErr(null);
    setStretching(s.edge);
    try {
      const res = await fetch("/api/config/stretch-rule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row: s.row, pickup_name: g.pickup_name, edge: s.edge, value: s.value }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || `Lỗi ${res.status}`);
      toast.success(`${s.driver} giờ trực ${s.window} — ${g.pickup_name}`);
      onSaved(`g:${g.customer_id}|${g.at}`);
    } catch (e) {
      setStretchErr(e instanceof Error ? e.message : String(e));
    } finally {
      setStretching(null);
    }
  }

  return (
    <div className="px-2 py-1.5 hover:bg-slate-50">
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] text-amber-800">
          {g.at}
        </span>
        {/* How many days this same hole has already swallowed a job. It decides
            the order of the list, so it has to be visible enough to explain why
            this row is at the top — grey 11px text could not. */}
        {repeats > 0 && (
          <span
            className="shrink-0 rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0 text-[11px] font-semibold tabular-nums text-amber-800"
            title={`Còn ${repeats} giờ khác rơi vào cùng lỗ hổng này: ${g.also!.join(", ")}`}
          >
            ×{repeats + 1}
          </span>
        )}
        <span
          className="min-w-0 flex-1 break-words md:truncate text-sm font-medium text-slate-800"
          title={`${g.pickup_name}${g.dropoff_name ? ` → ${g.dropoff_name}` : ""}`}
        >
          {g.pickup_name}
          {/* Grey, exactly as on an unfinished row: the branch is what the fix is
              about, the destination only says which trip fell in the hole. */}
          {g.dropoff_name && <span className="text-slate-500"> → {g.dropoff_name}</span>}
        </span>
        {!open && (
          <Button
            size="sm" variant="outline" className="h-6 shrink-0 text-[11px] px-2"
            onClick={() => setOpen(true)}
          >
            Sửa config
          </Button>
        )}
      </div>
      <div className="mt-0.5 text-[11px] text-slate-500">
        {g.before ? `Ca trước ${g.before.window}` : "Không có ca trước"}
        {" · "}
        {g.after ? `ca sau ${g.after.window}` : "không có ca sau"}
        {/* The recurrence used to be spelled out here as well. It is the ×N chip
            beside the time now — where it can be seen without reading the line,
            which is the point of it — so saying it twice is just noise. */}
      </div>
      {/* The one-boundary fixes, when the branch allows one. Each says who ends
          up working what, because that — not the hole — is what the supervisor
          is actually agreeing to. The full editor stays beside them for the
          cases these cannot express. */}
      {!open && options.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {options.map((s) => (
            <Button
              key={s.edge}
              size="sm" variant="outline"
              className="h-6 px-2 text-[11px] font-normal"
              disabled={stretching !== null}
              onClick={() => stretch(s)}
              title={`Ghi ${s.value} vào giờ ${s.edge === "end" ? "kết thúc" : "bắt đầu"} của dòng #${s.row}`}
            >
              {stretching === s.edge ? "Đang lưu…" : `Nới ${s.driver} → ${s.window}`}
            </Button>
          ))}
        </div>
      )}
      {stretchErr && <div role="alert" className="mt-1 text-[11px] text-red-600">{stretchErr}</div>}
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

  /**
   * Worst first: the hole that has swallowed the most jobs is the one worth an
   * hour of somebody's morning.
   *
   * `also` counts the other minutes that fell into the SAME hole, one per day it
   * has been failing — so it is the only severity signal this panel has, and it
   * used to be the smallest grey text on the row while the order stayed
   * arbitrary. A standing two-week gap sorted below a one-off. Ties fall back to
   * the clock so the list is still stable between polls.
   */
  const sortedGaps = [...gaps].sort(
    (a, b) => (b.also?.length ?? 0) - (a.also?.length ?? 0) || a.at.localeCompare(b.at),
  );

  return (
    <Card className="py-2 shrink-0 border-slate-200">
      <CardContent className="space-y-1.5 px-3">
        <datalist id={CONFIG_NAMES_LIST_ID}>
          {drivers.map((d) => <option key={d.driver_id} value={d.name} />)}
        </datalist>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 rounded py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
          aria-expanded={open}
          aria-controls={LIST_ID}
        >
          <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <ClipboardList className="size-4 text-amber-600" strokeWidth={2} />
            Cần tạo config
          </span>
          {/* Announced: clearing the last row of a kind is the one thing on this
              panel a screen-reader user would otherwise have no way of noticing. */}
          <span className="contents" role="status" aria-live="polite">
          {gaps.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 border border-amber-200 px-1.5 py-0 text-[11px] font-semibold leading-relaxed">
              {gaps.length} thiếu ca
            </span>
          )}
          {unfinished.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200 px-1.5 py-0 text-[11px] font-semibold leading-relaxed">
              {unfinished.length} chưa có tài xế
            </span>
          )}
          </span>
          {/* When the sheet was last READ, not when the cycle ran. The parse is
              event-based, so a hand-edit stays invisible until someone presses
              Refresh — without this, a row already fixed in the sheet reads as a
              bug rather than as a stale list. */}
          {parsedAt && (
            <span className="text-[11px] text-slate-500">
              đọc sheet {parsedAt.slice(11, 16)} · vừa sửa sheet thì bấm Làm mới
            </span>
          )}
          <span aria-hidden className="ml-auto shrink-0 text-xs text-slate-500">{open ? "▾" : "▸"}</span>
        </button>

        {/* Capped and scrolled, exactly as the leave panel caps itself.
            These are the least urgent things on the tab — they wait on a person
            editing a sheet — and the card is shrink-0 inside a fixed-height
            column, so an uncapped list of a dozen open to-dos pushed the stuck
            jobs and late pickups above it down to nothing. That list is the one
            thing here getting worse while you read it; it does not lose its
            space to this one. */}
        {open && (
          <div id={LIST_ID} className="max-h-[38vh] space-y-1.5 overflow-y-auto">
            {gaps.length > 0 && (
              <section aria-label="Giờ không có ai trực">
                <SectionHeader label="Thiếu ca — giờ không ai trực" count={gaps.length} tone="amber" className="pt-0.5" />
                <div className={listBox}>
                  {sortedGaps.map((g) => (
                    <GapRow key={`${g.customer_id}-${g.at}`} g={g} rules={branchRules[g.customer_id] ?? []} drivers={drivers} onSaved={onSaved} />
                  ))}
                </div>
              </section>
            )}
            {unfinished.length > 0 && (
              <section aria-label="Dòng config chưa có tài xế">
                <SectionHeader label="Chưa có tài xế" count={unfinished.length} className="pt-0.5" />
                <div className={listBox}>
                  {unfinished.map((u) => (
                    <UnfinishedRow key={u.row} u={u} rules={branchRules[u.customer_id] ?? []} drivers={drivers} onSaved={onSaved} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
