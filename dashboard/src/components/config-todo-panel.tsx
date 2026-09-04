"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ClipboardList, Search } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "./section-header";
import type { CoverageGap, UnfinishedConfigRow, ConfigDriver, BranchRule, ShiftOverlap } from "@/lib/types";
import { DRIVER_SEP, foldName, resolveDriverCell, splitDriverNames } from "@/lib/driver-cell";
import { displayDriverCell } from "@/lib/driver-label";
import { coverageLostWithout, overlapKey } from "@/lib/config-shift";
import { searchConfigRows } from "./config-browser-panel";
import type { ConfigRowView } from "@/app/api/config/rows/route";
import { driverDisplayName } from "@/lib/display-names";
import { DriverName } from "./driver-name";
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



/** What the panel header discloses, so aria-expanded actually points at it. */
const LIST_ID = "config-todo-list";


/**
 * The driver cell: one name, or several for a smart row.
 *
 * Picked, not typed. The cell's multi-driver form is a comma-separated list, and
 * the editor used to make the supervisor type that punctuation themselves — with
 * a datalist that matches the WHOLE field, so it went dead the moment a comma
 * appeared and stopped helping for exactly the names that needed it most: the
 * second and third driver, whose long code-prefixed spellings nobody wants to
 * key by hand. The separator was also the only thing distinguishing a fixed rule
 * from a smart one, which meant a stray comma silently changed what the row DID.
 *
 * So the list is the control now. Names go in as chips, the search filters the
 * roster accent-insensitively, and the comma is an implementation detail of the
 * sheet again — assembled on the way out, never typed.
 */
/**
 * Two fixed rules on one branch that are both on duty at the same minute.
 *
 * The mirror of a coverage gap, and the same job to fix: a hole means the engine
 * has nobody to give the job to (NO_DRIVER); an overlap means it has two and
 * refuses to choose (CLASH). Both end with the job unassigned, so both belong in
 * this list — the overlap only ever appeared as a paragraph in the sheet-alarm
 * banner before, which named the problem without offering the fix.
 *
 * The fix is one boundary, the same as a gap's: the earlier rule hands over
 * sooner, or the later one starts later. Where neither works on its own — a rule
 * wholly inside another, where cutting either would open a hole — nothing is
 * offered and the full editor takes over, because that shows the whole day.
 */
