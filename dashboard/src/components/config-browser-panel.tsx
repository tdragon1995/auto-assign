"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowRightLeft, Building2, ChevronDown, Pencil, Search, SlidersHorizontal, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { foldName, replaceDriverInCell, splitDriverNames, DRIVER_SEP } from "@/lib/driver-cell";
import { displayDriverCell, splitDriverName } from "@/lib/driver-label";
import { configFilterOptions, EMPTY_CONFIG_FILTERS, filterConfigRows, usesTextInput } from "@/lib/config-filters";
import type { ConfigTimeOperator } from "@/lib/config-filters";
import { BranchEditor, TimeSelect } from "./config-todo-panel";
import { DriverCombobox } from "./driver-combobox";
import { FilterMultiSelect } from "./filter-multi-select";
import { HoverPanel } from "./hover-panel";
import { MasterProfileEditor } from "./master-profile-editor";
import { MasterProfileDetails, type ClientMeta, type DriverMeta } from "./master-profile-details";
import type { ConfigRowView } from "@/app/api/config/rows/route";
import type { BranchRule, ConfigDriver } from "@/lib/types";
import { resolveConfigDay, type ConfigDay } from "@/lib/config-day";
import { isInactiveLocation as isInactive, locationName } from "@/lib/location-status";

/** Browse either roster on demand, reusing the to-do editor for weekday rules. */

/** How many matches to draw at a time. A blank search matches all 1,700 rows,
 *  and drawing them costs a visibly janky scroll for a list nobody reads to the
 *  end. The count states the true total and "Hiện thêm" at the foot of the
 *  table draws the next batch — the cap used to be a wall, and the only way
 *  past row 150 was to know to narrow the search. */
const RENDER_CAP = 150;
let sessionMetadata: { clients: ClientMeta[]; drivers: DriverMeta[]; refreshKey: number } | null = null;
const clientName = (c: ClientMeta) => String(c.cartrack.customer_name ?? c.customer_id);

/** Cartrack's marker for a retired location, written into the name itself. */

/** Pickup identity; the destination also belongs to an editable group. */
const branchKey = (r: ConfigRowView) => r.customer_id || r.pickup;
const sameSchedule = (a: ConfigRowView, b: ConfigRowView) =>
  branchKey(a) === branchKey(b) && a.pickup === b.pickup && a.dropoff === b.dropoff;

