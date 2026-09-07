"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { foldName, splitDriverNames, DRIVER_SEP } from "@/lib/driver-cell";
import { displayDriverCell } from "@/lib/driver-label";
import { BranchEditor, TimeSelect } from "./config-todo-panel";
import { DriverCombobox } from "./driver-combobox";
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

/** How many matches to draw. A blank search matches all 1,700 rows, and drawing
 *  them costs a visibly janky scroll for a list nobody reads to the end — the
 *  count below the box always states the true total, so the cap never hides that
 *  there is more. */
const RENDER_CAP = 150;

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
 * Grouping by pickup puts a branch's whole day together, which is the unit every
 * other part of this feature already works in (the editor, the copy picker, the
 * overlap audit). Within a branch, time — because a day is read forwards, and a
 * gap or an overlap between consecutive rules becomes visible as two adjacent
 * lines rather than something to hunt for. Driver last, to settle the rest.
 *
 * An all-day rule (no window) sorts FIRST within its branch: it is the branch's
 * general rule, and the scoped or timed ones read as exceptions beneath it.
 *
 * Vietnamese collation, so accented names land where a Vietnamese reader looks
 * for them rather than after Z. The sheet row stays on every line, so the order
 * shown here never costs anyone the ability to find the row itself.
 */
export function sortConfigRows(rows: readonly ConfigRowView[]): ConfigRowView[] {
  const vi = new Intl.Collator("vi", { sensitivity: "base", numeric: true });
  const startMin = (r: ConfigRowView) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(r.start.trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;   // no window sorts first
  };
  return [...rows].sort((a, b) =>
    vi.compare(a.pickup, b.pickup) ||
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
 * One bulk write, row by row.
 *
 * SEQUENTIAL, never parallel: these all land on one sheet, and the delete path
 * additionally SHIFTS every row below the one it removes — two in flight would
 * be reading each other's aftermath.
 *
 * It runs to the END rather than stopping at the first failure, and says what
 * landed. Carrying on is safe because it is not this loop that protects the
 * sheet: every route re-reads its row and refuses when the branch sitting
 * there is not the one being addressed, so a row that drifted is skipped
 * rather than overwritten. Stopping instead would leave a partial write with
 * no account of which rows were still pending.
 */
async function runBulk(
  targets: readonly ConfigRowView[],
  step: (r: ConfigRowView) => Promise<void>,
  onProgress: (done: number) => void,
): Promise<{ ok: number; errors: string[] }> {
  let ok = 0;
  const errors: string[] = [];
  for (let i = 0; i < targets.length; i++) {
    const r = targets[i];
    try {
      await step(r);
      ok++;
    } catch (e) {
      errors.push(`Dòng ${r.row} (${r.pickup}): ${e instanceof Error ? e.message : String(e)}`);
    }
    onProgress(i + 1);
  }
  return { ok, errors };
}

type BulkMode = "driver" | "hours" | "delete";

/**
 * The same three edits the single-row editor makes, applied to every ticked row.
 *
 * It writes through the EXISTING guarded routes — `complete-row` for a driver
 * or a window, `delete-row` for a removal — one call per row, rather than a
 * bulk endpoint of its own. That is what keeps the roster check, the
 * re-read-before-write and the Sunday refusal identical to what a single edit
 * gets: bulk here means "do this repeatedly", not "do this a second way".
 *
 * Two things the shape of those routes decides for us:
 *   - a window change also sends the row's EXISTING driver, because the route
 *     always writes the driver cell — so a row with no driver cannot take one
 *     and is counted out before the run rather than failing inside it;
 *   - a driver change sends NO window, which leaves each row's own hours
 *     alone. Rows on different shifts keep them.
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
  const [done, setDone] = useState(0);
  const [armed, setArmed] = useState(false);

  // A window write carries the driver cell with it, so a driverless row has
  // nothing to send. Named up front — "2 dòng chưa có tài xế sẽ bị bỏ qua" is
  // something to see before pressing, not to read in the error list after.
  const driverless = targets.filter((r) => !r.driver.trim());
  const hourTargets = targets.filter((r) => r.driver.trim());

  const finish = (label: string, res: { ok: number; errors: string[] }) => {
    if (res.errors.length === 0) toast.success(`${label}: ${res.ok} dòng`);
    else if (res.ok > 0) toast.warning(`${label}: ${res.ok} dòng — ${res.errors.length} lỗi. ${res.errors[0]}`);
    else toast.error(`Không ghi được dòng nào. ${res.errors[0] ?? ""}`);
    setMode(null);
    setArmed(false);
    setDone(0);
    onDone();
  };

  const run = async (label: string, rows: readonly ConfigRowView[], step: (r: ConfigRowView) => Promise<void>) => {
    setBusy(true);
    setDone(0);
    const res = await runBulk(rows, step, setDone);
    setBusy(false);
    finish(label, res);
  };

  const applyDriver = () => {
    const cell = splitDriverNames(driverCell).join(DRIVER_SEP);
    if (!cell) return toast.error("Chọn tài xế trước");
    return run("Đã đổi tài xế", targets, (r) =>
      postJson("/api/config/complete-row", {
        row: r.row, pickup_name: r.pickup, driver_name: cell,
      }).then(() => undefined),
    );
  };

  const applyHours = () => {
    if (!start || !end) return toast.error("Ca phải đủ cả từ và đến");
    if (start === end) return toast.error("Giờ bắt đầu và kết thúc trùng nhau — dòng sẽ không bao giờ trực");
    if (hourTargets.length === 0) return toast.error("Các dòng đã chọn đều chưa có tài xế");
    return run("Đã đổi ca", hourTargets, (r) =>
      postJson("/api/config/complete-row", {
        row: r.row, pickup_name: r.pickup, driver_name: r.driver,
        shift_start: start, shift_end: end,
      }).then(() => undefined),
    );
  };

  const applyDelete = () =>
    // HIGHEST ROW FIRST. Removing a row shifts every row below it up by one,
    // so descending order leaves the rows still to go untouched above the
    // cut. Ascending would walk into numbers that had all moved.
    run("Đã xoá", [...targets].sort((a, b) => b.row - a.row), (r) =>
      postJson("/api/config/delete-row", { row: r.row, pickup_name: r.pickup }).then(() => undefined),
    );

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-indigo-300 bg-indigo-50/70 px-2 py-1.5">
      <span className="text-[11px] font-semibold text-indigo-900" aria-live="polite">
        {busy ? `Đang ghi ${done}/${targets.length}…` : `${targets.length} dòng đã chọn`}
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
          {driverless.length > 0 && (
            <span className="text-[11px] font-semibold text-amber-700">
              bỏ qua {driverless.length} dòng chưa có tài xế
            </span>
          )}
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
              Áp dụng {hourTargets.length} dòng
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

export function ConfigBrowserPanel({ drivers }: { drivers: ConfigDriver[] }) {
  const [rows, setRows] = useState<ConfigRowView[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ tab: string; fetchedAt: string } | null>(null);
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

  const matches = useMemo(() => sortConfigRows(searchConfigRows(rows, q)), [rows, q]);
  // The cap applies AFTER the sort, so it is the first N of a stable ordering
  // rather than an arbitrary slice of the sheet. Which rows get cut is then
  // something the reader can predict, and narrowing the search is a way to
  // reach the rest rather than a lottery.
  const shown = matches.slice(0, RENDER_CAP);

  /** One branch at a time: the editor writes, and two open on the same branch
   *  would each hold a baseline taken before the other's writes landed.
   *
   *  The branch open in the editor, and the row whose Sửa was clicked.
   *
   *  The row is carried as well as the branch because the editor renders under
   *  THAT row: a branch has several, and opening under the first of them would
   *  still move the form away from the button that summoned it. */
  const [editing, setEditing] = useState<{ branch: string; row: number } | null>(null);
  const editingRows = useMemo(
    () => (editing ? rows.filter((r) => (r.customer_id || r.pickup) === editing.branch) : []),
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
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const selectable = useMemo(() => shown.filter(isWritable), [shown]);
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

  return (
    <Card className="py-2 h-full flex flex-col border-slate-200">
      <CardContent className="px-3 flex flex-col min-h-0 gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Tìm điểm, mã, tài xế…"
              aria-label="Tìm trong config"
              className="w-full rounded border border-slate-300 bg-white py-1 pl-7 pr-2 text-xs outline-none focus:ring-2 focus:ring-indigo-400/50"
            />
          </div>
          <Button
            size="sm" variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => void load(true)}
            disabled={loading}
          >
            {loading ? "Đang tải…" : "Tải lại"}
          </Button>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-slate-500">
          <span>
            {matches.length}/{rows.length} dòng
            {matches.length > shown.length && ` · hiện ${shown.length} đầu tiên`}
          </span>
          {meta?.tab && <span className="text-slate-400">{meta.tab}</span>}
          {meta?.fetchedAt && <span className="text-slate-400">đọc {meta.fetchedAt.slice(11, 16)}</span>}
        </div>

        {err && <div role="alert" className="text-[11px] text-red-600">{err}</div>}

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
              <thead className="sticky top-0 bg-slate-50 text-[11px] text-slate-600">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">
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
                  <th className="px-2 py-1 text-left font-medium sr-only">Sửa</th>
                  <th className="px-2 py-1 text-left font-medium">Điểm lấy</th>
                  <th className="px-2 py-1 text-left font-medium">Tài xế</th>
                  <th className="px-2 py-1 text-left font-medium">Ca</th>
                  <th className="px-2 py-1 text-left font-medium">Điểm giao</th>
                  <th className="px-2 py-1 text-right font-medium">Dòng</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.flatMap((r) => {
                  const branch = r.customer_id || r.pickup;
                  // Every row of the branch being edited is marked, not just the
                  // one clicked: the editor holds the branch's WHOLE day, so the
                  // other rows are the very things it is about to rewrite, and
                  // leaving them looking untouched invited a second Sửa on a row
                  // already open in the form above.
                  const inBranch = !!editing && editing.branch === branch;
                  const openHere = !!editing && editing.row === r.row;
                  return [(
                  <tr
                    key={r.row}
                    className={`align-top ${
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
                      <Button
                        size="sm" variant={openHere ? "default" : "outline"}
                        className={`h-6 px-2 text-[11px] font-normal ${openHere ? "bg-indigo-600 hover:bg-indigo-700" : ""}`}
                        aria-expanded={openHere}
                        onClick={() => setEditing(openHere ? null : { branch, row: r.row })}
                        disabled={!r.customer_id && !r.pickup}
                      >
                        {openHere ? "Đóng" : "Sửa"}
                      </Button>
                    </td>
                    <td className="px-2 py-1">
                      <span className="text-slate-800">{r.pickup || <span className="text-slate-400">—</span>}</span>
                      {r.customer_id && (
                        <span className="ml-1.5 font-mono text-[10px] text-slate-400">{r.customer_id}</span>
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
                    <td className="px-2 py-1 tabular-nums text-slate-600">
                      {r.start && r.end ? `${r.start}–${r.end}` : <span className="text-slate-400">cả ngày</span>}
                    </td>
                    <td className="px-2 py-1 text-slate-500">
                      {r.dropoff || <span className="text-slate-400">mọi điểm</span>}
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-[10px] text-slate-400">{r.row}</td>
                  </tr>
                  ),
                  // Directly beneath the row it was opened from, which is the
                  // whole point. It used to render in its own box ABOVE the
                  // table, on the reasoning that expanding a row inside a
                  // 150-row scroller pushes the reader's place off screen — but
                  // the form then appeared somewhere the reader was not looking,
                  // often scrolled out of view entirely, with nothing tying it to
                  // the row whose button had just been pressed. An expander that
                  // opens where it was asked for is what the "Cần xử lý" rows
                  // already do with this same editor; the config tab was the one
                  // place that did something else.
                  openHere && editingRows.length > 0 ? (
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
        </div>
      </CardContent>
    </Card>
  );
}