function OverlapRow({
  o, rules, drivers, onSaved,
}: {
  o: ShiftOverlap;
  rules: BranchRule[];
  drivers: ConfigDriver[];
  onSaved: (key?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const key = `o:${overlapKey(o)}`;

  /** Empty one of the two rows — the whole fix now.
   *
   *  The boundary move that used to sit above this is gone. It kept BOTH rules
   *  by splitting the day between them, which on a same-driver pair — most of
   *  this list — just turned one redundant row into two adjacent ones covering
   *  the same stretch. The row that should not exist is what actually wants
   *  removing. */
  async function clearRow(row: number) {
    setErr(null);
    setBusy(`clear${row}`);
    try {
      const res = await fetch("/api/config/delete-row", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row, pickup_name: o.pickup_name }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || `Lỗi ${res.status}`);
      toast.success(`Đã xoá dòng #${row} — ${o.pickup_name}`);
      onSaved(key);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setArmed(null);
    }
  }

  return (
    <div className="px-2 py-1.5 hover:bg-slate-50">
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0 rounded border border-rose-300 bg-rose-50 px-1.5 py-0.5 font-mono text-[11px] text-rose-800">
          {o.window}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-800" title={o.pickup_name}>
          {o.pickup_name}
        </span>
        {!open && (
          <Button
            size="sm" variant="outline"
            className="h-6 shrink-0 px-2 text-[11px]"
            onClick={() => setOpen(true)}
          >
            Sửa config
          </Button>
        )}
      </div>
      <div className="mt-0.5 text-[11px] text-slate-600">
        {/* Both sides named, with their hours: the supervisor is deciding which
            of two real people keeps the stretch, and cannot do that from the
            branch and the window alone. */}
        {displayDriverCell(o.drivers[0])}
        {o.rules && <span className="tabular-nums"> {o.rules[0].window}</span>}
        {" · "}
        {displayDriverCell(o.drivers[1])}
        {o.rules && <span className="tabular-nums"> {o.rules[1].window}</span>}
      </div>
      {/* Removing a row, two clicks. Offered per side and never as one button:
          the two rows are different rules, and which one is the leftover is the
          supervisor's call, not something derivable from the overlap. */}
      {!open && o.rules && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {o.rules.map((r) => {
            // Removing a row can give up cover the other row never had. The
            // boundary move above has refused to do that since it was written;
            // a delete may legitimately want to, so this says it rather than
            // blocking it.
            //
            // The SAFE side is the one that carries colour, not the risky one.
            // That is the opposite of how this shipped, and the live list is why:
            // 34 overlap rows, and on nearly every one of them exactly one side
            // gives up cover — so highlighting the risk lit up the whole list and
            // said nothing. Highlighting the side that costs nothing turns the
            // same information into the answer: press the green one. The other
            // still states its consequence, quietly, because choosing it is
            // sometimes right.
            const lost = coverageLostWithout(rules, r.row);
            return (
            <span key={r.row} className="inline-flex items-center gap-1">
              {armed === r.row ? (
                <>
                  <span className="text-[11px] font-semibold text-red-700">
                    Xoá dòng #{r.row}?{lost && ` Sẽ hở ${lost}.`}
                  </span>
                  <Button
                    size="sm"
                    className="h-6 px-2 text-[11px] bg-red-600 hover:bg-red-700"
                    disabled={busy !== null}
                    onClick={() => clearRow(r.row)}
                  >
                    {busy === `clear${r.row}` ? "Đang xoá…" : "Xoá"}
                  </Button>
                  <Button
                    size="sm" variant="outline"
                    className="h-6 px-2 text-[11px] font-normal"
                    disabled={busy !== null}
                    onClick={() => setArmed(null)}
                  >
                    Hủy
                  </Button>
                </>
              ) : (
                <Button
                  size="sm" variant="outline"
                  className={`h-6 px-2 text-[11px] font-normal ${
                    lost
                      ? "text-slate-500"
                      : "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                  }`}
                  disabled={busy !== null || armed !== null}
                  onClick={() => setArmed(r.row)}
                  title={
                    `Xoá hẳn dòng #${r.row} (${displayDriverCell(r.driver)} ${r.window})` +
                    (lost ? ` — sau đó ${lost} sẽ không còn ai trực` : " — không mất giờ trực nào")
                  }
                >
                  Xoá {r.window}
                  {lost && <span className="ml-1 text-slate-400">· hở {lost}</span>}
                </Button>
              )}
            </span>
            );
          })}
        </div>
      )}
      {err && <div role="alert" className="mt-1 text-[11px] text-red-600">{err}</div>}
      {open && (
        <BranchEditor
          pickupName={o.pickup_name}
          dropoffName=""
          rules={rules}
          drivers={drivers}
          onCancel={() => setOpen(false)}
          onDone={() => { setOpen(false); onSaved(key); }}
        />
      )}
    </div>
  );
}

