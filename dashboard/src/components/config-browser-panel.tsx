"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Pencil, Search } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { foldName, replaceDriverInCell, splitDriverNames, DRIVER_SEP } from "@/lib/driver-cell";
import { displayDriverCell, splitDriverName } from "@/lib/driver-label";
import { configFilterOptions, EMPTY_CONFIG_FILTERS, filterConfigRows } from "@/lib/config-filters";
import { BranchEditor, TimeSelect } from "./config-todo-panel";
import { DriverCombobox } from "./driver-combobox";
import { FilterMultiSelect } from "./filter-multi-select";
import type { ConfigRowView } from "@/app/api/config/rows/route";
import type { BranchRule, ConfigDriver } from "@/lib/types";

/**
 * The config table, readable and searchable from the dashboard.
 *
 * Until now the only way to answer "who covers this branch, and when?" was to
 * open the workbook — which is also the only way to answer it WRONGLY, because
 * the sheet shows every row while the engine reads one tab and applies its own
 * rules to it. This shows the tab in force today, parsed the way the engine
 * parses it.
 *
 * Loaded ON DEMAND. The table is ~1,700 rows; fetching it on the dashboard's
 * 90-second poll would be paying for it continuously to answer a question asked
 * a few times a day. It loads when the panel is first opened and can be
 * refreshed by hand.
 *
 * It reads the SHEET rather than the engine's parsed config, and that is what
 * makes it useful for admin work rather than only for inspection: the parse
 * drops every row that names a branch but no driver, which is exactly the set
 * someone comes here to fix. It also keeps the sheet row, which every write path
 * addresses rows by.
 *
 * Editing opens the SAME BranchEditor the "Cần xử lý" rows use — so a branch
 * reached by searching for it is edited through the same four guarded routes,
 * the same clash check and the same re-read-before-write as one reached by the
 * engine complaining about it. The difference between the two entry points is
 * only which branches they can reach.
 */

/** How many matches to draw at a time. A blank search matches all 1,700 rows,
 *  and drawing them costs a visibly janky scroll for a list nobody reads to the
 *  end. The count states the true total and "Hiện thêm" at the foot of the
 *  table draws the next batch — the cap used to be a wall, and the only way
 *  past row 150 was to know to narrow the search. */
const RENDER_CAP = 150;

/** Cartrack's marker for a retired location, written into the name itself. */
const INACTIVE_PREFIX = /^\{inactive\}\s*/i;
const isInactive = (pickup: string) => INACTIVE_PREFIX.test(pickup);

/** Pickup identity; the destination also belongs to an editable group. */
const branchKey = (r: ConfigRowView) => r.customer_id || r.pickup;
const sameSchedule = (a: ConfigRowView, b: ConfigRowView) =>
  branchKey(a) === branchKey(b) && a.pickup === b.pickup && a.dropoff === b.dropoff;