const clockMin = (t: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

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
    Number(!!a.unmapped) - Number(!!b.unmapped) ||
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
  return rows.filter((r) => !r.unmapped).map((r) => ({ row: r.row, rule_id:r.rule_id, revision:r.revision, assignment_mode:r.assignment_mode, driver: r.driver, start: r.start, end: r.end, dropoff: r.dropoff, alt_drop_off_id:r.alt_drop_off_id }));
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
const isWritable = (r: ConfigRowView) => !r.unmapped && !isInactive(r.pickup) && r.pickup.trim().length > 0;

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

const targetBody = (rows: readonly ConfigRowView[]) => rows.map((r) => ({ row: r.row, pickup_name: r.pickup, expected_row: { rule_id:r.rule_id, revision:r.revision, driver: r.driver, start: r.start, end: r.end, dropoff: r.dropoff } }));

type BulkMode = "driver" | "hours" | "both" | "schedule" | "delete";

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
  configDay,
  targets,
  allRows,
  drivers,
  locations,
  onDone,
  onClear,
}: {
  configDay: ConfigDay;
  /** The ticked rows, already filtered to the writable ones. */
  targets: ConfigRowView[];
  allRows: ConfigRowView[];
  drivers: ConfigDriver[];
  locations: {id:string;name:string}[];
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
  const [scheduleTargets, setScheduleTargets] = useState<{pickup:string;customer_id:string;dropoff:string;rules:BranchRule[]}[]>([]);

  const run = async (label: string, url: string, body: object) => {
    setBusy(true);
    try {
      reportBulk(label, await postJson(url, { ...body, config_day: configDay, rows: targetBody(targets) }));
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
    if (!start && !end) return toast.error("Chọn giờ cần đổi; giờ trống sẽ giữ nguyên");
    if (start && end && start === end) return toast.error("Giờ bắt đầu và kết thúc trùng nhau — dòng sẽ không bao giờ trực");
    return run("Đã đổi ca", "/api/config/bulk-update", { shift_start: start, shift_end: end });
  };

  // The server deletes highest row first in one atomic batch, so the order
  // the rows are ticked in does not matter.
  const applyDelete = () => run("Đã xoá", "/api/config/bulk-delete", {});
  const applyBoth = () => {
    const cell = splitDriverNames(driverCell).join(DRIVER_SEP);
    if (!cell || (!start && !end) || (start && end && start === end)) return toast.error("Chọn tài xế và giờ cần đổi; giờ trống sẽ giữ nguyên");
    return run("Đã đổi tài xế và ca", "/api/config/bulk-update", {driver_name:cell,shift_start:start,shift_end:end});
  };
  const schedules = targets.filter((r,i)=>targets.findIndex(t=>sameSchedule(t,r))===i).map(r=>({
    pickup:r.pickup,customer_id:r.customer_id,dropoff:r.dropoff,rules:rulesOf(allRows.filter(t=>sameSchedule(t,r) && !t.unmapped)),
  }));

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-indigo-300 bg-indigo-50/70 px-2 py-1.5">
      <span className="text-[11px] font-semibold text-indigo-900" aria-live="polite">
        {busy ? `Đang ghi ${targets.length} dòng…` : `${targets.length} dòng đã chọn`}
      </span>

      {!busy && mode === null && (
        <>
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setMode("both")}>Tài xế + ca</Button>
          {targets.every(r=>r.rule_id) && <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => {setScheduleTargets(schedules);setMode("schedule");}}>Copy / thay lịch</Button>}
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

      {(mode === "driver" || mode === "both") && (
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
          {mode === "both" ? <><TimeSelect label="Từ giờ" emptyLabel="Giữ giờ bắt đầu" value={start} onChange={setStart} /><TimeSelect label="Đến giờ" emptyLabel="Giữ giờ kết thúc" value={end} onChange={setEnd} /></> : <span className="text-[11px] text-indigo-900">giữ nguyên ca của từng dòng</span>}
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setMode(null)} disabled={busy}>
              Hủy
            </Button>
            <Button
              size="sm"
              className="h-6 px-2 text-[11px] bg-indigo-600 hover:bg-indigo-700"
              onClick={mode === "both" ? applyBoth : applyDriver}
              disabled={busy}
            >
              Áp dụng {targets.length} dòng
            </Button>
          </div>
        </>
      )}

      {mode === "hours" && (
        <>
          <TimeSelect label="Từ giờ" emptyLabel="Giữ giờ bắt đầu" value={start} onChange={setStart} />
          <span className="text-[11px] text-slate-500">→</span>
          <TimeSelect label="Đến giờ" emptyLabel="Giữ giờ kết thúc" value={end} onChange={setEnd} />
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

      {mode === "schedule" && <div className="w-full">
        <p className="text-xs leading-5 text-indigo-900">Thay toàn bộ lịch của {scheduleTargets.length} điểm / tuyến đã chọn ({scheduleTargets.reduce((n,s)=>n+s.rules.length,0)} dòng hiện có, gồm cả ca chưa tick). Điểm giao và thông báo của từng tuyến được giữ nguyên. Copy lịch, sửa tài xế / giờ hoặc thêm ca bên dưới; chỉ ghi khi bấm Lưu.</p>
        <details className="py-1 text-xs text-indigo-900"><summary className="cursor-pointer">Xem điểm / tuyến sẽ thay lịch</summary><ul className="max-h-32 overflow-auto py-1">{scheduleTargets.map(s=><li key={`${s.pickup}|${s.dropoff}`}>{s.pickup} → {s.dropoff || "mọi điểm"} · {s.rules.length} ca</li>)}</ul></details>
        <BranchEditor configDay={configDay} pickupName={`${scheduleTargets.length} điểm / tuyến`} dropoffName="" rules={[]}
          extraLines={[{driver:"",start:"",end:"",dropoff:"",assignment_mode:"fixed"}]} drivers={drivers} locations={locations}
          bulkSchedules={scheduleTargets} onDone={onDone} onCancel={()=>setMode(null)} onStale={onDone} />
      </div>}
      {mode === "delete" && (
        <>
          {/* The count is IN the confirm, not only above it: this is the one
              action here that cannot be undone from the dashboard, and "Xoá"
              beside a stale selection reads the same whether it means two rows
              or a hundred and fifty. */}
          <span className="text-[11px] font-semibold text-red-800">
            Xác nhận xoá {targets.length} dòng cấu hình đã chọn?
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
  configDay,
  rows,
  drivers,
  fromOptions,
  onDone,
  onClose,
}: {
  configDay: ConfigDay;
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
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const fromDrivers = useMemo<ConfigDriver[]>(
    () => fromOptions.flatMap((name) => {
      const ids = new Set(rows.flatMap(r => splitDriverNames(r.driver)
        .flatMap((n, index) => n === name && r.driver_ids?.[index] ? [r.driver_ids[index]] : [])));
      return ids.size ? [...ids].map(driver_id => ({driver_id,name})) : [{driver_id:name,name}];
    }),
    [fromOptions, rows],
  );
  const affected = useMemo(
    () => (from ? sortConfigRows(rows.filter((r) => fromId ? r.driver_ids?.includes(fromId) : splitDriverNames(r.driver).includes(from))) : []),
    [rows, from, fromId],
  );
  const writable = affected.filter(r => !r.unmapped && r.pickup.trim().length > 0);
  const inactiveCount = writable.filter(r => isInactive(r.pickup)).length;
  const unwritable = affected.length - writable.length;
  const picked = writable.filter((r) => !excluded.has(r.row));

  const pickFrom = (names: string[], selected?: ConfigDriver) => {
    setFrom(names[0] ?? "");
    setFromId(selected && rows.some(r => r.driver_ids?.includes(selected.driver_id)) ? selected.driver_id : "");
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
    if (configDay === "weekday" && (!fromId || !toId)) return toast.error("Tải lại config và chọn lại hai tài xế");
    if (picked.length === 0) return toast.error("Chưa chọn dòng nào");
    setBusy(true);
    try {
      const j = await postJson("/api/config/replace-driver", {
        from, to, config_day: configDay, rows: targetBody(picked),
        ...(configDay === "weekday" ? {from_driver_id:fromId,to_driver_id:toId} : {}),
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
          onChange={(names, selected) => { setTo(names[0] ?? ""); setToId(selected?.driver_id ?? ""); }}
          drivers={drivers.filter((d) => fromId ? d.driver_id !== fromId : d.name !== from)}
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
            {inactiveCount > 0 && (
              <span className="ml-1 text-slate-600">
                · gồm {inactiveCount} dòng tại điểm ngừng hoạt động; trạng thái vẫn giữ nguyên
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
                        <span className="font-medium text-slate-900">{locationName(r.pickup,true)}</span>
                        {isInactive(r.pickup) && <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-600">ngừng hoạt động</span>}
                        <span className="tabular-nums text-slate-600">{r.start && r.end ? `${r.start}–${r.end}` : "cả ngày"}</span>
                        {r.dropoff && <span className="text-slate-600">→ {r.dropoff}</span>}
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
                    {!r.rule_id && <span className="font-mono text-[10px] text-slate-500">{r.row}</span>}
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

/** One operator and the value control it requires. */
function ConfigColumnFilter<Operator extends ConfigTimeOperator>({
  label, operator, text, values, options, onOperatorChange, onTextChange, onValuesChange, textPlaceholder, selectPlaceholder, showOperator = true, timeOperators = false,
}: {
  label: string;
  operator: Operator;
  text: string;
  values: string[];
  options: readonly { value: string; label: string }[];
  onOperatorChange: (operator: Operator) => void;
  onTextChange: (value: string) => void;
  onValuesChange: (values: string[]) => void;
  textPlaceholder: string;
  selectPlaceholder: string;
  showOperator?: boolean;
  timeOperators?: boolean;
}) {
  const id = useId();
  const operatorLabel = {
    contains: "có chứa",
    not_contains: "không chứa",
    is: "là",
    is_not: "không phải",
    gt: "sau",
    lt: "trước",
  }[operator];
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={showOperator ? id : undefined} className="block text-xs font-medium text-slate-700">
        {label}{!showOperator && operator !== "is" && <span className="font-normal text-slate-500"> · {operatorLabel}</span>}
      </label>
      {showOperator && <select
        id={id}
        value={operator}
        onChange={(e) => onOperatorChange(e.target.value as Operator)}
        className="h-8 w-full rounded border border-slate-300 bg-white px-2 text-xs text-slate-900 outline-none focus:ring-2 focus:ring-indigo-400/50"
      >
        {!timeOperators && <><option value="contains">Có chứa</option><option value="not_contains">Không chứa</option></>}
        <option value="is">{timeOperators ? "Bằng (=)" : "Là"}</option>
        <option value="is_not">{timeOperators ? "Khác (≠)" : "Không phải"}</option>
        {timeOperators && <><option value="gt">Sau (&gt;)</option><option value="lt">Trước (&lt;)</option></>}
      </select>}
      {usesTextInput(operator) ? (
        <input
          type={operator === "gt" || operator === "lt" ? "time" : "text"}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder={textPlaceholder}
          aria-label={`${label}: giá trị lọc`}
          className="h-8 w-full rounded border border-slate-300 bg-white px-2 text-xs text-slate-900 outline-none placeholder:text-slate-500 focus:ring-2 focus:ring-indigo-400/50"
        />
      ) : (
        <FilterMultiSelect
          label={`${label}: ${operator === "is" ? "chọn giá trị" : "loại trừ giá trị"}`}
          values={values}
          options={options}
          onChange={onValuesChange}
          placeholder={selectPlaceholder}
        />
      )}
    </div>
  );
}

function activeColumnFilterCount(operator: ConfigTimeOperator, text: string, values: readonly string[]): number {
  return usesTextInput(operator) ? Number(Boolean(text.trim())) : Number(values.length > 0);
}

export function ConfigBrowserPanel({ drivers, refreshKey = 0 }: { drivers: ConfigDriver[]; refreshKey?: number }) {
  const [configDay, setConfigDay] = useState<ConfigDay>(() => resolveConfigDay());
  const readOnly = configDay === "sunday";
  const dayRef = useRef(configDay);
  dayRef.current = configDay;
  const loadSequence = useRef(0);
  const [sheetRows, setSheetRows] = useState<ConfigRowView[]>([]);
  const [filters, setFilters] = useState(EMPTY_CONFIG_FILTERS);
  const [advancedFilters, setAdvancedFilters] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ tab: string; fetchedAt: string } | null>(null);
  const [clientMetadata, setClientMetadata] = useState<ClientMeta[] | null>(sessionMetadata?.refreshKey === refreshKey ? sessionMetadata.clients : null);
  const [driverMetadata, setDriverMetadata] = useState<DriverMeta[] | null>(sessionMetadata?.refreshKey === refreshKey ? sessionMetadata.drivers : null);
  const [metaBusy, setMetaBusy] = useState(false);
  const [metaError, setMetaError] = useState("");
  const [refreshedDrivers, setAvailableDrivers] = useState<ConfigDriver[] | null>(null);
  const [refreshingDrivers, setRefreshingDrivers] = useState(false);
  useEffect(() => { setAvailableDrivers(null); }, [refreshKey]);
  const [profileHover, setProfileHover] = useState<{ kind: "client" | "driver"; id: string; anchor: HTMLElement; pinned: boolean } | null>(null);
  const [profileEditing, setProfileEditing] = useState(false);
  const profileOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const profileCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearProfileTimers = () => {
    if (profileOpenTimer.current) clearTimeout(profileOpenTimer.current);
    if (profileCloseTimer.current) clearTimeout(profileCloseTimer.current);
    profileOpenTimer.current = profileCloseTimer.current = null;
  };
  useEffect(() => () => {
    if (profileOpenTimer.current) clearTimeout(profileOpenTimer.current);
    if (profileCloseTimer.current) clearTimeout(profileCloseTimer.current);
  }, []);
  const openProfile = (kind: "client" | "driver", id: string, anchor: HTMLElement, pinned = false) => {
    clearProfileTimers();
    if (profileHover?.pinned && !pinned) return;
    const open = () => { setProfileEditing(false); setProfileHover({ kind, id, anchor, pinned }); };
    if (pinned) open(); else profileOpenTimer.current = setTimeout(open, 250);
  };
  const leaveProfile = () => {
    clearProfileTimers();
    profileCloseTimer.current = setTimeout(() => setProfileHover(p => p?.pinned ? p : null), 200);
  };
  const closeProfile = () => { clearProfileTimers(); setProfileHover(null); setProfileEditing(false); };
  const pinProfile = () => setProfileHover(p => p ? { ...p, pinned: true } : p);
  const [replacing, setReplacing] = useState(false);
  const loadedRef = useRef<string | null>(null);
  const filterId = useId();

  /** `fresh` is the Tải lại button: it bypasses the route's own cache as well as
   *  the browser's. Without it the button re-fetched a route that answered from
   *  memory for five minutes, so pressing it did nothing at all — only the
   *  "đọc HH:MM" stamp, which never moved, gave it away. An ordinary load stays
   *  cheap: the route compares the shared config stamp and re-reads the sheet
   *  only when a write has actually moved it. */
  const load = useCallback(async (fresh = false) => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/config/rows?day=${configDay}${fresh ? "&fresh=1" : ""}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (sequence !== loadSequence.current || configDay !== dayRef.current) return;
      if (!res.ok && !Array.isArray(data.rows)) throw new Error(data.error || `Lỗi ${res.status}`);
      setSheetRows(Array.isArray(data.rows) ? data.rows : []);
      setSelected(new Set());
      setMeta({ tab: data.tab ?? "", fetchedAt: data.fetchedAt ?? "" });
      if (data.error) setErr(String(data.error));
    } catch (e) {
      if (sequence === loadSequence.current && configDay === dayRef.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (sequence === loadSequence.current && configDay === dayRef.current) setLoading(false);
    }
  }, [configDay]);

  const loadMetadata = useCallback(async () => {
    setMetaBusy(true); setMetaError("");
    try {
      const res = await fetch("/api/config/rows?metadata=1", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.clients) || !Array.isArray(data.drivers)) throw new Error(data.error || "Không tải được thông tin khách hàng và tài xế");
      sessionMetadata = { clients: data.clients, drivers: data.drivers, refreshKey };
      setClientMetadata(data.clients); setDriverMetadata(data.drivers);
    } catch (e) { setMetaError(e instanceof Error ? e.message : String(e)); }
    finally { setMetaBusy(false); }
  }, [refreshKey]);

  const refreshDrivers = async () => {
    setRefreshingDrivers(true);
    try {
      const res = await fetch("/api/drivers", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.data) || data.data.length < 100) throw new Error(data.error || "Không đọc được danh sách tài xế Cartrack");
      setAvailableDrivers(data.data.filter((d: { is_active: boolean }) => d.is_active)
        .map((d: { delivery_driver_id: string; first_name: string; last_name: string }) => ({
          driver_id: d.delivery_driver_id, name: `${d.first_name} ${d.last_name}`.trim(),
        })));
      toast.success("Đã tải danh sách tài xế Cartrack");
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setRefreshingDrivers(false); }
  };

  const clientMetaById = useMemo(() => new Map((clientMetadata ?? []).map((c) => [c.customer_id, c])), [clientMetadata]);
  const driverMetaById = useMemo(() => new Map((driverMetadata ?? []).map((d) => [d.driver_id, d])), [driverMetadata]);
  const rosterDrivers = useMemo(() => refreshedDrivers ?? (driverMetadata ? driverMetadata.filter(d => d.cartrack.is_active !== false).map(d => ({
    driver_id: d.driver_id, name: `${d.cartrack.first_name ?? ""} ${d.cartrack.last_name ?? ""}`.trim() || d.driver_id,
  })).sort((a, b) => a.name.localeCompare(b.name)) : drivers), [refreshedDrivers, driverMetadata, drivers]);
  const hoverClient = profileHover?.kind === "client" ? clientMetaById.get(profileHover.id) : null;
  const hoverDriver = profileHover?.kind === "driver" ? driverMetaById.get(profileHover.id) : null;
  const hoverName = hoverClient ? clientName(hoverClient) : hoverDriver ? displayDriverCell(`${hoverDriver.cartrack.first_name ?? ""} ${hoverDriver.cartrack.last_name ?? ""}`.trim()) : "";
  const showSheetRow = sheetRows.length > 0 && !sheetRows.some(r => r.rule_id);
  const clientMetaByName = useMemo(() => {
    const byName = new Map<string, ClientMeta | null>();
    for (const client of clientMetadata ?? []) {
      const name = clientName(client).trim().toLocaleLowerCase("vi");
      if (!name) continue;
      byName.set(name, byName.has(name) ? null : client);
    }
    return byName;
  }, [clientMetadata]);
  const rows = useMemo<ConfigRowView[]>(() => {
    if (loading) return [];
    const mappedIds = new Set(sheetRows.map((row) => row.customer_id).filter(Boolean));
    const mappedNames = new Set(sheetRows.filter((row) => !row.customer_id).map((row) => row.pickup.trim().toLocaleLowerCase("vi")));
    const nameCounts = new Map<string, number>();
    for (const client of clientMetadata ?? []) {
      const name = clientName(client).trim().toLocaleLowerCase("vi");
      if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    return [
      ...sheetRows,
      ...(clientMetadata ?? []).flatMap((client, index) => {
        const name = clientName(client).trim();
        const folded = name.toLocaleLowerCase("vi");
        if (mappedIds.has(client.customer_id) || (nameCounts.get(folded) === 1 && mappedNames.has(folded))) return [];
        return [{ row: -index - 1, customer_id: client.customer_id, pickup: name,
          driver: "", start: "", end: "", dropoff: "", smart: false, unmapped: true }];
      }),
    ].map((row) => {
      const client = clientMetaById.get(row.customer_id) ?? clientMetaByName.get(row.pickup.trim().toLocaleLowerCase("vi"));
      return { ...row, default_dropoff: client ? client.default_dropoff_name?.trim() || (client.default_dropoff_id ? String(clientMetaById.get(client.default_dropoff_id)?.cartrack.customer_name ?? client.default_dropoff_id) : "") : undefined };
    });
  }, [sheetRows, clientMetadata, clientMetaById, clientMetaByName, loading]);

  // On opening or an explicit header sync; never on the status poll.
  useEffect(() => {
    const key = `${configDay}:${refreshKey}`;
    if (loadedRef.current === key) return;
    void load(loadedRef.current !== null && loadedRef.current.split(":")[1] !== String(refreshKey));
    loadedRef.current = key;
    if (sessionMetadata?.refreshKey !== refreshKey) void loadMetadata();
  }, [configDay, load, loadMetadata, refreshKey]);

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
  const defaultDropoffOptions = useMemo(
    () => optionValues.defaultDropoffs.map((value) => ({ value, label: value || "Chưa có điểm giao mặc định" })),
    [optionValues.defaultDropoffs],
  );
  const startOptions = useMemo(
    () => optionValues.starts.map((value) => ({ value, label: value || "trống / cả ngày" })),
    [optionValues.starts],
  );
  const endOptions = useMemo(
    () => optionValues.ends.map((value) => ({ value, label: value || "trống / cả ngày" })),
    [optionValues.ends],
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
   *  Keep the initiating row so its pencil reflects the open route editor. */
  const [editing, setEditing] = useState<{ branch: string; pickup: string; dropoff: string; row: number } | null>(null);
  const [editingBusy, setEditingBusy] = useState(false);
  const editorRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (editing) {
      editorRef.current?.scrollIntoView({ block: "start" });
      editorRef.current?.focus({ preventScroll: true });
    }
  }, [editing]);
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
  const selectable = useMemo(() => readOnly || loading || err ? [] : shown.filter(isWritable), [shown, readOnly, loading, err]);

  /** For each drawn row, the index of the first row of its route run. A
   *  route's rows are adjacent (sortConfigRows), so the run is the route as
   *  far as the current filters show it. */
  const runStart = useMemo(() => {
    const starts: number[] = [];
    shown.forEach((r, i) => {
      const prev = shown[i - 1];
      const start = i > 0 && sameSchedule(prev, r) ? starts[i - 1] : i;
      starts.push(start);
    });
    return starts;
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
  const activeFilters = Number(Boolean(filters.query.trim()))
    + activeColumnFilterCount(filters.driverOperator, filters.driverText, filters.drivers)
    + activeColumnFilterCount(filters.pickupOperator, filters.pickupText, filters.pickups)
    + activeColumnFilterCount(filters.dropoffOperator, filters.dropoffText, filters.dropoffs)
    + activeColumnFilterCount(filters.defaultDropoffOperator, filters.defaultDropoffText, filters.defaultDropoffs)
    + activeColumnFilterCount(filters.startOperator, filters.startText, filters.starts)
    + activeColumnFilterCount(filters.endOperator, filters.endText, filters.ends);
  const hasFilters = activeFilters > 0;
  const advancedCount = activeFilters - Number(Boolean(filters.query.trim()));
  const expandedTools = advancedFilters || replacing || selectedRows.length > 0 || !!editing;

  return (
    <Card className={`gap-0 py-2 flex flex-col border-slate-200 ${expandedTools ? "h-auto min-h-full" : "h-full"}`}>
      <CardContent className="px-3 flex flex-1 flex-col min-h-0 gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Ngày cấu hình" className="flex h-9 shrink-0 items-center rounded-md border border-slate-300 bg-slate-50 p-0.5">
            {([['weekday', 'Ngày thường'], ['sunday', 'Chủ nhật']] as const).map(([day, label]) => <button
              key={day} type="button" aria-pressed={configDay === day}
              disabled={!!editing || replacing || selected.size > 0 || profileEditing}
              title={editing || replacing || selected.size > 0 ? "Đóng trình sửa hoặc bỏ chọn dòng trước khi đổi ngày" : undefined}
              onClick={() => { if (day === configDay) return; closeProfile(); setSheetRows([]); setMeta(null); setLoading(true); clearSelection(); setLimit(RENDER_CAP); setConfigDay(day); }}
              className={`h-7 rounded px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50 ${configDay === day ? "bg-indigo-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-200 hover:text-slate-900"}`}>
              {label}
            </button>)}
          </div>
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={filters.query}
              onChange={(e) => updateFilters({ ...filters, query: e.target.value })}
              placeholder="Tìm chính xác điểm, mã, tài xế…"
              aria-label="Tìm trong config"
              className="h-9 w-full rounded border border-slate-300 bg-white py-1 pl-7 pr-2 text-xs text-slate-900 outline-none placeholder:text-slate-500 focus:ring-2 focus:ring-indigo-400/50"
            />
          </div>
          {/* Freshness beside the button that renews it, rather than on a
              status line below the filters where nothing could be done about it. */}
          {(meta?.tab || meta?.fetchedAt) && (
            <span className="text-[11px] text-slate-500">
              {meta?.tab}{meta?.tab && meta?.fetchedAt && " · "}{meta?.fetchedAt && `đọc ${meta.fetchedAt.slice(11, 16)}`}
            </span>
          )}
          {metaBusy && <span className="text-[11px] text-slate-500">Đang tải thông tin…</span>}
          <Button
            size="sm" variant="default"
            className="h-9 bg-indigo-600 px-3 text-xs font-semibold hover:bg-indigo-700"
            aria-expanded={replacing}
            onClick={() => setReplacing((v) => !v)}
            disabled={readOnly || loading || !!err || rows.length === 0}
          >
            <ArrowRightLeft className="size-3.5" aria-hidden="true" /> Thay tài xế
          </Button>
          <Button
            size="sm" variant="outline"
            className="h-9 px-3 text-xs"
            title="Đọc lại config, hồ sơ đã lưu và danh sách tài xế Cartrack"
            onClick={() => { void load(true); void loadMetadata(); void refreshDrivers(); }}
            disabled={loading || metaBusy || refreshingDrivers}
          >
            {loading || metaBusy || refreshingDrivers ? "Đang tải…" : "Tải lại"}
          </Button>
        </div>

        {readOnly && <p className="text-xs leading-5 text-slate-600">Chủ nhật · chỉ xem. Tài xế và ca được lấy từ lịch trực Chủ nhật trên Google Sheet.</p>}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" type="button" className="h-8 px-2 text-xs text-indigo-700"
            aria-expanded={advancedFilters} aria-controls={filterId}
            onClick={() => setAdvancedFilters(open => !open)}>
            <SlidersHorizontal className="size-3.5" aria-hidden="true" /> Tìm kiếm nâng cao
            {advancedCount > 0 && <span className="rounded bg-indigo-100 px-1.5 tabular-nums">{advancedCount}</span>}
            <ChevronDown className={`size-3.5 ${advancedFilters ? "rotate-180" : ""}`} aria-hidden="true" />
          </Button>
        </div>
        {advancedFilters && <div id={filterId} className="grid grid-cols-1 gap-3 rounded-md bg-slate-50 p-3 sm:grid-cols-2 lg:grid-cols-3">
          <ConfigColumnFilter
            label="Tài xế"
            showOperator={advancedFilters}
            operator={filters.driverOperator}
            text={filters.driverText}
            values={[...filters.drivers]}
            options={driverOptions}
            onOperatorChange={(operator) => updateFilters({
              ...filters,
              driverOperator: operator,
              ...(usesTextInput(operator) !== usesTextInput(filters.driverOperator) ? { driverText: "", drivers: [] } : {}),
            })}
            onTextChange={(value) => updateFilters({ ...filters, driverText: value })}
            onValuesChange={(values) => updateFilters({ ...filters, drivers: values })}
            textPlaceholder="Nhập tài xế…"
            selectPlaceholder="Chọn tài xế…"
          />
          <ConfigColumnFilter
            label="Điểm lấy"
            showOperator={advancedFilters}
            operator={filters.pickupOperator}
            text={filters.pickupText}
            values={[...filters.pickups]}
            options={pickupOptions}
            onOperatorChange={(operator) => updateFilters({
              ...filters,
              pickupOperator: operator,
              ...(usesTextInput(operator) !== usesTextInput(filters.pickupOperator) ? { pickupText: "", pickups: [] } : {}),
            })}
            onTextChange={(value) => updateFilters({ ...filters, pickupText: value })}
            onValuesChange={(values) => updateFilters({ ...filters, pickups: values })}
            textPlaceholder="vd. Bàu Cát"
            selectPlaceholder="Chọn điểm lấy…"
          />
          <ConfigColumnFilter
            label="Điểm giao"
            showOperator={advancedFilters}
            operator={filters.dropoffOperator}
            text={filters.dropoffText}
            values={[...filters.dropoffs]}
            options={dropoffOptions}
            onOperatorChange={(operator) => updateFilters({
              ...filters,
              dropoffOperator: operator,
              ...(usesTextInput(operator) !== usesTextInput(filters.dropoffOperator) ? { dropoffText: "", dropoffs: [] } : {}),
            })}
            onTextChange={(value) => updateFilters({ ...filters, dropoffText: value })}
            onValuesChange={(values) => updateFilters({ ...filters, dropoffs: values })}
            textPlaceholder="vd. D001"
            selectPlaceholder="Chọn điểm giao…"
          />
          <ConfigColumnFilter
            label="Điểm giao mặc định"
            showOperator={advancedFilters}
            operator={filters.defaultDropoffOperator}
            text={filters.defaultDropoffText}
            values={[...filters.defaultDropoffs]}
            options={defaultDropoffOptions}
            onOperatorChange={(operator) => updateFilters({ ...filters, defaultDropoffOperator: operator,
              ...(usesTextInput(operator) !== usesTextInput(filters.defaultDropoffOperator) ? { defaultDropoffText: "", defaultDropoffs: [] } : {}) })}
            onTextChange={(value) => updateFilters({ ...filters, defaultDropoffText: value })}
            onValuesChange={(values) => updateFilters({ ...filters, defaultDropoffs: values })}
            textPlaceholder="vd. D001"
            selectPlaceholder="Chọn điểm giao mặc định…"
          />
          <ConfigColumnFilter
            label="Giờ bắt đầu"
            timeOperators
            operator={filters.startOperator}
            text={filters.startText}
            values={[...filters.starts]}
            options={startOptions}
            onOperatorChange={(operator) => updateFilters({
              ...filters,
              startOperator: operator,
              ...(usesTextInput(operator) !== usesTextInput(filters.startOperator) ? { startText: "", starts: [] } : {}),
            })}
            onTextChange={(value) => updateFilters({ ...filters, startText: value })}
            onValuesChange={(values) => updateFilters({ ...filters, starts: values })}
            textPlaceholder="vd. 07:00"
            selectPlaceholder="Chọn giờ bắt đầu…"
          />
          <ConfigColumnFilter
            label="Giờ kết thúc"
            timeOperators
            operator={filters.endOperator}
            text={filters.endText}
            values={[...filters.ends]}
            options={endOptions}
            onOperatorChange={(operator) => updateFilters({
              ...filters,
              endOperator: operator,
              ...(usesTextInput(operator) !== usesTextInput(filters.endOperator) ? { endText: "", ends: [] } : {}),
            })}
            onTextChange={(value) => updateFilters({ ...filters, endText: value })}
            onValuesChange={(values) => updateFilters({ ...filters, ends: values })}
            textPlaceholder="vd. 17:00"
            selectPlaceholder="Chọn giờ kết thúc…"
          />
        </div>}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-slate-600" aria-live="polite">
            {hasFilters
              ? <><span className="font-semibold tabular-nums text-slate-800">{matches.length}</span> / {rows.length} dòng khớp</>
              : <><span className="font-semibold tabular-nums text-slate-800">{rows.length}</span> dòng{clientMetadata && ` · ${rows.filter((r) => r.unmapped).length} chưa có config`}</>}
            {matches.length > shown.length && <span className="text-slate-500"> · đang hiện {shown.length}</span>}
          </p>
          {hasFilters && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-slate-600"
              onClick={() => updateFilters(EMPTY_CONFIG_FILTERS)}
            >
              Xoá bộ lọc
            </Button>
          )}
        </div>

        {err && <div role="alert" className="text-[11px] text-red-600">{err}</div>}
        {metaError && <div role="alert" className="text-[11px] text-red-600">{metaError}</div>}

        {replacing && (
          <ReplaceDriverPanel
            configDay={configDay}
            rows={rows}
            drivers={rosterDrivers}
            fromOptions={optionValues.drivers}
            onDone={() => { setReplacing(false); clearSelection(); void load(true); }}
            onClose={() => setReplacing(false)}
          />
        )}

        {selectedRows.length > 0 && (
          <BulkBar
            configDay={configDay}
            targets={selectedRows}
            allRows={rows}
            drivers={rosterDrivers}
            locations={(clientMetadata ?? []).filter(c=>!isInactive(clientName(c))).map(c=>({id:c.customer_id,name:clientName(c)}))}
            onDone={() => { clearSelection(); void load(true); }}
            onClear={clearSelection}
          />
        )}

        {editing && editingRows.length > 0 && <section ref={editorRef} tabIndex={-1} aria-label="Sửa cấu hình tuyến" className="max-h-[60vh] shrink-0 scroll-mt-3 overflow-y-auto rounded-md bg-indigo-50 px-3 pb-3 focus:outline-none">
          <div className="sticky top-0 z-10 flex items-start justify-between gap-3 bg-indigo-50 py-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-indigo-950">{editingRows[0].unmapped ? "Thiết lập config" : "Sửa lịch tuyến"}</h3>
              <p className="break-words text-xs leading-relaxed text-indigo-900">{editing.pickup}{editing.dropoff && ` → ${editing.dropoff}`} · {editingRows.filter(r => !r.unmapped).length} ca</p>
            </div>
            <Button size="icon" variant="ghost" className="size-8 shrink-0 text-indigo-700" aria-label="Đóng trình sửa lịch" disabled={editingBusy} onClick={() => setEditing(null)}><X className="size-4" aria-hidden="true" /></Button>
          </div>
          <BranchEditor
            configDay={configDay}
            key={`${editing.branch}|${editing.dropoff}`}
            pickupName={editing.pickup} pickupId={editingRows[0].customer_id} dropoffName={editing.dropoff}
            rules={rulesOf(editingRows)}
            extraLines={editingRows[0].unmapped ? [{
              driver: "", start: "", end: "", dropoff: "",
              assignment_mode: rows.some(row => row.assignment_mode) ? "fixed" : undefined,
              copyFromRuleId: (rows.find(row => !row.unmapped && row.smart && row.row > 2) ?? rows.find(row => !row.unmapped && row.row > 2))?.rule_id,
              copyFromRow: rows.find(row => !row.unmapped && row.smart && row.row > 2)?.row ?? rows.find(row => !row.unmapped && row.row > 2)?.row,
            }] : []}
            drivers={rosterDrivers} locations={(clientMetadata ?? []).filter(c=>!isInactive(clientName(c))).map(c => ({id:c.customer_id,name:clientName(c)}))}
            onBusyChange={setEditingBusy}
            onCancel={() => setEditing(null)}
            onDone={() => { setEditing(null); void load(); }}
            onStale={() => { setEditing(null); void load(true); }}
          />
        </section>}

        <div className={`overflow-auto rounded-md border border-slate-200 ${expandedTools ? "h-96 shrink-0" : "min-h-0 flex-1"}`}>
          {shown.length === 0 ? (
            <p className="px-2 py-3 text-xs text-slate-500">
              {loading ? "Đang tải config…" : rows.length === 0 ? "Chưa đọc được config." : "Không tìm thấy dòng nào."}
            </p>
          ) : (
            <table className="w-full min-w-[880px] table-fixed text-[13px]">
              <colgroup>
                <col className="w-[3%]" />
                <col className="w-[4%]" />
                <col className="w-[35%]" />
                <col className="w-[14%]" />
                <col className="w-[25%]" />
                <col className={showSheetRow ? "w-[15%]" : "w-[19%]"} />
                {showSheetRow && <col className="w-[4%]" />}
              </colgroup>
              <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] text-slate-600">
                <tr>
                  <th className="px-1 py-1 text-left font-medium">
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
                      className="size-4 accent-indigo-600"
                    />
                  </th>
                  <th className="px-1 py-1 text-left font-medium"><span className="sr-only">Sửa lịch</span></th>
                  <th className="px-2 py-1 text-left font-medium">Tuyến</th>
                  <th className="px-2 py-1 text-left font-medium">Thời gian</th>
                  <th className="px-2 py-1 text-left font-medium">Tài xế</th>
                  <th className="px-2 py-1 text-left font-medium whitespace-nowrap">Điểm giao thay thế</th>
                  {showSheetRow && <th className="px-2 py-1 text-right font-medium" title="Số dòng Google Sheet Chủ nhật">Dòng</th>}
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
                  const inactive = isInactive(r.pickup);
                  const pickupLabel = locationName(r.pickup, true);
                  const pickupTail = pickupLabel.lastIndexOf(" ") + 1;
                  const locationInfo = clientMetaById.get(r.customer_id) ?? clientMetaByName.get(r.pickup.trim().toLocaleLowerCase("vi"));
                  const dropoffInfo = clientMetaByName.get(r.dropoff.trim().toLocaleLowerCase("vi"));
                  const alternativeInfo = clientMetaById.get(r.alt_drop_off_id ?? "");
                  // Every row of the route being edited is marked: the editor
                  // holds the route's WHOLE day, so these rows are the very
                  // things it is about to rewrite.
                  const inBranch = !!editing && editing.branch === branch && editing.pickup === r.pickup && editing.dropoff === r.dropoff;
                  // Keyed to the run's first row, which carries the one button.
                  const runOpen = !!editing && editing.row === first.row;
                  return [(
                  <tr
                    key={r.unmapped ? r.customer_id : r.row}
                    className={`align-top ${firstOfBranch ? "border-t border-slate-200" : ""} ${
                      r.unmapped ? "bg-amber-50/70 hover:bg-amber-100/70" : selected.has(r.row) ? "bg-indigo-50" : inBranch ? "bg-indigo-50/60" : "hover:bg-slate-50"
                    }`}
                  >
                    <td className="px-1 py-1">
                      <input
                        type="checkbox"
                        checked={selected.has(r.row)}
                        onChange={() => toggleRow(r.row)}
                        disabled={readOnly || loading || !!err || !isWritable(r)}
                        aria-label={`Chọn dòng ${r.row}${r.pickup ? ` — ${r.pickup}` : ""}`}
                        title={isWritable(r) ? undefined : "Dòng không có điểm lấy — sửa từng dòng bằng nút Sửa"}
                        className="size-4 accent-indigo-600"
                      />
                    </td>
                    <td className="px-1 py-1">
                      {/* ONE button per branch, on the row that names it. Every
                          row's Sửa opened the same editor — the branch's whole
                          day — so a column of identical buttons promised a
                          per-row edit that did not exist. Ghost, not outlined,
                          but always visible: a hover-only button would be
                          invisible on the tablets dispatch also uses. */}
                      {firstOfBranch && (
                        <Button
                          size="icon" variant="ghost"
                          className="size-8 text-blue-700 hover:bg-blue-50 hover:text-blue-800"
                          aria-expanded={runOpen}
                          aria-label={runOpen ? "Đóng" : r.unmapped ? `Thiết lập config cho ${r.pickup}` : `Sửa lịch ${r.pickup || branch} → ${r.dropoff || "mọi điểm"}`}
                          onClick={() => { closeProfile(); setEditing(runOpen ? null : { branch, pickup: r.pickup, dropoff: r.dropoff, row: r.row }); }}
                          disabled={readOnly || loading || !!err || editingBusy || inactive || (!r.customer_id && !r.pickup)}
                        >
                          {runOpen ? <X className="size-4" aria-hidden="true" /> : <Pencil className="size-4" aria-hidden="true" />}
                        </Button>
                      )}
                    </td>
                    <td className="break-words whitespace-normal px-2 py-1 leading-relaxed">
                      {firstOfBranch ? (
                        <>
                          {r.unmapped && <span className="mr-1.5 rounded border border-amber-300 bg-amber-100 px-1 text-[10px] font-semibold text-amber-900">Chưa có config</span>}
                          <button type="button" disabled={!locationInfo} aria-haspopup="dialog" aria-expanded={profileHover?.kind === "client" && profileHover.id === locationInfo?.customer_id}
                            onPointerEnter={e => { if (locationInfo && e.pointerType === "mouse") openProfile("client", locationInfo.customer_id, e.currentTarget); }}
                            onPointerLeave={e => { if (e.pointerType === "mouse") leaveProfile(); }}
                            onClick={e => { if (locationInfo) openProfile("client", locationInfo.customer_id, e.currentTarget, true); }}
                            className={`text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${inactive ? "text-slate-500" : "font-medium text-slate-900"}`}>
                            {inactive ? <>{pickupLabel.slice(0, pickupTail)}<span className="whitespace-nowrap">{pickupLabel.slice(pickupTail)}{" "}<span title="Ngừng hoạt động" className="inline-flex rounded border border-slate-200 bg-slate-100 px-1.5 text-[10px] font-medium leading-4 text-slate-600 align-middle">Inactive</span></span></> : r.pickup ? pickupLabel : <span className="text-slate-500">—</span>}
                          </button>
                          {r.dropoff && <>
                            <span className="mx-1 text-slate-500" aria-hidden="true">→</span>
                            {dropoffInfo ? <button type="button" aria-haspopup="dialog" aria-expanded={profileHover?.kind === "client" && profileHover.id === dropoffInfo.customer_id}
                              onPointerEnter={e => { if (e.pointerType === "mouse") openProfile("client", dropoffInfo.customer_id, e.currentTarget); }}
                              onPointerLeave={e => { if (e.pointerType === "mouse") leaveProfile(); }}
                              onClick={e => openProfile("client", dropoffInfo.customer_id, e.currentTarget, true)}
                              className="text-left text-slate-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">{r.dropoff}</button> : r.dropoff}
                          </>}
                        </>
                      ) : (
                        // Still named for a screen reader, which reads a row
                        // on its own and has no run above it to lean on.
                        <span className="sr-only">{r.pickup}{r.dropoff && ` → ${r.dropoff}`}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums whitespace-nowrap text-slate-700">
                      {(r.start || r.end) ? [r.start, r.end].filter(Boolean).join(" – ") : !r.unmapped && "Cả ngày"}
                    </td>
                    <td className="px-2 py-1 text-slate-700 break-words">
                      {r.driver ? splitDriverNames(r.driver).map((name, index) => {
                        const id = r.driver_ids?.[index] ?? "";
                        const detail = driverMetaById.get(id);
                        return <span key={`${id}-${index}`}>
                          {index > 0 && ", "}
                          {detail ? <button type="button" aria-haspopup="dialog"
                            aria-label={`Xem thông tin tài xế ${displayDriverCell(name)}`}
                            aria-expanded={profileHover?.kind === "driver" && profileHover.id === id}
                            onPointerEnter={e => { if (e.pointerType === "mouse") openProfile("driver", id, e.currentTarget); }}
                            onPointerLeave={e => { if (e.pointerType === "mouse") leaveProfile(); }}
                            onClick={e => openProfile("driver", id, e.currentTarget, true)}
                            className="text-left hover:text-indigo-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                            {displayDriverCell(name)}
                          </button> : displayDriverCell(name)}
                        </span>;
                      }) : <span className="text-amber-700">{r.unmapped ? "cần thiết lập" : "chưa có tài xế"}</span>}
                    </td>
                    <td className="break-words px-2 py-1 text-slate-700">
                      {alternativeInfo ? <button type="button" aria-haspopup="dialog" aria-expanded={profileHover?.kind === "client" && profileHover.id === alternativeInfo.customer_id}
                        onPointerEnter={e => { if (e.pointerType === "mouse") openProfile("client", alternativeInfo.customer_id, e.currentTarget); }}
                        onPointerLeave={e => { if (e.pointerType === "mouse") leaveProfile(); }}
                        onClick={e => openProfile("client", alternativeInfo.customer_id, e.currentTarget, true)}
                        className="text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">{clientName(alternativeInfo)}</button>
                        : r.alt_drop_off_id || null}
                    </td>
                    {showSheetRow && <td className="px-2 py-1 text-right font-mono text-[10px] text-slate-500">{r.unmapped ? "—" : r.row}</td>}
                  </tr>
                  ),
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
      <HoverPanel anchor={profileHover?.anchor ?? null} open={!!(hoverClient || hoverDriver)} label={hoverName}
        onClose={closeProfile} onEngage={pinProfile} onPointerEnter={clearProfileTimers} onPointerLeave={leaveProfile}>
        <div className="space-y-4 p-3">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-700">
              {hoverClient ? <Building2 aria-hidden="true" className="size-5" /> : <UserRound aria-hidden="true" className="size-5" />}
            </span>
            <h3 className="min-w-0 flex-1 self-center break-words text-sm font-semibold leading-5 text-slate-900">{hoverName}</h3>
            <button type="button" aria-label="Đóng" title="Đóng" onClick={closeProfile} className="flex size-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"><X aria-hidden="true" className="size-4" /></button>
          </div>
          {profileEditing && profileHover && (hoverClient || hoverDriver) ? <MasterProfileEditor
            key={`${profileHover.kind}-${profileHover.id}`} kind={profileHover.kind} id={profileHover.id}
            initial={hoverClient ? { ...hoverClient.cartrack, default_dropoff_id: hoverClient.default_dropoff_id, default_dropoff_name: hoverClient.default_dropoff_name, eta_minutes: hoverClient.eta_minutes }
              : { ...hoverDriver!.cartrack, ...hoverDriver!.roster, driver_zalo_id: hoverDriver!.driver_zalo_id, phone_number_update: hoverDriver!.phone_number_update }}
            clients={clientMetadata ?? []} linkedLabcenter={!!hoverClient?.labcenter_location_id}
            onCancel={() => setProfileEditing(false)} onSaved={async () => { setAvailableDrivers(null); await loadMetadata(); await load(true); closeProfile(); toast.success("Đã lưu và đồng bộ hồ sơ"); }}
          /> : <>
            <MasterProfileDetails client={hoverClient} driver={hoverDriver} clients={clientMetaById} />
            <div className="flex justify-end border-t border-slate-200 pt-3"><Button size="sm" variant="outline" onClick={() => { pinProfile(); setProfileEditing(true); }}><Pencil aria-hidden="true" className="size-3.5" />Sửa hồ sơ</Button></div>
          </>}
        </div>
      </HoverPanel>
    </Card>
  );
}