function DriverPicker({
  value, onChange, drivers,
}: {
  value: string;
  onChange: (v: string) => void;
  drivers: ConfigDriver[];
}) {
  const names = splitDriverNames(value);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** The menu is positioned FIXED off this box. It has to escape the panel's
   *  own `overflow-y-auto`, which would otherwise clip it to a few pixels. */
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const listId = useId();

  const taken = new Set(names);
  const matches = drivers.filter(
    (d) => !taken.has(d.name) && (!q.trim() || foldName(d.name).includes(foldName(q.trim()))),
  );

  const place = useCallback(() => {
    const r = boxRef.current?.getBoundingClientRect();
    // Bounded, not simply the field's width: the field stretches to hold several
    // long code-prefixed chips, and a menu that wide leaves each name marooned
    // against a mostly-empty row.
    if (r) setRect({ left: r.left, top: r.bottom + 2, width: Math.min(Math.max(r.width, 240), 420) });
  }, []);

  /** Opening MEASURES first, in the handler, then shows. Placing from inside the
   *  effect instead would set state during the render the effect follows, which
   *  is a cascading render — and would also flash the menu at a stale position. */
  const openMenu = useCallback(() => { place(); setOpen(true); }, [place]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // `true` so a scroll inside the panel repositions too, not just the window.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    document.addEventListener("mousedown", onDoc);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [open, place]);

  const add = (name: string) => {
    onChange([...names, name].join(DRIVER_SEP));
    setQ(""); setActive(0);
    inputRef.current?.focus();
    // The field grows by a chip, so the menu hanging off its bottom edge moves.
    requestAnimationFrame(place);
  };
  const remove = (name: string) => onChange(names.filter((n) => n !== name).join(DRIVER_SEP));

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { openMenu(); return; }
      setActive((i) => {
        const n = matches.length;
        return n === 0 ? 0 : (e.key === "ArrowDown" ? i + 1 : i - 1 + n) % n;
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && matches[active]) add(matches[active].name);
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && q === "" && names.length > 0) {
      // The usual chip-field affordance: rubbing out backwards takes the last
      // name off rather than doing nothing.
      remove(names[names.length - 1]);
    }
  }

  return (
    <div
      ref={boxRef}
      className="flex min-w-[200px] flex-1 flex-wrap items-center gap-1 rounded border border-slate-300 bg-white px-1 py-0.5 focus-within:ring-2 focus-within:ring-indigo-400/50"
    >
      {names.map((n) => (
        <span
          key={n}
          className="inline-flex max-w-full items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-800"
        >
          <span className="inline-flex items-baseline gap-x-1 truncate">
            <DriverName full={n} className="truncate" />
          </span>
          <button
            type="button"
            onClick={() => remove(n)}
            aria-label={`Bỏ ${driverDisplayName(n) || n}`}
            className="rounded text-slate-600 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
          >
            ✕
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label="Thêm tài xế"
        placeholder={names.length ? "Thêm tài xế…" : "Chọn tài xế…"}
        value={q}
        onChange={(e) => { setQ(e.target.value); setActive(0); openMenu(); }}
        onFocus={openMenu}
        onKeyDown={onKeyDown}
        className="min-w-[90px] flex-1 bg-transparent px-0.5 py-0.5 text-xs outline-none"
      />
      {open && rect && (
        <ul
          id={listId}
          role="listbox"
          style={{ position: "fixed", left: rect.left, top: rect.top, width: rect.width, zIndex: 50 }}
          className="max-h-56 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg"
        >
          {matches.length === 0 && (
            <li className="px-2 py-1 text-[11px] text-slate-600">Không tìm thấy tài xế</li>
          )}
          {matches.map((d, i) => (
            <li key={d.driver_id}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => add(d.name)}
                className={`flex w-full flex-wrap items-baseline gap-x-1.5 px-2 py-1 text-left text-xs ${
                  i === active ? "bg-indigo-50 text-slate-900" : "text-slate-700"
                }`}
              >
                <DriverName full={d.name} className="truncate" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
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
/** How a copied line is matched against what the editor already holds. */
const copyKey = (driver: string, start: string, end: string) =>
  `${driver.trim()}|${start.trim()}|${end.trim()}`;

/** One source branch, with its rules in the order they run. */
type CopySource = {
  pickup: string;
  customer_id: string;
  rules: ConfigRowView[];
  /** Rules not already sitting in the editor — what pressing Chép actually adds. */
  fresh: ConfigRowView[];
};

/**
 * Copy a branch's whole shift pattern onto the branch being set up.
 *
 * Most new branches are not new arrangements: the place next door is already
 * covered 05:00–13:25 then 13:25–19:00 by two named people, and the answer here
 * is the same shape. Retyping it is where the mistakes come from — an hour
 * mistyped, a handover left with a gap, a driver name that does not resolve.
 *
 * It copies into the EDITOR, not into the sheet. Everything the supervisor would
 * have had to get right is then still checked by the same save path: names are
 * resolved against the roster, overlapping hours are refused, and nothing is
 * written until Lưu. So this is a way to fill the form, not a second way to
 * write config.
 *
 * Only rules that actually name a driver are copied — a source branch can itself
 * have an empty line waiting to be filled, and copying that would carry the
 * to-do across rather than the answer.
 *
 * It is a LISTBOX, not a stack of buttons. The roster picker two components up
 * is already a keyboard combobox, and this asks the same question inside the
 * same editor; typing a name and then reaching for the arrow keys is what a
 * supervisor does next, and it used to do nothing here. Same reason the panel
 * renders BELOW the editor's action row rather than inside it: opening it used
 * to widen a flex row and push Hủy/Lưu onto a second line, so the two buttons
 * that matter moved under the cursor at the moment the picker appeared.
 *
 * The count on each row is the count that will ARRIVE, not the count the source
 * happens to have. The caller drops lines the editor already holds, so a branch
 * whose three shifts are all present offers nothing — and now says so, instead
 * of promising three and adding none.
 */
function CopyFromBranch({
  open,
  onClose,
  onCopy,
  existingKeys,
  panelId,
}: {
  open: boolean;
  onClose: () => void;
  onCopy: (lines: { driver: string; start: string; end: string }[]) => void;
  /** `copyKey` of every line already in the editor. */
  existingKeys: readonly string[];
  panelId: string;
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ConfigRowView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const hintId = useId();

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/config/rows", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!Array.isArray(data.rows)) throw new Error(data.error || `Lỗi ${res.status}`);
      setRows(data.rows as ConfigRowView[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // One fetch per opening of the editor, and none at all until the picker is
  // actually opened. The route is behind a five-minute cache on the server, so
  // re-opening the picker in the same session costs nothing further.
  useEffect(() => {
    if (open && rows === null && !loading && !err) void load();
  }, [open, rows, loading, err, load]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const existing = useMemo(() => new Set(existingKeys), [existingKeys]);

  // Grouped by branch, because a branch's DAY is the useful unit — copying one
  // of its three shifts would leave the other two to be typed by hand, which is
  // the work this exists to remove.
  const all = useMemo<CopySource[]>(() => {
    if (!rows || !q.trim()) return [];
    const hit = searchConfigRows(rows, q).filter((r) => r.driver.trim() && r.pickup.trim());
    const byBranch = new Map<string, { pickup: string; customer_id: string; rules: ConfigRowView[] }>();
    for (const r of hit) {
      const key = r.customer_id || r.pickup;
      const g = byBranch.get(key);
      if (g) g.rules.push(r);
      else byBranch.set(key, { pickup: r.pickup, customer_id: r.customer_id, rules: [r] });
    }
    return [...byBranch.values()].map((g) => {
      const rules = [...g.rules].sort((a, b) => toMin(a.start) - toMin(b.start));
      return {
        ...g,
        rules,
        fresh: rules.filter((r) => !existing.has(copyKey(r.driver, r.start, r.end))),
      };
    });
  }, [rows, q, existing]);

  const branches = all.slice(0, 8);
  const hidden = all.length - branches.length;
  const activeIndex = branches.length ? Math.min(active, branches.length - 1) : 0;

  // Keep the highlight inside the list as the query narrows it.
  useEffect(() => { setActive(0); }, [q]);

  const take = (b: CopySource) => {
    if (b.fresh.length === 0) return;
    onCopy(b.fresh.map((r) => ({ driver: r.driver, start: r.start, end: r.end })));
    setQ("");
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (branches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (Math.min(i, branches.length - 1) + 1) % branches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (Math.min(i, branches.length - 1) - 1 + branches.length) % branches.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const b = branches[activeIndex];
      if (b) take(b);
    }
  };

  if (!open) return null;

  const optionId = (i: number) => `${listId}-o${i}`;

  return (
    <div id={panelId} className="mt-1 rounded-md border border-slate-300 bg-slate-50 p-2">
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-slate-500" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={branches.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-describedby={hintId}
            aria-activedescendant={branches.length ? optionId(activeIndex) : undefined}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Tìm điểm đã có ca…"
            aria-label="Tìm điểm để sao chép ca"
            className="w-full rounded border border-slate-300 bg-white py-1 pl-7 pr-2 text-xs text-slate-900 outline-none placeholder:text-slate-500 focus:ring-2 focus:ring-indigo-400/50"
          />
        </div>
        <Button
          size="sm" variant="outline"
          className="h-6 shrink-0 px-2 text-[11px]"
          onClick={onClose}
        >
          Đóng
        </Button>
      </div>

      <p id={hintId} className="mt-1 text-[11px] text-slate-600">
        Chép cả ngày của một điểm khác vào form này. Chưa ghi vào sheet — vẫn phải bấm Lưu.
      </p>

      {err && (
        <div role="alert" className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
          <span className="min-w-0 break-words">Không tải được config: {err}</span>
          <Button
            size="sm" variant="outline"
            className="ml-auto h-6 shrink-0 px-2 text-[11px]"
            onClick={() => { setErr(null); void load(); }}
          >
            Thử lại
          </Button>
        </div>
      )}

      {/* Skeletons rather than a line of text: the list is what the supervisor is
          waiting for, so the wait should have the shape of the list. */}
      {loading && (
        <div className="mt-1.5 space-y-1" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="animate-pulse rounded border border-slate-200 bg-white p-1.5 motion-reduce:animate-none">
              <div className="h-3 w-2/5 rounded bg-slate-200" />
              <div className="mt-1.5 h-2.5 w-3/5 rounded bg-slate-100" />
            </div>
          ))}
        </div>
      )}
      <span role="status" className="sr-only">{loading ? "Đang tải config" : ""}</span>

      {!loading && !err && !q.trim() && (
        <p className="mt-1.5 rounded border border-dashed border-slate-300 bg-white px-2 py-2 text-[11px] text-slate-600">
          Gõ tên điểm, mã điểm (VD <span className="font-mono">D014</span>) hoặc tên tài xế để tìm
          một điểm đã được xếp ca.
        </p>
      )}

      {!loading && !err && q.trim() && branches.length === 0 && (
        <p className="mt-1.5 text-[11px] text-slate-600">
          Không có điểm nào đã xếp ca khớp &ldquo;{q.trim()}&rdquo;.
        </p>
      )}

      {branches.length > 0 && (
        <ul id={listId} role="listbox" aria-label="Điểm để sao chép ca" className="mt-1.5 space-y-1">
          {branches.map((b, i) => {
            const none = b.fresh.length === 0;
            const isActive = i === activeIndex;
            return (
              <li key={b.customer_id || b.pickup}>
                <button
                  type="button"
                  id={optionId(i)}
                  role="option"
                  aria-selected={isActive}
                  aria-disabled={none}
                  tabIndex={-1}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => take(b)}
                  className={`w-full rounded border p-1.5 text-left transition-colors duration-150 ${
                    none
                      ? "cursor-not-allowed border-slate-200 bg-white opacity-70"
                      : isActive
                        ? "border-indigo-400 bg-indigo-50"
                        : "border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/60"
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-x-1.5">
                    <span className="text-xs font-medium text-slate-800">{b.pickup}</span>
                    {b.customer_id && (
                      <span className="font-mono text-[10px] text-slate-500">{b.customer_id}</span>
                    )}
                    <span
                      className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                        none ? "bg-slate-100 text-slate-700" : "bg-indigo-600 text-white"
                      }`}
                    >
                      {none ? "Đã có đủ" : `Chép ${b.fresh.length} ca`}
                    </span>
                  </span>
                  <span className="mt-0.5 block space-y-0.5">
                    {b.rules.map((r) => {
                      const dup = existing.has(copyKey(r.driver, r.start, r.end));
                      return (
                        <span key={r.row} className={`block text-[11px] ${dup ? "text-slate-500" : "text-slate-700"}`}>
                          <span className="tabular-nums">
                            {r.start && r.end ? `${r.start}–${r.end}` : "cả ngày"}
                          </span>
                          {" · "}
                          {displayDriverCell(r.driver)}
                          {/* A rule scoped to one destination copies its hours and its
                              driver but NOT that scope — the new line inherits the
                              destination of the branch being edited. Shown so the
                              difference is visible before the copy, rather than
                              discovered by a job that assigns somewhere else. */}
                          {r.dropoff && <span className="text-slate-500"> → chỉ {r.dropoff}</span>}
                          {dup && <span className="text-slate-500"> · đã có</span>}
                        </span>
                      );
                    })}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {hidden > 0 && (
        <p className="mt-1 text-[11px] text-slate-600">
          Còn {hidden} điểm nữa — gõ thêm để thu hẹp.
        </p>
      )}
    </div>
  );
}

/**
 * Exported so the config BROWSER can open the same editor.
 *
 * The point of exporting it rather than writing a second one: every guard that
 * makes an edit safe lives in here and in the four routes behind it — names
 * resolved against the roster, overlapping hours refused, each line's row
 * re-read and compared before it is written. A separate editor for "the other
 * way in" would be a second set of those, and they would drift.
 */
export function BranchEditor({
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
  const [copyOpen, setCopyOpen] = useState(false);
  const copyBtnRef = useRef<HTMLButtonElement>(null);
  const copyPanelId = useId();
  /**
   * Lines that have just arrived from a copy, held long enough to be seen.
   *
   * Copying used to close the picker and append silently: the supervisor was
   * looking at the picker, and the result appeared several rows above where the
   * panel had been. Three new rows landing in a form is a change worth pointing
   * at, so they carry a ring until the next edit or a couple of seconds, and the
   * toast says how many.
   */
  const [justAdded, setJustAdded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (justAdded.size === 0) return;
    const t = setTimeout(() => setJustAdded(new Set()), 2500);
    return () => clearTimeout(t);
  }, [justAdded]);

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
      setErr(
        `${displayDriverCell(clash[0].driver)} (${clash[0].start}–${clash[0].end}) và ` +
        `${displayDriverCell(clash[1].driver)} (${clash[1].start}–${clash[1].end}) trùng giờ`,
      );
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
        <div
          key={l.key}
          className={`flex flex-wrap items-center gap-1 rounded transition-colors duration-200 ${
            justAdded.has(l.key) ? "bg-indigo-50 ring-1 ring-indigo-300" : ""
          }`}
        >
          <DriverPicker value={l.driver} onChange={(v) => patch(i, { driver: v })} drivers={drivers} />
          <TimeSelect label="Từ giờ" value={l.start} onChange={(v) => patch(i, { start: v })} />
          <span aria-hidden className="text-slate-500 text-[11px]">→</span>
          <TimeSelect label="Đến giờ" value={l.end} onChange={(v) => patch(i, { end: v })} />
          {/* Two names or more and the engine ranks them by distance instead of
              always sending one person. That used to be spelled out in a line of
              instructions under the form, next to the comma the supervisor had
              to type; now that the comma is gone, this says the same thing as a
              STATE of the row rather than as a rule to remember. */}
          {splitDriverNames(l.driver).length > 1 && (
            <span
              className="shrink-0 rounded-full border border-indigo-200 bg-indigo-50 px-1.5 py-0 text-[10px] font-semibold text-indigo-800"
              title="Nhiều tài xế: hệ thống chọn người gần điểm lấy mẫu nhất"
            >
              smart
            </span>
          )}
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
      <div className="flex flex-wrap items-center gap-1">
        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={addLine} disabled={busy}>
          + Thêm ca
        </Button>
        <Button
          ref={copyBtnRef}
          size="sm" variant="outline"
          className="h-6 px-2 text-[11px]"
          aria-expanded={copyOpen}
          aria-controls={copyPanelId}
          onClick={() => setCopyOpen((v) => !v)}
          disabled={busy}
        >
          Sao chép từ điểm khác
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
      {/* Below the action row, never inside it: the panel is wide, and rendering
          it among the buttons pushed Hủy/Lưu onto a second line the moment it
          opened. */}
      <CopyFromBranch
        open={copyOpen}
        panelId={copyPanelId}
        existingKeys={lines.map((l) => copyKey(l.driver, l.start, l.end))}
        onClose={() => { setCopyOpen(false); copyBtnRef.current?.focus(); }}
        onCopy={(copied) => {
          const added: string[] = [];
          setLines((ls) => {
            // Appended, never replacing: a branch being set up may already have
            // the empty row this editor was opened from, and one line the
            // supervisor has started filling. Both survive, and the clash check
            // on save is what decides whether the result is coherent.
            const have = new Set(ls.map((l) => copyKey(l.driver, l.start, l.end)));
            const fresh = copied
              .filter((c) => !have.has(copyKey(c.driver, c.start, c.end)))
              .map((c) => {
                const key = newLineKey();
                added.push(key);
                return { key, ...c };
              });
            // A blank line the supervisor has not touched is a placeholder, not
            // a rule — drop it rather than saving an empty row beside the copy.
            const kept = ls.filter((l) => l.driver.trim() || l.start.trim() || l.end.trim() || l.row);
            return [...kept, ...fresh];
          });
          setJustAdded(new Set(added));
          toast.success(
            added.length ? `Đã chép ${added.length} ca vào form — bấm Lưu để ghi` : "Các ca này đã có trong form",
          );
        }}
      />
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
      toast.success(`${displayDriverCell(s.driver)} giờ trực ${s.window} — ${g.pickup_name}`);
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
        {/* The ABSENT side is the whole diagnosis — a hole with cover on one
            side is closed by nudging a boundary, a hole with nothing before or
            after it means the branch is simply unstaffed at that end of the day
            and needs a new rule. It reads as the exception it is. */}
        {g.before
          ? <>Ca trước <span className="tabular-nums">{g.before.window}</span></>
          : <span className="font-semibold text-amber-800">Không có ca trước</span>}
        {" · "}
        {g.after
          ? <>ca sau <span className="tabular-nums">{g.after.window}</span></>
          : <span className="font-semibold text-amber-800">không có ca sau</span>}
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
              {stretching === s.edge ? "Đang lưu…" : `Nới ${displayDriverCell(s.driver)} → ${s.window}`}
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
  overlaps,
  branchRules,
  drivers,
  parsedAt,
  onSaved,
}: {
  gaps: CoverageGap[];
  unfinished: UnfinishedConfigRow[];
  /** The rules each listed branch already has, keyed by branch. */
  overlaps: ShiftOverlap[];
  branchRules: Record<string, BranchRule[]>;
  drivers: ConfigDriver[];
  /** When the sheet behind both lists was last read. */
  parsedAt: string;
  onSaved: (key?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (gaps.length === 0 && unfinished.length === 0 && overlaps.length === 0) return null;

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
          {overlaps.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 text-rose-800 border border-rose-200 px-1.5 py-0 text-[11px] font-semibold leading-relaxed">
              {overlaps.length} trùng config
            </span>
          )}
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
              đọc sheet {parsedAt.slice(11, 16)}
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
        {/* max-w-5xl to match FailedJobsPanel's own scroll container above it.
            Without it these rows ran the full width of the card while every row
            in the panel above stopped short, so this panel's button sat alone
            out at the right edge instead of in the column the others share. */}
        {open && (
          <div id={LIST_ID} className="max-h-[38vh] max-w-5xl space-y-1.5 overflow-y-auto">
            {overlaps.length > 0 && (
              <section aria-label="Trùng config">
                <SectionHeader label="Trùng config" count={overlaps.length} tone="amber" className="pt-0.5" />
                <div className={listBox}>
                  {overlaps.map((o) => (
                    <OverlapRow
                      key={overlapKey(o)}
                      o={o}
                      rules={branchRules[o.customer_id] ?? []}
                      drivers={drivers}
                      onSaved={onSaved}
                    />
                  ))}
                </div>
              </section>
            )}
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