const clockMin = (t: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * The row's window on a 24-hour strip.
 *
 * A branch's rows sit together (see sortConfigRows), so these strips stack into
 * a column where a handover, a hole or an overlap between consecutive rules is
 * something you SEE rather than work out from two pairs of digits. The digits
 * stay beside it; the strip is the shape, not the value.
 *
 * Read the way the rest of the table reads a window: both ends or it is all
 * day, and an end before the start wraps past midnight.
 */
function ShiftStrip({ start, end }: { start: string; end: string }) {
  const s = start && end ? clockMin(start) : null;
  const e = start && end ? clockMin(end) : null;
  const allDay = s === null || e === null;
  const spans: [number, number][] = allDay ? [[0, 1440]]
    : e > s ? [[s, e]]
    : e < s ? [[s, 1440], [0, e]]
    : [];
  return (
    <span aria-hidden className="relative inline-block h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-slate-100">
      {/* noon, so a morning and an afternoon strip can be told apart at a glance */}
      <span className="absolute inset-y-0 left-1/2 w-px bg-slate-300" />
      {spans.map(([a, b]) => (
        <span
          key={a}
          className={`absolute inset-y-0 ${allDay ? "bg-indigo-200" : "bg-indigo-500"}`}
          style={{ left: `${(a / 1440) * 100}%`, width: `${((b - a) / 1440) * 100}%` }}
        />
      ))}
    </span>
  );
}

/** Accent-folded, split on spaces and punctuation. */
const pieces = (s: string) => foldName(s).split(/[^a-z0-9]+/).filter(Boolean);

/**
 * A row's text as WORDS — including the words hidden inside the run-together
 * staff codes this sheet labels every branch with.
 *
 * "NVHoai" has to count as "hoai" too, because a term matches the START of a
 * word and people type the readable half: "hoai", "khoi", "thang". Splitting
 * only on spaces would bury those and turn a working search into a silent miss.
 *
 * Two breaks, both on the ORIGINAL text — the capitals are the only evidence of
 * where one word ends, and folding destroys them:
 *   DKhoi   → D Khoi     a capital after a lowercase or a digit
 *   NVHoai  → NV Hoai    the last capital of a run that starts a word
 */
function searchWords(s: string): string[] {
  return [
    // The code as WRITTEN, so typing "NVHoai" off the screen still finds it…
    ...pieces(s),
    // …and the words inside it, so typing what you can read does too.
    ...pieces(
      s.replace(/(\p{Lu}+)(?=\p{Lu}\p{Ll})/gu, "$1 ")
       .replace(/(\p{Ll}|\p{Nd})(?=\p{Lu})/gu, "$1 "),
    ),
  ];
}

/**
 * Rows matching every whitespace-separated term, accent-insensitively.
 *
 * Every term must match SOMEWHERE in the row rather than all in one field, so
 * "d014 hùng" finds the branch-and-driver combination without the typist having
 * to know which column each word lives in. Accent folding is the same one the
 * driver pickers use: "quynh" has to find "Quỳnh", or the search reads as broken
 * rather than picky.
 *
 * A term matches a word it PREFIXES, never any old substring. That is the whole
 * difference between a useful search and this, which was live: "đa khoa ái
 * nghĩa" returned "Bệnh Viện Đa Khoa Khu Vực Củ Chi", because `da` and `khoa`
 * are in "Đa Khoa", `nghia` was the driver Phan Thanh Nghĩa two columns over,
 * and `ai` sat inside "NVHo·ai·". Four hits, none of them the branch anyone
 * asked for — and the shorter the term, the more of the sheet it drags in.
 */
export function searchConfigRows(rows: readonly ConfigRowView[], query: string): ConfigRowView[] {
  // The query is split only on spaces and punctuation — never camel-split, or
  // typing one code would silently demand each of its halves as well.
  const terms = pieces(query);
  if (terms.length === 0) return rows as ConfigRowView[];
  return rows.filter((r) => {
    const words = searchWords([r.pickup, r.customer_id, r.driver, r.dropoff, r.start, r.end].join(" "));
    return terms.every((t) => words.some((w) => w.startsWith(t)));
  });
}

/**
 * Reading order: the branch, then its day, then who works it.
 *
 * The sheet's own order is the order rows were APPENDED — every rule this
 * dashboard has ever added sits at the bottom, so a branch's shifts are scattered
 * through 1,700 lines and the two rules that hand over to each other can be
 * hundreds of rows apart. That is the order a spreadsheet needs and the worst
 * possible one for reading a roster.
 *
 * Grouping by pickup and destination puts each route's whole day together, as
 * the editor and copy picker do. Within a route, time comes next: a day is read
 * forwards, and a gap or an overlap becomes visible as two adjacent
 * lines rather than something to hunt for. Driver last, to settle the rest.
 *
 * An all-day rule (no window) sorts FIRST within its branch: it is the branch's
 * general rule, and the scoped or timed ones read as exceptions beneath it.
 *
 * Retired branches ("{inactive} …") sort LAST. Collation puts the brace ahead
 * of every letter, so they used to open the table — the first screen anyone saw
 * was rules for places that no longer send work.
 *
 * Vietnamese collation, so accented names land where a Vietnamese reader looks
 * for them rather than after Z. The sheet row stays on every line, so the order
 * shown here never costs anyone the ability to find the row itself.
 */
export function sortConfigRows(rows: readonly ConfigRowView[]): ConfigRowView[] {
  const vi = new Intl.Collator("vi", { sensitivity: "base", numeric: true });
  const startMin = (r: ConfigRowView) => clockMin(r.start) ?? -1;   // no window sorts first
  return [...rows].sort((a, b) =>
    Number(isInactive(a.pickup)) - Number(isInactive(b.pickup)) ||
    vi.compare(a.pickup, b.pickup) ||
    vi.compare(a.dropoff, b.dropoff) ||
    startMin(a) - startMin(b) ||
    vi.compare(a.driver, b.driver) ||
    a.row - b.row                                        // never an arbitrary tie
  );
}

/** One branch's rows, in the shape the editor takes. Only rows that carry a
 *  sheet row can be edited — every writer addresses them by number. */
function rulesOf(rows: readonly ConfigRowView[]): BranchRule[] {
  return rows.map((r) => ({ row: r.row, driver: r.driver, start: r.start, end: r.end, dropoff: r.dropoff }));
}

/**
 * Whether a row can be addressed by a write at all.
 *
 * Every config writer re-reads the row's pickup cell and refuses if it is not
 * the branch it was told to expect. A row with a BLANK pickup passes that
 * check against any other blank cell, so the one guard standing between a
 * bulk write and the wrong line does nothing for it — those rows stay
 * single-edit only, where a human is looking at the one row they mean.
 */
const isWritable = (r: ConfigRowView) => r.pickup.trim().length > 0;

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error || `Lỗi ${res.status}`);
  return j;
}

/**
 * One bulk write, as ONE request.
 *
 * This used to loop the per-row routes, which spend two or three Sheets reads a
 * row: past ~25 rows (~15 for a delete) Google's 60-reads-a-minute quota
 * answered 429 and every remaining row failed, leaving a partial write. The bulk
 * routes read once, check every row against that read, and write once — see
 * bulkUpdateConfigRows. Rows whose branch moved are skipped and listed rather
 * than written.
 */
type BulkResult = { done: { row: number }[]; skipped: { row: number; pickup: string; reason: string }[] };

function reportBulk(label: string, res: BulkResult) {
  const first = res.skipped[0];
  const why = first ? `Dòng ${first.row} (${first.pickup}): ${first.reason}` : "";
  if (res.skipped.length === 0) toast.success(`${label}: ${res.done.length} dòng`);
  else if (res.done.length > 0) toast.warning(`${label}: ${res.done.length} dòng — bỏ qua ${res.skipped.length}. ${why}`);
  else toast.error(`Không ghi được dòng nào. ${why}`);
}

const targetBody = (rows: readonly ConfigRowView[]) => rows.map((r) => ({ row: r.row, pickup_name: r.pickup }));

type BulkMode = "driver" | "hours" | "delete";

/**
 * The same three edits the single-row editor makes, applied to every ticked row.
 *
 * One request per action, to the bulk routes (bulk-update, bulk-delete). They
 * apply the single-row routes' checks — roster names, a window with two
 * different ends, the Sunday refusal, the branch re-read per row — against ONE
 * read of the sheet, then write once.
 *
 * A driver change sends no window and a window change sends no driver, so each
 * leaves the other column of every row as it was. Rows on different shifts keep
 * them.
 */
function BulkBar({
  targets,
  drivers,
  onDone,
  onClear,
}: {
  /** The ticked rows, already filtered to the writable ones. */
  targets: ConfigRowView[];
  drivers: ConfigDriver[];
  /** A write landed: re-read the sheet (row numbers move after a delete). */
  onDone: () => void;
  onClear: () => void;
}) {
  const [mode, setMode] = useState<BulkMode | null>(null);
  const [driverCell, setDriverCell] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);

  const run = async (label: string, url: string, body: object) => {
    setBusy(true);
    try {
      reportBulk(label, await postJson(url, { ...body, rows: targetBody(targets) }));
      setMode(null);
      setArmed(false);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const applyDriver = () => {
    const cell = splitDriverNames(driverCell).join(DRIVER_SEP);
    if (!cell) return toast.error("Chọn tài xế trước");
    return run("Đã đổi tài xế", "/api/config/bulk-update", { driver_name: cell });
  };

  const applyHours = () => {
    if (!start || !end) return toast.error("Ca phải đủ cả từ và đến");
    if (start === end) return toast.error("Giờ bắt đầu và kết thúc trùng nhau — dòng sẽ không bao giờ trực");
    return run("Đã đổi ca", "/api/config/bulk-update", { shift_start: start, shift_end: end });
  };

  // The server deletes highest row first in one atomic batch, so the order
  // the rows are ticked in does not matter.
  const applyDelete = () => run("Đã xoá", "/api/config/bulk-delete", {});

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-indigo-300 bg-indigo-50/70 px-2 py-1.5">
      <span className="text-[11px] font-semibold text-indigo-900" aria-live="polite">
        {busy ? `Đang ghi ${targets.length} dòng…` : `${targets.length} dòng đã chọn`}
      </span>

      {!busy && mode === null && (
        <>
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setMode("driver")}>
            Đổi tài xế
          </Button>
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setMode("hours")}>
            Đổi ca
          </Button>
          <Button
            size="sm" variant="outline"
            className="h-6 px-2 text-[11px] text-red-700 hover:border-red-300 hover:bg-red-50"
            onClick={() => setMode("delete")}
          >
            Xoá
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[11px]" onClick={onClear}>
            Bỏ chọn
          </Button>
        </>
      )}

      {mode === "driver" && (
        <>
          <DriverCombobox
            names={splitDriverNames(driverCell)}
            onChange={(names) => setDriverCell(names.join(DRIVER_SEP))}
            drivers={drivers}
            placeholder="Tìm tài xế…"
            className="flex min-w-[180px] flex-1 flex-wrap items-center gap-1 rounded border border-slate-300 bg-white px-1 py-0.5 focus-within:ring-2 focus-within:ring-indigo-400/50"
          />
          {/* Said in full, because this is the part that surprises: the hours
              on each row are NOT touched, so a set of rows on different
              shifts keeps them. */}
          <span className="text-[11px] text-indigo-900">giữ nguyên ca của từng dòng</span>
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setMode(null)} disabled={busy}>
              Hủy
            </Button>
            <Button
              size="sm"
              className="h-6 px-2 text-[11px] bg-indigo-600 hover:bg-indigo-700"
              onClick={applyDriver}
              disabled={busy}
            >
              Áp dụng {targets.length} dòng
            </Button>
          </div>
        </>
      )}

      {mode === "hours" && (
        <>
          <TimeSelect label="Từ giờ" value={start} onChange={setStart} />
          <span className="text-[11px] text-slate-500">→</span>
          <TimeSelect label="Đến giờ" value={end} onChange={setEnd} />
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setMode(null)} disabled={busy}>
              Hủy
            </Button>
            <Button
              size="sm"
              className="h-6 px-2 text-[11px] bg-indigo-600 hover:bg-indigo-700"
              onClick={applyHours}
              disabled={busy}
            >
              Áp dụng {targets.length} dòng
            </Button>
          </div>
        </>
      )}

      {mode === "delete" && (
        <>
          {/* The count is IN the confirm, not only above it: this is the one
              action here that cannot be undone from the dashboard, and "Xoá"
              beside a stale selection reads the same whether it means two rows
              or a hundred and fifty. */}
          <span className="text-[11px] font-semibold text-red-800">
            Xoá {targets.length} dòng khỏi sheet? Không hoàn tác được.
          </span>
          <label className="flex items-center gap-1 text-[11px] text-red-800">
            <input
              type="checkbox"
              checked={armed}
              onChange={(e) => setArmed(e.target.checked)}
              className="size-3.5 accent-red-600"
            />
            Tôi chắc chắn
          </label>
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => { setMode(null); setArmed(false); }} disabled={busy}>
              Hủy
            </Button>
            <Button
              size="sm"
              className="h-6 px-2 text-[11px] bg-red-600 hover:bg-red-700"
              onClick={applyDelete}
              disabled={busy || !armed}
            >
              Xoá {targets.length} dòng
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Replace one driver with another wherever they stand in the config.
 *
 * Different from the bulk "Đổi tài xế" in the one way that matters: that one
 * OVERWRITES the cell, which on a smart row throws away every other candidate.
 * This swaps the one name and leaves the rest of the cell — and the hours, and
 * the destination — alone.
 *
 * It reaches every row that names the driver, not just the ones on screen: the
 * table is capped at a render batch and filtered, and a replacement that
 * quietly missed row 151 would leave the old driver assigned somewhere nobody
 * looked. The preview lists every row before anything is written, each can be
 * unticked, and the write is one server call that re-checks each row against
 * the live sheet.
 */
function ReplaceDriverPanel({
  rows,
  drivers,
  fromOptions,
  onDone,
  onClose,
}: {
  rows: readonly ConfigRowView[];
  /** The roster — the only names a replacement may be. */
  drivers: ConfigDriver[];
  /** Every name the loaded config mentions, roster or not: a driver who has
   *  left may already be off the roster, and those rows are the ones to move. */
  fromOptions: readonly string[];
  onDone: () => void;
  onClose: () => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const fromDrivers = useMemo<ConfigDriver[]>(
    () => fromOptions.map((name) => ({ driver_id: name, name })),
    [fromOptions],
  );
  const affected = useMemo(
    () => (from ? sortConfigRows(rows.filter((r) => splitDriverNames(r.driver).includes(from))) : []),
    [rows, from],
  );
  const writable = affected.filter(isWritable);
  const unwritable = affected.length - writable.length;
  const picked = writable.filter((r) => !excluded.has(r.row));

  const pickFrom = (names: string[]) => {
    setFrom(names[0] ?? "");
    setExcluded(new Set());
  };
  const toggle = (row: number) =>
    setExcluded((s) => {
      const next = new Set(s);
      if (!next.delete(row)) next.add(row);
      return next;
    });

  const apply = async () => {
    if (!from || !to) return toast.error("Chọn đủ hai tài xế");
    if (picked.length === 0) return toast.error("Chưa chọn dòng nào");
    setBusy(true);
    try {
      const j = await postJson("/api/config/replace-driver", {
        from, to, rows: picked.map((r) => ({ row: r.row, pickup_name: r.pickup })),
      });
      const done = (j.replaced ?? []).length as number;
      const skipped = (j.skipped ?? []) as { row: number; pickup: string; reason: string }[];
      if (skipped.length === 0) toast.success(`Đã thay tài xế trên ${done} dòng`);
      else if (done > 0) {
        toast.warning(`Đã thay ${done} dòng — bỏ qua ${skipped.length}. Dòng ${skipped[0].row} (${skipped[0].pickup}): ${skipped[0].reason}`);
      } else {
        toast.error(`Không thay được dòng nào. Dòng ${skipped[0]?.row} (${skipped[0]?.pickup}): ${skipped[0]?.reason}`);
      }
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const comboClass =
    "flex min-w-[200px] flex-1 flex-wrap items-center gap-1 rounded border border-slate-300 bg-white px-1 py-0.5 focus-within:ring-2 focus-within:ring-indigo-400/50";

  return (
    <div className="flex flex-col gap-2 rounded-md border border-indigo-300 bg-indigo-50/70 px-2 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold text-indigo-900">Thay</span>
        <DriverCombobox
          names={from ? [from] : []}
          onChange={pickFrom}
          drivers={fromDrivers}
          max={1}
          placeholder="Tài xế đang có trong config…"
          ariaLabel="Tài xế cần thay"
          className={comboClass}
        />
        <span className="text-[11px] font-semibold text-indigo-900">bằng</span>
        <DriverCombobox
          names={to ? [to] : []}
          onChange={(names) => setTo(names[0] ?? "")}
          drivers={drivers.filter((d) => d.name !== from)}
          max={1}
          placeholder="Tài xế thay thế…"
          ariaLabel="Tài xế thay thế"
          className={comboClass}
        />
      </div>

      {from && (
        <>
          <p className="text-[11px] text-indigo-900">
            {writable.length === 0
              ? "Tài xế này không có dòng nào sửa được."
              : <>
                  <span className="font-semibold tabular-nums">{picked.length}</span>/{writable.length} dòng sẽ đổi ·
                  chỉ đổi tên tài xế, giữ nguyên ca, điểm giao và các tài xế khác trên dòng smart
                </>}
            {unwritable > 0 && (
              <span className="ml-1 font-semibold text-amber-700">
                · {unwritable} dòng không có điểm lấy — sửa từng dòng bằng nút Sửa
              </span>
            )}
          </p>
          {writable.length > 0 && (
            <ul className="max-h-60 overflow-y-auto rounded border border-indigo-200 bg-white text-xs">
              {writable.map((r) => {
                const after = to ? replaceDriverInCell(r.driver, from, to) : null;
                return (
                  <li key={r.row} className="flex items-start gap-2 border-b border-slate-100 px-2 py-1 last:border-b-0">
                    <input
                      type="checkbox"
                      checked={!excluded.has(r.row)}
                      onChange={() => toggle(r.row)}
                      aria-label={`Đổi dòng ${r.row} — ${r.pickup}`}
                      className="mt-0.5 size-3.5 accent-indigo-600"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2">
                        <span className="font-medium text-slate-900">{r.pickup.replace(INACTIVE_PREFIX, "")}</span>
                        <span className="tabular-nums text-slate-600">{r.start && r.end ? `${r.start}–${r.end}` : "cả ngày"}</span>
                        {r.dropoff && <span className="text-slate-600">→ {r.dropoff}</span>}
                        {r.smart && (
                          <span className="rounded-full border border-sky-200 bg-sky-50 px-1 text-[10px] font-semibold text-sky-700">smart</span>
                        )}
                      </div>
                      {/* Before → after only where it says more than the two
                          pickers above: a smart row, where the rest of the cell
                          is what the reader needs to see survive. */}
                      {r.smart && after && (
                        <div className="text-[11px] text-slate-600">
                          <span className="line-through">{displayDriverCell(r.driver)}</span>
                          <span className="mx-1">→</span>
                          <span className="text-slate-800">{displayDriverCell(after)}</span>
                        </div>
                      )}
                    </div>
                    <span className="font-mono text-[10px] text-slate-500">{r.row}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <div className="flex justify-end gap-1">
        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={onClose} disabled={busy}>
          Đóng
        </Button>
        <Button
          size="sm"
          className="h-6 px-2 text-[11px] bg-indigo-600 hover:bg-indigo-700"
          onClick={() => void apply()}
          disabled={busy || !from || !to || picked.length === 0}
        >
          {busy ? "Đang ghi…" : `Thay ${picked.length} dòng`}
        </Button>
      </div>
    </div>
  );
}

/** A free-text filter, labelled and sized like the FilterMultiSelect beside it. */
function ContainsInput({ label, value, onChange, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-[11px] font-medium text-slate-700">{label}</label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 w-full rounded border border-slate-300 bg-white px-2 text-xs text-slate-900 outline-none placeholder:text-slate-500 focus:ring-2 focus:ring-indigo-400/50"
      />
    </div>
  );
}

export function ConfigBrowserPanel({ drivers }: { drivers: ConfigDriver[] }) {
  const [rows, setRows] = useState<ConfigRowView[]>([]);
  const [filters, setFilters] = useState(EMPTY_CONFIG_FILTERS);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ tab: string; fetchedAt: string } | null>(null);
  const [replacing, setReplacing] = useState(false);
  const loadedRef = useRef(false);

  /** `fresh` is the Tải lại button: it bypasses the route's own cache as well as
   *  the browser's. Without it the button re-fetched a route that answered from
   *  memory for five minutes, so pressing it did nothing at all — only the
   *  "đọc HH:MM" stamp, which never moved, gave it away. An ordinary load stays
   *  cheap: the route compares the shared config stamp and re-reads the sheet
   *  only when a write has actually moved it. */
  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/config/rows${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && !Array.isArray(data.rows)) throw new Error(data.error || `Lỗi ${res.status}`);
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setSelected(new Set());
      setMeta({ tab: data.tab ?? "", fetchedAt: data.fetchedAt ?? "" });
      if (data.error) setErr(String(data.error));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Once, when the tab is first shown — not on every mount of a hidden panel.
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void load();
  }, [load]);

  const optionValues = useMemo(() => configFilterOptions(rows), [rows]);
  const driverOptions = useMemo(() => optionValues.drivers.map((value) => {
    const { name, code } = splitDriverName(value);
    return { value, label: code ? `${name} · ${code}` : name };
  }), [optionValues.drivers]);
  const pickupOptions = useMemo(
    () => optionValues.pickups.map((value) => ({ value, label: value })),
    [optionValues.pickups],
  );
  const dropoffOptions = useMemo(
    () => optionValues.dropoffs.map((value) => ({ value, label: value || "mọi điểm" })),
    [optionValues.dropoffs],
  );
  const matches = useMemo(() => sortConfigRows(filterConfigRows(rows, filters)), [rows, filters]);
  // The cap applies AFTER the sort, so it is the first N of a stable ordering
  // rather than an arbitrary slice of the sheet. Which rows get cut is then
  // something the reader can predict, and narrowing the search is a way to
  // reach the rest rather than a lottery.
  const [limit, setLimit] = useState(RENDER_CAP);
  const shown = matches.slice(0, limit);

  /** One route at a time: the editor writes, and two open on the same route
   *  would each hold a baseline taken before the other's writes landed.
   *
   *  The route open in the editor, and the row whose Sửa was clicked.
   *
   *  The row is carried as well as the branch because the editor renders under
   *  THAT row: a branch has several, and opening under the first of them would
   *  still move the form away from the button that summoned it. */
  const [editing, setEditing] = useState<{ branch: string; pickup: string; dropoff: string; row: number } | null>(null);
  const editingRows = useMemo(
    () => (editing ? rows.filter((r) =>
      branchKey(r) === editing.branch && r.pickup === editing.pickup && r.dropoff === editing.dropoff
    ) : []),
    [rows, editing],
  );

  /**
   * Ticked rows, by SHEET ROW.
   *
   * Cleared after every bulk write and every reload, deliberately: a delete
   * renumbers everything below it, so a selection made before one is a set of
   * numbers that now point at different lines. The guard on each route would
   * refuse those, but a selection that silently means something else is not a
   * thing to keep on screen.
   */
  const selectable = useMemo(() => shown.filter(isWritable), [shown]);

  /** For each drawn row, the index of the first row of its route run. A
   *  route's rows are adjacent (sortConfigRows), so the run is the route as
   *  far as the current filters show it. */
  const { runStart, runSize } = useMemo(() => {
    const starts: number[] = [];
    const sizes = new Map<number, number>();
    shown.forEach((r, i) => {
      const prev = shown[i - 1];
      const start = i > 0 && sameSchedule(prev, r) ? starts[i - 1] : i;
      starts.push(start);
      sizes.set(start, (sizes.get(start) ?? 0) + 1);
    });
    return { runStart: starts, runSize: sizes };
  }, [shown]);
  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.row) && isWritable(r)),
    [rows, selected],
  );
  const allShownPicked = selectable.length > 0 && selectable.every((r) => selected.has(r.row));
  const toggleRow = (row: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(row)) next.add(row);
      return next;
    });
  // Everything currently DRAWN, which is the search's results up to the render
  // cap — the count line above says when those differ, so the box never
  // silently reaches rows nobody has looked at.
  const toggleAllShown = () =>
    setSelected((s) => {
      const next = new Set(s);
      if (allShownPicked) for (const r of selectable) next.delete(r.row);
      else for (const r of selectable) next.add(r.row);
      return next;
    });
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const updateFilters = (next: typeof filters) => {
    setFilters(next);
    setLimit(RENDER_CAP);
    clearSelection();
  };
  const activeFilters = [
    filters.query.trim(), filters.pickupContains.trim(), filters.dropoffContains.trim(),
  ].filter(Boolean).length + filters.drivers.length + filters.pickups.length + filters.dropoffs.length;
  const hasFilters = activeFilters > 0;

  return (
    <Card className="gap-0 py-2 h-full flex flex-col border-slate-200">
      <CardContent className="px-3 flex flex-1 flex-col min-h-0 gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={filters.query}
              onChange={(e) => updateFilters({ ...filters, query: e.target.value })}
              placeholder="Tìm chính xác điểm, mã, tài xế…"
              aria-label="Tìm trong config"
              className="h-7 w-full rounded border border-slate-300 bg-white py-1 pl-7 pr-2 text-xs text-slate-900 outline-none placeholder:text-slate-500 focus:ring-2 focus:ring-indigo-400/50"
            />
          </div>
          {/* Freshness beside the button that renews it, rather than on a
              status line below the filters where nothing could be done about it. */}
          {(meta?.tab || meta?.fetchedAt) && (
            <span className="text-[11px] text-slate-500">
              {meta?.tab}{meta?.tab && meta?.fetchedAt && " · "}{meta?.fetchedAt && `đọc ${meta.fetchedAt.slice(11, 16)}`}
            </span>
          )}
          <Button
            size="sm" variant={replacing ? "default" : "outline"}
            className={`h-7 px-2 text-[11px] ${replacing ? "bg-indigo-600 hover:bg-indigo-700" : ""}`}
            aria-expanded={replacing}
            onClick={() => setReplacing((v) => !v)}
            disabled={rows.length === 0}
          >
            Thay tài xế
          </Button>
          <Button
            size="sm" variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => void load(true)}
            disabled={loading}
          >
            {loading ? "Đang tải…" : "Tải lại"}
          </Button>
        </div>

        {/* One row of five on a wide screen. The two "chứa chữ" boxes used to
            hang under their pickers with nothing under the driver picker, which
            left a hole in the grid and cost a whole row above the table. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
          <FilterMultiSelect
            label="Tài xế là một trong"
            values={[...filters.drivers]}
            options={driverOptions}
            onChange={(values) => updateFilters({ ...filters, drivers: values })}
            placeholder="Chọn tài xế…"
          />
          <FilterMultiSelect
            label="Điểm lấy là một trong"
            values={[...filters.pickups]}
            options={pickupOptions}
            onChange={(values) => updateFilters({ ...filters, pickups: values })}
            placeholder="Chọn điểm lấy…"
          />
          <ContainsInput
            label="Điểm lấy chứa chữ"
            value={filters.pickupContains}
            onChange={(v) => updateFilters({ ...filters, pickupContains: v })}
            placeholder="vd. Bàu Cát"
          />
          <FilterMultiSelect
            label="Điểm giao là một trong"
            values={[...filters.dropoffs]}
            options={dropoffOptions}
            onChange={(values) => updateFilters({ ...filters, dropoffs: values })}
            placeholder="Chọn điểm giao…"
          />
          <ContainsInput
            label="Điểm giao chứa chữ"
            value={filters.dropoffContains}
            onChange={(v) => updateFilters({ ...filters, dropoffContains: v })}
            placeholder="vd. D001"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-slate-600" aria-live="polite">
            {hasFilters
              ? <><span className="font-semibold tabular-nums text-slate-800">{matches.length}</span> / {rows.length} dòng khớp</>
              : <><span className="font-semibold tabular-nums text-slate-800">{rows.length}</span> dòng</>}
            {matches.length > shown.length && <span className="text-slate-500"> · đang hiện {shown.length}</span>}
          </p>
          {hasFilters && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-slate-600"
              onClick={() => updateFilters(EMPTY_CONFIG_FILTERS)}
            >
              Xoá {activeFilters} bộ lọc
            </Button>
          )}
        </div>

        {err && <div role="alert" className="text-[11px] text-red-600">{err}</div>}

        {replacing && (
          <ReplaceDriverPanel
            rows={rows}
            drivers={drivers}
            fromOptions={optionValues.drivers}
            onDone={() => { setReplacing(false); clearSelection(); void load(true); }}
            onClose={() => setReplacing(false)}
          />
        )}

        {selectedRows.length > 0 && (
          <BulkBar
            targets={selectedRows}
            drivers={drivers}
            onDone={() => { clearSelection(); void load(true); }}
            onClear={clearSelection}
          />
        )}

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-slate-200">
          {shown.length === 0 ? (
            <p className="px-2 py-3 text-xs text-slate-500">
              {loading ? "Đang tải config…" : rows.length === 0 ? "Chưa đọc được config." : "Không tìm thấy dòng nào."}
            </p>
          ) : (
            <table className="w-full text-xs">
              {/* z-10: the shift strips are positioned, and without a stacking
                  order of its own the sticky header scrolled UNDER them. */}
              <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] text-slate-600">
                <tr>
                  <th className="w-8 px-2 py-1 text-left font-medium">
                    <input
                      type="checkbox"
                      checked={allShownPicked}
                      // Partly ticked reads as its own state rather than as
                      // "off": the box is about the rows on screen, and a
                      // hand-picked few of them is neither.
                      ref={(el) => {
                        if (el) el.indeterminate = !allShownPicked && selectable.some((r) => selected.has(r.row));
                      }}
                      onChange={toggleAllShown}
                      disabled={selectable.length === 0}
                      aria-label={`Chọn ${selectable.length} dòng đang hiện`}
                      title={`Chọn tất cả ${selectable.length} dòng đang hiện`}
                      className="size-3.5 accent-indigo-600"
                    />
                  </th>
                  <th className="w-14 px-2 py-1 text-left font-medium"><span className="sr-only">Sửa</span></th>
                  <th className="px-2 py-1 text-left font-medium">Điểm lấy</th>
                  <th className="px-2 py-1 text-left font-medium">Tài xế</th>
                  <th className="px-2 py-1 text-left font-medium whitespace-nowrap">Ca</th>
                  <th className="px-2 py-1 text-left font-medium whitespace-nowrap">Điểm giao</th>
                  <th className="px-2 py-1 text-right font-medium" title="Số dòng trên sheet">Dòng</th>
                </tr>
              </thead>
              <tbody>
                {shown.flatMap((r, i) => {
                  const branch = branchKey(r);
                  // A branch's rows are adjacent (sortConfigRows), so its name
                  // is printed once and the rest of the run reads as that
                  // branch's day. Repeating it on every line made four rows of
                  // one clinic look like four clinics.
                  const first = shown[runStart[i]];
                  const firstOfBranch = runStart[i] === i;
                  const lastOfBranch = i === shown.length - 1 || runStart[i + 1] !== runStart[i];
                  const runLength = runSize.get(runStart[i]) ?? 1;
                  const inactive = isInactive(r.pickup);
                  // Every row of the route being edited is marked: the editor
                  // holds the route's WHOLE day, so these rows are the very
                  // things it is about to rewrite.
                  const inBranch = !!editing && editing.branch === branch && editing.pickup === r.pickup && editing.dropoff === r.dropoff;
                  // Keyed to the run's first row, which carries the one button.
                  const runOpen = !!editing && editing.row === first.row;
                  return [(
                  <tr
                    key={r.row}
                    className={`align-top ${firstOfBranch ? "border-t border-slate-200" : ""} ${
                      selected.has(r.row) ? "bg-indigo-50" : inBranch ? "bg-indigo-50/60" : "hover:bg-slate-50"
                    }`}
                  >
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        checked={selected.has(r.row)}
                        onChange={() => toggleRow(r.row)}
                        disabled={!isWritable(r)}
                        aria-label={`Chọn dòng ${r.row}${r.pickup ? ` — ${r.pickup}` : ""}`}
                        title={isWritable(r) ? undefined : "Dòng không có điểm lấy — sửa từng dòng bằng nút Sửa"}
                        className="size-3.5 accent-indigo-600"
                      />
                    </td>
                    <td className="px-2 py-1">
                      {/* ONE button per branch, on the row that names it. Every
                          row's Sửa opened the same editor — the branch's whole
                          day — so a column of identical buttons promised a
                          per-row edit that did not exist. Ghost, not outlined,
                          but always visible: a hover-only button would be
                          invisible on the tablets dispatch also uses. */}
                      {firstOfBranch && (
                        <Button
                          size="sm" variant={runOpen ? "default" : "ghost"}
                          className={`h-6 gap-1 px-1.5 text-[11px] font-normal ${
                            runOpen ? "bg-indigo-600 hover:bg-indigo-700" : "text-indigo-700 hover:bg-indigo-50 hover:text-indigo-800"
                          }`}
                          aria-expanded={runOpen}
                          aria-label={runOpen ? "Đóng" : `Sửa ${r.pickup || branch} → ${r.dropoff || "mọi điểm"}${runLength > 1 ? ` (${runLength} dòng)` : ""}`}
                          title={runLength > 1 ? `Sửa ${runLength} dòng cho ${r.dropoff || "mọi điểm giao"}` : undefined}
                          onClick={() => setEditing(runOpen ? null : { branch, pickup: r.pickup, dropoff: r.dropoff, row: r.row })}
                          disabled={!r.customer_id && !r.pickup}
                        >
                          {!runOpen && <Pencil aria-hidden className="size-3" />}
                          {runOpen ? "Đóng" : "Sửa"}
                        </Button>
                      )}
                    </td>
                    <td className="px-2 py-1">
                      {firstOfBranch ? (
                        <>
                          {inactive && (
                            <span className="mr-1.5 rounded border border-slate-200 bg-slate-100 px-1 text-[10px] font-medium text-slate-600">
                              ngưng
                            </span>
                          )}
                          <span className={inactive ? "text-slate-500" : "font-medium text-slate-900"}>
                            {r.pickup ? r.pickup.replace(INACTIVE_PREFIX, "") : <span className="text-slate-500">—</span>}
                          </span>
                        </>
                      ) : (
                        // Still named for a screen reader, which reads a row
                        // on its own and has no run above it to lean on.
                        <span className="sr-only">{r.pickup}</span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-slate-700">
                      {r.driver ? displayDriverCell(r.driver) : <span className="text-amber-700">chưa có tài xế</span>}
                      {r.smart && (
                        <span className="ml-1.5 rounded-full border border-sky-200 bg-sky-50 px-1 py-0 text-[10px] font-semibold text-sky-700">
                          smart
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap">
                      <span className="inline-flex items-center gap-2">
                        <ShiftStrip start={r.start} end={r.end} />
                        {r.start && r.end
                          ? <span className="tabular-nums text-slate-700">{r.start}–{r.end}</span>
                          : <span className="text-slate-500">cả ngày</span>}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-slate-700">
                      {r.dropoff || <span className="whitespace-nowrap text-slate-500">mọi điểm</span>}
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-[10px] text-slate-500">{r.row}</td>
                  </tr>
                  ),
                  // Directly beneath the branch it was opened from — under its
                  // LAST row, so the run stays in one piece above the form that
                  // rewrites it. It used to render in its own box ABOVE the
                  // table, where the reader was not looking and often scrolled
                  // out of view; an expander that opens where it was asked for
                  // is what the "Cần xử lý" rows already do with this editor.
                  runOpen && lastOfBranch && editingRows.length > 0 ? (
                    <tr key={`${r.row}-edit`} className="bg-indigo-50/60">
                      <td colSpan={7} className="px-2 pb-2">
                        <BranchEditor
                          pickupName={editingRows[0].pickup}
                          dropoffName={editingRows[0].dropoff}
                          rules={rulesOf(editingRows)}
                          drivers={drivers}
                          onCancel={() => setEditing(null)}
                          onDone={() => { setEditing(null); void load(); }}
                        />
                      </td>
                    </tr>
                  ) : null,
                  ];
                })}
              </tbody>
            </table>
          )}
          {matches.length > shown.length && (
            <div className="flex items-center justify-center gap-2 border-t border-slate-200 px-2 py-2 text-[11px] text-slate-600">
              <span>Đang hiện {shown.length}/{matches.length} dòng</span>
              <Button
                size="sm" variant="outline" className="h-6 px-2 text-[11px]"
                onClick={() => setLimit((n) => n + RENDER_CAP)}
              >
                Hiện thêm {Math.min(RENDER_CAP, matches.length - shown.length)}
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
