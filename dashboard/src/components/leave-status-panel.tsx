"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Ban, Check, ChevronLeft, ChevronRight, Palmtree, Plus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "./section-header";
import { toast } from "sonner";
import type { LeaveOnDate, InvalidLeaveRow, SpanningLeaveRow } from "@/lib/leave-config";
import type { LeaveSuppression } from "@/lib/leave-suppression";
import type { ConfigDriver } from "@/lib/types";
import { addDays, vnDate } from "@/lib/time";
import {
  splitDriverName, compareDriverNames, compareByDriverThenWindow, employmentOf,
  type Employment,
} from "@/lib/driver-label";
import { normalizeDriverName } from "@/lib/driver-match";
import { DriverName } from "./driver-name";
import { DriverCombobox } from "./driver-combobox";
import { createDutyLeave } from "@/lib/create-duty-leave";
import type { SubDutyConflict } from "@/lib/sub-duty";

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
  subDutyConflicts?: SubDutyConflict[];
  subDutyWarning?: string | null;
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
    const row = { subDutyConflicts: d.subDutyConflicts, subDutyWarning: d.subDutyWarning, timeLabel: d.timeLabel, subs: d.subs, leave_from: d.leave_from, duplicate: d.duplicate };
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
  after,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  /** Only offer slots strictly LATER than this. An end that cannot be set
   *  before its start is a window that cannot be entered backwards — much
   *  better than a picker that accepts one and an error that explains it after
   *  the fact. Omitted (the substitute editor) offers the whole grid. */
  after?: string;
}) {
  const grid = after ? TIME_SLOTS.filter((t) => t > after) : TIME_SLOTS;
  const options = value && !grid.includes(value) ? [...grid, value].sort() : grid;
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

/**
 * A supervisor filing leave from the dashboard.
 *
 * The row goes through `POST /api/nghi-phep` — the SAME endpoint the driver's
 * own form and the MISA sync use — so the duplicate check, the sheet's formula
 * columns and the leave-suppression rule all behave exactly as they already do.
 * Nothing here writes to the sheet directly.
 *
 * It is a person filing, not a robot, so it sends no `automated` flag: a day
 * someone deliberately deleted CAN be put back this way, which is the documented
 * way past a stale suppression.
 *
 * TWO THINGS THE DRIVER'S OWN FORM DOES NOT DO.
 *
 *   DAYS ARE A SET, NOT A RANGE. A driver asking for Monday and Thursday off is
 *   two separate absences, and a range cannot say that — the driver's form would
 *   take Monday-to-Thursday and book the two days in between as well. Days are
 *   picked one at a time (or a run at a time) into a set, and the set is
 *   REGROUPED into consecutive runs before sending, so a whole week off is still
 *   one request writing seven rows rather than seven requests.
 *
 *   THE PART-TIME TWIN IS FILED TOO, where the day off reaches it. See
 *   `ptCompanionOf`.
 *
 * The builder below is pure and separately tested (`scripts/leave-add.test.mts`),
 * because everything that can go quietly wrong here is a payload shape: days
 * regrouped into the wrong runs, or hours attached to a leave type that has
 * none.
 */
export interface NewLeaveForm {
  /** Full sheet label, exactly as the roster spells it. "" = nothing picked. */
  name: string;
  loai_nghi: "" | "nguyen_buoi" | "nua_buoi" | "nghi_viec";
  /** The days off, `yyyy-mm-dd`, sorted and unique. For "nghỉ việc" this holds
   *  the single LAST WORKING DAY. */
  days: string[];
  /** Window — nua_buoi only, the same window on each chosen day. */
  start: string;
  end: string;
  /** Who covers, optional. A full sheet label like every other driver field;
   *  "" means the days are filed uncovered, exactly as before this existed. */
  sub: string;
}

export const EMPTY_LEAVE_FORM: NewLeaveForm = {
  name: "", loai_nghi: "", days: [], start: "", end: "", sub: "",
};

export interface LeavePayload {
  driver_id: string;
  driver_name: string;
  loai_nghi: string;
  ngay_bat_dau: string;
  ngay_ket_thuc?: string;
  gio_bat_dau?: string;
  gio_ket_thuc?: string;
  note: string;
  /** Set on a row derived from someone's OTHER account. The SERVER decides
   *  whether such a row is written — it needs the config, which the browser
   *  does not have — and rewrites a half day's end to the end of the day once
   *  it has. See `pt-companion.ts` and `/api/nghi-phep`. */
  pt_companion?: true;
}

/** A whole-day submission writes ONE SHEET ROW PER DAY, so a mistyped year is a
 *  few hundred appends into a tab someone then cleans by hand. Long real
 *  absences exist, so this is a sanity bound rather than a policy — a month at a
 *  time. `/api/nghi-phep` enforces the same number; this copy only makes the
 *  refusal instant. */
export const MAX_LEAVE_DAYS = 31;

const DAY_MS = 86_400_000;

/** `yyyy-mm-dd` → epoch day, or NaN. Read as UTC so a browser west of Saigon
 *  does not shift every date by one. */
const dayNum = (d: string): number => Date.parse(`${d}T00:00:00Z`) / DAY_MS;

const dayStr = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** Sorted, de-duplicated, and only real dates — the set the form holds. */
export function normalizeDays(days: string[]): string[] {
  return [...new Set(days.filter((d) => Number.isFinite(dayNum(d))))].sort();
}

/** Every day from `from` to `to` inclusive, so one drag of the two date inputs
 *  adds a whole run at once. Backwards or unparseable ranges add nothing. */
export function expandRange(from: string, to: string): string[] {
  const a = dayNum(from), b = dayNum(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a || b - a >= MAX_LEAVE_DAYS) return [];
  const out: string[] = [];
  for (let n = a; n <= b; n++) out.push(dayStr(n));
  return out;
}

/**
 * A set of days back into the fewest consecutive runs.
 *
 * This is the whole reason days can be a set without costing a request each:
 * `/api/nghi-phep` already writes one row per day across a range, so Mon–Fri is
 * ONE call. Getting this wrong is quiet in both directions — merging across a
 * gap books a day the driver is working, and failing to merge only costs time —
 * so it is a pure function with its own test rather than a loop in a handler.
 */
export function groupConsecutive(days: string[]): { from: string; to: string }[] {
  const sorted = normalizeDays(days);
  const runs: { from: string; to: string }[] = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && dayNum(d) === dayNum(last.to) + 1) last.to = d;
    else runs.push({ from: d, to: d });
  }
  return runs;
}

// ── The part-time twin ──────────────────────────────────────────────────────
//
// About a dozen people hold both a `DC…` full-time and a `PT…` part-time
// account, and switch to the second for a trip running past their own shift. A
// day off filed against only the full-time account leaves the twin reading as
// available all evening — so the MISA sync files the twin too, and a day typed
// here has to do the same or the dashboard is the one door that produces a
// half-recorded absence.
//
// WHO the twin is, is decided here; WHETHER the day reaches them is decided on
// the server, in `pt-companion.ts`, because that answer needs the config. The
// MISA sync goes through the same gate, so the two writers cannot drift apart
// on the rule the way two copies of a clock-based one did.

export type TwinReason = "ok" | "not-full-time" | "none" | "ambiguous";

/**
 * The one active part-time account belonging to the same person, or null.
 *
 * Timid on purpose. Exactly one match or nothing: Vietnamese names repeat, and
 * two candidates means the name genuinely does not say which record is meant —
 * inventing a day off on the wrong account takes a WORKING driver off the road,
 * which is strictly worse than the gap this closes. `reason` says why nothing
 * came back so the form can show it rather than silently doing half the job.
 */
export function findPtTwin(
  driver: ConfigDriver,
  roster: ConfigDriver[],
): { twin: ConfigDriver | null; reason: TwinReason } {
  // Only a confirmed full-timer has a twin to find. An account with no staff
  // code classifies as neither, and guessing from a nameless label is exactly
  // the invention this function exists to avoid.
  if (employmentOf(driver.name) !== "full-time") return { twin: null, reason: "not-full-time" };
  const want = normalizeDriverName(driver.name);
  if (!want) return { twin: null, reason: "none" };
  // The roster passed here is the ACTIVE list (`/api/config` drops deactivated
  // accounts), so a resigned twin is never resurrected by this.
  const hits = roster.filter(
    (r) =>
      r.driver_id &&
      r.driver_id !== driver.driver_id &&
      employmentOf(r.name) === "part-time" &&
      normalizeDriverName(r.name) === want,
  );
  if (hits.length === 1) return { twin: hits[0], reason: "ok" };
  return { twin: null, reason: hits.length ? "ambiguous" : "none" };
}

/**
 * The row to file against the twin for one of this person's rows, or null when
 * the day off does not reach the twin at all.
 *
 *   - A FULL DAY is a full day on both accounts.
 *   - A HALF DAY reaches the twin only when it runs past noon: someone off from
 *     13:00 is not coming back for an evening trip either, so the twin is off
 *     from the moment the person leaves until the end of the day. The window
 *     deliberately does NOT mirror the original — copying a 12:00–18:00 leave
 *     as 12:00–18:00 would leave 18:00–22:00, exactly when the twin account is
 *     used, still reading as available.
 *   - A MORNING half day copies as NOTHING: the person is back for their own
 *     shift, so the evening is unaffected.
 *   - A RESIGNATION copies as nothing either. Ending one contract is a fact
 *     about that account; a person can move from full-time to part-time, and
 *     closing the twin on a guess would silently retire a driver who is still
 *     working. The form says so, so it is filed by hand when it is meant.
 */
export function ptCompanionOf(p: LeavePayload, twin: ConfigDriver): LeavePayload | null {
  // A resignation is a fact about ONE contract. People move from full-time to
  // part-time, so closing the twin on a guess would retire a driver who is
  // still working — the one case decided here rather than on the server,
  // because no config could tell the difference.
  if (p.loai_nghi === "nghi_viec") return null;
  // An unusable window is not a config question. The engine ignores such a
  // leave row, so offering one would ask the server to judge hours that mean
  // nothing — the same refusal `buildPtCompanion` makes in misa-fetcher.
  if (p.loai_nghi === "nua_buoi") {
    const start = p.gio_bat_dau ?? "";
    const end = p.gio_ket_thuc ?? "";
    if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end) || end <= start) return null;
  }
  return {
    ...p,
    driver_id: twin.driver_id,
    driver_name: twin.name,
    // Marks the row in the sheet's note column, so a supervisor reading the tab
    // can tell a derived row from one that was actually asked for.
    note: `${p.note} — theo tài khoản FT`,
    // The window is left EXACTLY as asked for. Whether this row is written at
    // all is a config question the browser cannot answer, and the server tests
    // it against these hours before rewriting a half day to the day's end.
    pt_companion: true,
  };
}

/** One `POST /api/leave-status` — the row to cover, and who covers it. */
export interface SubWrite {
  driver_id: string;
  leave_from: string;
  timeLabel: string | null;
  subs: { name: string; from: null; to: null }[];
}

/**
 * The ROWS one payload is about to create, addressed the way the sheet writer
 * addresses them: driver + start date + window, never a row number.
 *
 * This is the part worth getting right. `/api/nghi-phep` writes ONE ROW PER DAY
 * for a whole-day range, so a Monday-to-Friday payload becomes five rows and
 * therefore five identities — asking to cover "29/09–02/10" as a single row
 * would match nothing and the substitute would silently not be written. A half
 * day is one row carrying its window, and the window is part of its identity:
 * a day can hold two rows split between two substitutes, and the label is what
 * tells them apart.
 *
 * The en dash is the one `coverageOnDate` builds and the writer splits on. A
 * hyphen here would fail to match every windowed row.
 */
function subIdentities(p: LeavePayload): { driver_id: string; leave_from: string; timeLabel: string | null }[] {
  // A resignation is not a day off someone stands in for; the row has no window
  // and no end, and naming a substitute on it would say the wrong thing.
  if (p.loai_nghi === "nghi_viec") return [];
  if (p.loai_nghi === "nua_buoi") {
    return [{
      driver_id: p.driver_id,
      leave_from: p.ngay_bat_dau,
      timeLabel: `${p.gio_bat_dau}–${p.gio_ket_thuc}`,
    }];
  }
  return expandRange(p.ngay_bat_dau, p.ngay_ket_thuc ?? p.ngay_bat_dau).map((d) => ({
    driver_id: p.driver_id,
    leave_from: d,
    timeLabel: null,
  }));
}

/**
 * The form state as the requests that will be sent.
 *
 * Several, not one: a set of days that is not one run is several ranges, and a
 * half-day is one request per day because the route writes exactly one row for
 * a window. They are sent in order and the caller stops at the first failure —
 * so the earlier days are already saved, which the caller must say out loud.
 */
export function buildLeaveSubmission(
  f: NewLeaveForm,
  drivers: ConfigDriver[],
): { error: string } | { payloads: LeavePayload[]; subWrites: SubWrite[] } {
  const built = buildOwnSubmission(f, drivers);
  if ("error" in built) return built;
  const driver = drivers.find((d) => d.name === f.name)!;
  const { twin } = findPtTwin(driver, drivers);

  // Who covers, if anyone. Checked here rather than left to the write: the sub
  // endpoint would reject an unknown name too, but only AFTER the leave rows
  // are on the sheet — so the day would be filed and the cover silently not.
  const subName = f.sub.trim();
  let subWrites: SubWrite[] = [];
  if (subName) {
    const cover = drivers.find((d) => d.name === subName);
    if (!cover) return { error: "Chọn người thay từ danh sách" };
    if (cover.driver_id === driver.driver_id) {
      return { error: "Người thay trùng với tài xế đang nghỉ" };
    }
    // …and not their own other account either, which the endpoint cannot catch:
    // the ids differ, so it reads as a different person while being the same one,
    // off that day, standing in for themselves.
    if (twin && cover.driver_id === twin.driver_id) {
      return { error: "Người thay là tài khoản PT của chính tài xế đang nghỉ" };
    }
    // The person's OWN rows only. A substitute covers one account, and the
    // twin's row is the evening — a different question with a different answer,
    // which the panel has always asked separately.
    subWrites = built.payloads.flatMap(subIdentities).map((id) => ({
      ...id,
      // No window: blank means "the leave row's own hours", so a half day is
      // covered for exactly its window and a whole day for the whole day.
      subs: [{ name: cover.name, from: null, to: null }],
    }));
  }

  // The person's own rows FIRST, then the twin's. A twin write that fails
  // leaves the real absence recorded, which is the half to keep.
  const companions = twin
    ? built.payloads.map((p) => ptCompanionOf(p, twin)).filter((p): p is LeavePayload => p !== null)
    : [];
  return { payloads: [...built.payloads, ...companions], subWrites };
}

/** The rows for the account actually picked, before any twin is considered. */
function buildOwnSubmission(
  f: NewLeaveForm,
  drivers: ConfigDriver[],
): { error: string } | { payloads: LeavePayload[] } {
  // Resolved against the roster, not trusted from the box: the sheet's
  // driver_id column is an xlookup on this exact name, so a label that is not
  // on the roster lands as a row the engine cannot see at all.
  const driver = drivers.find((d) => d.name === f.name);
  if (!f.name || !driver) return { error: "Chọn tài xế từ danh sách" };
  if (!f.loai_nghi) return { error: "Chọn loại nghỉ" };

  const days = normalizeDays(f.days);
  const base = { driver_id: driver.driver_id, driver_name: driver.name, note: "Nhập từ dashboard" };

  if (f.loai_nghi === "nghi_viec") {
    // One date, and it is the LAST WORKING DAY. The route turns it into "skip
    // from the day after", so nothing about that shift is done here.
    if (days.length === 0) return { error: "Chọn ngày làm việc cuối cùng" };
    if (days.length > 1) return { error: "Nghỉ việc chỉ có một ngày làm việc cuối cùng" };
    return { payloads: [{ ...base, loai_nghi: f.loai_nghi, ngay_bat_dau: days[0] }] };
  }

  if (days.length === 0) return { error: "Chọn ít nhất một ngày nghỉ" };
  if (days.length > MAX_LEAVE_DAYS) {
    return { error: `${days.length} ngày quá nhiều — tối đa ${MAX_LEAVE_DAYS} ngày mỗi lần` };
  }

  if (f.loai_nghi === "nua_buoi") {
    if (!f.start || !f.end) return { error: "Chọn giờ bắt đầu và giờ kết thúc" };
    if (f.end <= f.start) return { error: "Giờ kết thúc phải sau giờ bắt đầu" };
    // One row per day, each carrying the window. Never grouped into a range: a
    // multi-day row repeats its hours on every day of the span, which is the
    // shape the panel already flags as a thing to split.
    return {
      payloads: days.map((d) => ({
        ...base, loai_nghi: f.loai_nghi, ngay_bat_dau: d,
        gio_bat_dau: f.start, gio_ket_thuc: f.end,
      })),
    };
  }

  return {
    payloads: groupConsecutive(days).map((r) => ({
      ...base, loai_nghi: f.loai_nghi, ngay_bat_dau: r.from, ngay_ket_thuc: r.to,
    })),
  };
}

/** "nghỉ nguyên buổi 04/09–06/09" — what the toast says actually landed. */
function submissionLabel(p: LeavePayload): string {
  const type = ({
    nguyen_buoi: "nghỉ nguyên buổi", nua_buoi: "nghỉ nửa buổi", nghi_viec: "nghỉ việc",
  } as Record<string, string>)[p.loai_nghi] ?? p.loai_nghi;
  if (p.loai_nghi === "nghi_viec") return `${type} — ngày cuối ${ddmm(p.ngay_bat_dau)}`;
  const range = rangeLabel(p.ngay_bat_dau, p.ngay_ket_thuc ?? null);
  const hrs = p.gio_bat_dau ? ` ${p.gio_bat_dau}–${p.gio_ket_thuc}` : "";
  return `${type} ${range}${hrs}`;
}

/**
 * What pressing Lưu will do to the twin, in one sentence.
 *
 * Shown before the write rather than reported after it: filing a second row on
 * someone's other account is a surprise the first time it happens, and a
 * morning half-day filing NOTHING is just as surprising the other way.
 */
function twinEffect(f: NewLeaveForm): { copies: boolean; text: string } {
  // HEDGED on purpose. Whether the twin gets a row depends on the config, which
  // this form cannot read — so it says what the server will decide rather than
  // promising an outcome it does not know. The toast after the write reports
  // what actually happened.
  if (f.loai_nghi === "nguyen_buoi") {
    return { copies: true, text: "nghỉ cả ngày, nếu tài khoản PT có tuyến trong config" };
  }
  if (f.loai_nghi === "nghi_viec") {
    return {
      copies: false,
      text: "nghỉ việc KHÔNG tự áp cho tài khoản PT — nhập riêng nếu tài khoản đó cũng dừng",
    };
  }
  if (f.loai_nghi === "nua_buoi") {
    if (!f.start || !f.end) {
      return { copies: false, text: "chọn giờ để biết có trùng ca PT không" };
    }
    // A companion is a WHOLE day even when the leave it came from is not: the
    // hours decide whether the twin is filed, not how much of its day is taken.
    return {
      copies: true,
      text: `nghỉ CẢ NGÀY, nếu ${f.start}–${f.end} trùng giờ ca PT trong config`,
    };
  }
  return { copies: false, text: "" };
}

/**
 * The form itself. Collapsed by default — this panel is read far more often
 * than it is written to, and an always-open form pushes the week grid down the
 * page for everyone who came here to look rather than to type.
 */
function AddLeaveForm({ drivers, onSaved }: { drivers: ConfigDriver[]; onSaved: RefreshFn }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<NewLeaveForm>(EMPTY_LEAVE_FORM);
  /** The two inputs that ADD to the set — not the set itself. */
  const [pickFrom, setPickFrom] = useState("");
  const [pickTo, setPickTo] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const set = <K extends keyof NewLeaveForm>(k: K, v: NewLeaveForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const picked = drivers.find((d) => d.name === form.name);
  const twinInfo = picked ? findPtTwin(picked, drivers) : null;
  const twinWill = twinEffect(form);
  const reset = () => {
    setForm(EMPTY_LEAVE_FORM);
    setPickFrom(""); setPickTo(""); setError(""); setBusy("");
  };
  const close = () => { setOpen(false); reset(); };

  const addDays = (list: string[]) => {
    if (list.length === 0) return;
    set("days", normalizeDays([...form.days, ...list]));
    setPickTo("");
  };
  const removeDay = (d: string) => set("days", form.days.filter((x) => x !== d));

  async function save() {
    setError("");
    const built = buildLeaveSubmission(form, drivers);
    if ("error" in built) { setError(built.error); return; }
    const { payloads, subWrites } = built;

    let written = 0;
    let skippedPt = 0;
    let failure = "";
    // Both phases counted in one progress line: from where the button is
    // pressed they are one action, and a bar that reaches the end and then
    // keeps working is worse than no bar.
    const steps = payloads.length + subWrites.length;
    for (const [i, payload] of payloads.entries()) {
      setBusy(steps > 1 ? `Đang lưu ${i + 1}/${steps}…` : "Đang lưu…");
      try {
        const res = await fetch("/api/nghi-phep", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          // The route's own messages name the clashing row / the unreadable
          // sheet, so they are shown as-is rather than flattened into "lỗi".
          failure = `${submissionLabel(payload)}: ${data.error ?? `Lỗi ${res.status}`}`;
          break;
        }
        // A companion the config said was unnecessary. Counted apart from the
        // rows that landed, because "2/2 written" for a submission that wrote
        // one row would be a lie, and silence would leave the supervisor
        // wondering whether the PT side worked.
        if (data.skipped) skippedPt++;
        else written++;
      } catch (e) {
        failure = `${submissionLabel(payload)}: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
    }
    // The cover, once every day it is for actually exists. Skipped entirely if
    // any leave write failed: an identity for a row that was never created
    // matches nothing, and the resulting "không tìm thấy dòng nghỉ" would read
    // as a bug rather than as the earlier failure it is.
    let covered = 0;
    let subWarning = "";
    if (!failure) {
      for (const [i, w] of subWrites.entries()) {
        setBusy(`Đang lưu ${payloads.length + i + 1}/${steps}…`);
        try {
          const res = await fetch("/api/leave-status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(w),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) {
            failure = `người thay ${ddmm(w.leave_from)}: ${data.error ?? `Lỗi ${res.status}`}`;
            break;
          }
          // Same sentence for every day of the same leave, so it is shown once.
          if (data.warning && !subWarning) subWarning = String(data.warning);
          covered++;
        } catch (e) {
          failure = `người thay ${ddmm(w.leave_from)}: ${e instanceof Error ? e.message : String(e)}`;
          break;
        }
      }
    }
    setBusy("");

    // Said out loud, because a partial write is the one outcome a supervisor
    // must not re-run blindly: the days already on the sheet would come back as
    // duplicates-refused and hide which day actually failed.
    if (written > 0) {
      const cover = subWrites.length > 0 ? ` — người thay ${covered}/${subWrites.length} ngày` : "";
      const pt = skippedPt > 0 ? " — tài khoản PT không trùng tuyến nên không ghi" : "";
      toast.success(
        (payloads.length === 1
          ? `Đã ghi ${submissionLabel(payloads[0])}`
          : `Đã ghi ${written} đợt nghỉ`) + cover + pt,
      );
      if (subWarning) toast.warning(subWarning);
      // Awaited, like every other write in this panel: releasing the button
      // while the week is still re-reading is what invites a second click.
      await onSaved();
    }
    if (failure) {
      // The leave landed in full and only the COVER failed. Re-submitting this
      // form would re-file days that are already on the sheet and be refused as
      // duplicates, so the form closes and the panel's own editor is where the
      // substitute gets filled — but the reason has to survive the close, which
      // clears the inline error along with everything else.
      if (written + skippedPt === payloads.length) {
        toast.error(`Đã ghi ngày nghỉ, chưa gán được ${failure}`);
        close();
        return;
      }
      setError(written > 0 ? `Đã ghi ${written} đợt, dừng ở — ${failure}` : failure);
      // Whatever landed is gone from the set, so a retry re-sends only the rest.
      if (written > 0) {
        const done = new Set(
          payloads.slice(0, written).flatMap((p) => expandRange(p.ngay_bat_dau, p.ngay_ket_thuc ?? p.ngay_bat_dau)),
        );
        set("days", form.days.filter((d) => !done.has(d)));
      }
      return;
    }
    close();
  }

  if (!open) {
    return (
      <Button
        size="sm" variant="outline"
        className="mt-2 h-6 px-2 text-[11px]"
        onClick={() => { reset(); setPickFrom(vnDate()); setOpen(true); }}
      >
        <Plus className="size-3" strokeWidth={2} />
        Thêm ngày nghỉ
      </Button>
    );
  }

  const isResign = form.loai_nghi === "nghi_viec";

  return (
    <div
      className="mt-2 rounded-md border border-emerald-300 bg-emerald-50/40 p-1.5"
      role="group"
      aria-label="Thêm ngày nghỉ"
    >
      <div className="mb-1 text-[11px] font-semibold text-slate-800">
        Thêm ngày nghỉ — ghi thẳng vào sheet, engine thấy ở chu kỳ kế tiếp
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <DriverCombobox
          names={form.name ? [form.name] : []}
          onChange={(names) => set("name", names[0] ?? "")}
          drivers={drivers}
          max={1}
          ariaLabel="Chọn tài xế nghỉ"
          className="flex w-[260px] max-w-full flex-wrap items-center gap-1 rounded border border-slate-300 bg-white px-1 py-0.5 focus-within:ring-2 focus-within:ring-indigo-400/50"
        />
        <select
          value={form.loai_nghi}
          onChange={(e) => {
            const v = e.target.value as NewLeaveForm["loai_nghi"];
            // Resignation is a single date; anything already picked beyond the
            // first would be silently dropped at send time otherwise.
            setForm((f) => ({ ...f, loai_nghi: v, days: v === "nghi_viec" ? f.days.slice(0, 1) : f.days }));
          }}
          aria-label="Loại nghỉ"
          className="rounded border border-slate-300 bg-white px-1 py-1 text-xs"
        >
          <option value="">Loại nghỉ…</option>
          <option value="nguyen_buoi">Nghỉ nguyên buổi</option>
          <option value="nua_buoi">Nghỉ nửa buổi</option>
          <option value="nghi_viec">Nghỉ việc</option>
        </select>

        {form.loai_nghi === "nua_buoi" && (
          <>
            {/* The same half-hour grid the substitute editor and the driver's
                own form use. Shift windows are set on the half hour, so the
                free-minute picker offered a precision the roster does not have
                and read as fiddly for the one thing it is used for. */}
            <TimeSelect
              value={form.start}
              label="Giờ bắt đầu nghỉ"
              onChange={(v) =>
                // Moving the start past the end clears the end rather than
                // leaving a backwards window sitting in the form waiting to be
                // refused on save.
                setForm((f) => ({ ...f, start: v, end: v && f.end && f.end <= v ? "" : f.end }))
              }
            />
            <span className="text-[11px] text-slate-600">–</span>
            {/* Bounded by the start, so the end simply cannot be set before it. */}
            <TimeSelect
              value={form.end}
              label="Giờ kết thúc nghỉ"
              after={form.start || undefined}
              onChange={(v) => set("end", v)}
            />
          </>
        )}
      </div>

      {/* The days. Native date inputs — the platform already ships the picker,
          the keyboard handling and the locale. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-slate-700">
          {isResign ? "Ngày làm việc cuối cùng" : "Ngày nghỉ"}
        </span>
        <input
          type="date"
          value={isResign ? (form.days[0] ?? "") : pickFrom}
          onChange={(e) =>
            isResign
              ? set("days", e.target.value ? [e.target.value] : [])
              : setPickFrom(e.target.value)
          }
          aria-label={isResign ? "Ngày làm việc cuối cùng" : "Ngày nghỉ"}
          className="rounded border border-slate-300 bg-white px-1 py-1 text-xs"
        />
        {!isResign && (
          <>
            <span className="text-[11px] text-slate-600">đến (tuỳ chọn)</span>
            <input
              type="date"
              value={pickTo}
              min={pickFrom || undefined}
              onChange={(e) => setPickTo(e.target.value)}
              aria-label="Đến ngày (tuỳ chọn)"
              className="rounded border border-slate-300 bg-white px-1 py-1 text-xs"
            />
            <Button
              size="sm" variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={!pickFrom}
              onClick={() => addDays(pickTo ? expandRange(pickFrom, pickTo) : [pickFrom])}
            >
              Thêm ngày
            </Button>
          </>
        )}
      </div>

      {/* The chosen days. */}
      {!isResign && form.days.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1">
          {form.days.map((d) => {
            return (
              <li
                key={d}
                className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] text-slate-800"
              >
                <span className="font-semibold">{weekdayShort(d)} {ddmm(d)}</span>
                <button
                  type="button"
                  onClick={() => removeDay(d)}
                  aria-label={`Bỏ ngày ${ddmm(d)}`}
                  className="rounded text-slate-500 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Who covers, in the same breath as the day off.
          Optional, and absent for a resignation — that is not a day someone
          stands in for. Filled here it saves the trip back through "Thêm người
          thay" on every row this creates, which for a week off was seven. */}
      {!isResign && form.loai_nghi && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-slate-700">Người thay (tuỳ chọn)</span>
          <DriverCombobox
            names={form.sub ? [form.sub] : []}
            onChange={(names) => set("sub", names[0] ?? "")}
            drivers={drivers}
            max={1}
            ariaLabel="Chọn người thay"
            placeholder="Chưa có người thay…"
            className="flex w-[260px] max-w-full flex-wrap items-center gap-1 rounded border border-slate-300 bg-white px-1 py-0.5 focus-within:ring-2 focus-within:ring-indigo-400/50"
          />
          {form.sub && form.days.length > 1 && (
            <span className="text-[11px] text-slate-600">cho cả {form.days.length} ngày</span>
          )}
        </div>
      )}


      {twinInfo?.reason === "ambiguous" && (
        <p className="mt-1 text-[11px] text-amber-800">
          Có nhiều tài khoản PT trùng tên nên KHÔNG tự ghi cho tài khoản PT — nhập riêng cho đúng
          tài khoản nếu cần.
        </p>
      )}
      {twinInfo?.twin && twinWill.text && (
        <p className={`mt-1 text-[11px] ${twinWill.copies ? "text-slate-700" : "text-slate-600"}`}>
          {twinWill.copies ? "Ghi thêm cho tài khoản PT" : "Tài khoản PT"}{" "}
          <DriverName full={twinInfo.twin.name} className="font-semibold" />: {twinWill.text}
        </p>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Button size="sm" className="h-6 px-2 text-[11px]" disabled={!!busy} onClick={() => void save()}>
          {busy || "Lưu"}
        </Button>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={!!busy} onClick={close}>
          Hủy
        </Button>
        {!isResign && form.days.length > 1 && (
          <span className="text-[11px] text-slate-600">{form.days.length} ngày</span>
        )}
      </div>
      {error && <p role="alert" className="mt-1 text-[11px] font-semibold text-red-700">{error}</p>}
    </div>
  );
}

/**
 * What a write here does after it lands: re-read the panel, and say when that
 * has finished.
 *
 * The promise is the whole point. A sheet write costs ~3s and the re-read
 * another ~6s, and every one of these writers used to fire the refresh without
 * waiting — so the button stopped looking busy while the row it had just acted
 * on stayed on screen for another six seconds. Restoring a suppression looked
 * completely dead: a success toast, a button back to normal, and the line still
 * sitting there. The obvious response is to click again, and the second click
 * fails as "not found", because the first one worked.
 */
type RefreshFn = () => void | Promise<void>;

/** Write substitutes back to the Leave sheet. Shared so the "Cần xử lý" section
 *  and the reference panel below it save through exactly one path. */
function makeFillSubs(onRefresh: RefreshFn): FillSubsFn {
  return async (identity, subs, replace) => {
    try {
      const res = await fetch("/api/leave-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...identity, subs, replace: !!replace }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? `HTTP ${res.status}`);
        return false;
      }
      // The write LANDED either way — a warning here is about what happens
      // next, not about whether it saved, and a bare warning read as a failure.
      if (data.warning) toast.warning(`Đã lưu người thay. ${data.warning}`);
      else toast.success("Đã lưu người thay vào sheet");
      await onRefresh();
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
  /** true = EDIT an already-covered row (overwrite whatever's there); default
   *  (false/omitted) only fills empty slots — the original "+ Thêm" flow. */
  replace?: boolean,
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
function makeDeleteRow(onRefresh: RefreshFn): DeleteRowFn {
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
      await onRefresh();
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
          await onDelete(identity);
          // Unconditional: on success the row is gone (or, for a duplicate
          // pair, the record row is untouched on purpose — see
          // replaceLeaveSubs's doc comment) and this button either unmounts
          // with it or should read as an ordinary "Xoá" again; on failure the
          // toast already said so, and re-arming from scratch is clearer than
          // leaving a stale confirm sitting on screen.
          setBusy(false);
          setArmed(false);
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
  drivers,
  initial,
  onSave,
  onCancel,
}: {
  row: LeaveRowView;
  drivers: ConfigDriver[];
  /** Prefills the blocks with what the row already carries — the EDIT case
   *  (change a name or a window on a row that's already covered). Omitted for
   *  the original "+ Thêm" case, which starts from one empty block. */
  initial?: SubBlock[];
  onSave: (subs: { name: string; from: string | null; to: string | null }[]) => Promise<boolean>;
  onCancel: () => void;
}) {
  // Still checked, even though the picker can only produce a roster name: this
  // is the last thing between a typo and a substitute the sheet's xlookup will
  // never resolve, and it costs one Set.
  const driverNames = new Set(drivers.map((d) => d.name));
  // Leave window bounds (for prefilling a split) — "06:30–15:00" → ["06:30","15:00"]
  const bounds = row.timeLabel ? row.timeLabel.split("–") : null;
  const [blocks, setBlocks] = useState<SubBlock[]>(
    initial && initial.length > 0 ? initial : [{ name: "", from: "", to: "" }],
  );
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
    const chosen = blocks.filter((b) => b.name.trim());
    for (const b of chosen) {
      if (!b.name.trim()) return toast.error("Chọn người thay từ danh sách");
      if (!driverNames.has(b.name.trim()))
        return toast.error(`"${b.name.trim()}" không có trong danh sách tài xế`);
      if (!!b.from !== !!b.to) return toast.error("Khung giờ thay phải đủ cả từ và đến");
      if (b.from && b.to && b.from >= b.to)
        return toast.error(`Khung giờ không hợp lệ: ${b.from}–${b.to}`);
    }
    if (chosen.length > 1) {
      if (chosen.some((b) => !b.from || !b.to))
        return toast.error("Nhiều người thay thì mỗi người cần khung giờ riêng");
      const sorted = [...chosen].sort((a, b) => a.from.localeCompare(b.from));
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].from < sorted[i - 1].to)
          return toast.error(
            `Khung giờ bị chồng: ${sorted[i - 1].from}–${sorted[i - 1].to} và ${sorted[i].from}–${sorted[i].to}`,
          );
      }
    }
    setBusy(true);
    const ok = await onSave(
      chosen.map((b) => ({ name: b.name.trim(), from: b.from || null, to: b.to || null })),
    );
    setBusy(false);
    if (ok) onCancel();
  };

  return (
    <div className="mt-1 space-y-1 rounded border border-slate-300 bg-white p-1.5">
      {blocks.map((b, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1">
          {/* The same control the config editor uses, minus the several-names
              part: a substitute is one person for one window, so the field
              stands down once someone is chosen and the ✕ is how you change
              your mind. */}
          <DriverCombobox
            names={b.name ? [b.name] : []}
            onChange={(names) => patch(i, { name: names[0] ?? "" })}
            drivers={drivers}
            max={1}
            placeholder="Tìm người thay…"
            ariaLabel="Chọn người thay"
            className="flex min-w-[140px] flex-1 flex-wrap items-center gap-1 rounded border border-slate-300 bg-white px-1 py-0.5 focus-within:ring-2 focus-within:ring-indigo-400/50"
          />
          <TimeSelect label="Từ giờ" value={b.from} onChange={(v) => patch(i, { from: v })} />
          <span className="text-slate-400 text-[11px]">→</span>
          <TimeSelect label="Đến giờ" value={b.to} onChange={(v) => patch(i, { to: v })} />
          {blocks.length > 1 && (
            <button
              type="button"
              onClick={() => removeBlock(i)}
              aria-label="Bỏ dòng này"
              className="flex size-6 items-center justify-center rounded text-[11px] text-slate-400 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
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
function makeRestoreRow(onRefresh: RefreshFn): DeleteRowFn {
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
      await onRefresh();
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

function DutyCoverRow({ duty, parentId, drivers, onFill }: {
  duty: SubDutyConflict;
  parentId: string;
  drivers: ConfigDriver[];
  onFill: FillSubsFn;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const created = useRef(false);
  const saving = useRef(false);
  const [done, setDone] = useState(false);
  const candidates = drivers.filter((d) => d.driver_id !== duty.driver_id && d.driver_id !== parentId);
  const windowLabel = duty.from && duty.to ? duty.from + "–" + duty.to : null;

  async function save() {
    if (saving.current) return;
    const cover = candidates.find((d) => d.name === name);
    if (!cover) { setError("Chọn người thay từ danh sách"); return; }
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      if (!created.current) {
        await createDutyLeave(duty, fetch);
        created.current = true;
      }
      const ok = await onFill(
        { driver_id: duty.driver_id, leave_from: duty.date, timeLabel: windowLabel },
        [{ name: cover.name, from: null, to: null }],
      );
      if (!ok) {
        setError("Đã tạo dòng nghỉ, chưa lưu được người thay. Bấm lưu để thử lại việc gán người thay.");
        return;
      }
      setDone(true);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="mt-1 border-t border-dotted border-amber-400 pt-1 text-[11px] text-amber-800">
      <div className="flex flex-wrap items-center gap-1.5">
        <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
        <DriverName full={duty.name} />
        <span>có {duty.branches} tuyến riêng · {ddmm(duty.date)} · {windowLabel || "Cả ngày"}</span>
        {done ? <span className="text-emerald-700">Đã tạo dòng nghỉ và gán người thay</span> : (
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]"
            disabled={busy} onClick={() => setOpen((v) => !v)}>
            {open ? "Đóng" : "Thêm người thay"}
          </Button>
        )}
      </div>
      {open && (
        <div className="mt-1">
          <p>Tạo dòng nghỉ riêng cho {splitDriverName(duty.name).name} trong ngày và khung giờ trên.</p>
          <fieldset disabled={busy} className="mt-1 flex flex-wrap items-center gap-1.5">
            <DriverCombobox names={name ? [name] : []} onChange={(names) => setName(names[0] || "")}
              drivers={candidates} max={1} ariaLabel={"Người thay cho " + duty.name} />
            <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => void save()} disabled={busy || !name}>
              {busy ? "Đang lưu…" : created.current ? "Lưu người thay" : "Tạo dòng nghỉ và lưu"}
            </Button>
          </fieldset>
        </div>
      )}
      {error && <p role="alert" className="mt-1 text-red-700">{error}</p>}
    </div>
  );
}

function DriverCard({
  g,
  drivers,
  onFill,
  onDelete,
}: {
  g: DriverGroup;
  drivers: ConfigDriver[];
  onFill: FillSubsFn;
  onDelete: DeleteRowFn;
}) {
  const resigned = g.loai_nghi === "Nghỉ việc";
  const uncovered = !resigned && g.rows.some((r) => r.subs.length === 0);
  const [editRow, setEditRow] = useState<number | null>(null);
  // The SAME mark the week grid uses, so a row does not change language
  // between the glance and the work.
  const status = resigned ? "resigned" : uncovered ? "uncovered" : "covered";
  const typeClass = resigned ? "text-red-700" : "text-amber-700";
  return (
    <div className="px-2 py-1.5 text-xs hover:bg-slate-50">
      <div className="flex items-center gap-1.5 flex-wrap">
        <StatusMark status={status} className="size-3.5" />
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
          // Stable, not the array index: a delete or an edit can shift what
          // sits at position i, and an index key would hand that row's local
          // state (SubEditor open, DeleteRowButton armed) to whatever row
          // lands there next.
          <div key={`${r.leave_from}-${r.timeLabel ?? "full"}`}>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-xs">
              {r.timeLabel && <span className="font-mono text-slate-500">{r.timeLabel}</span>}
              {r.subs.length > 0 ? (
                <>
                  <span
                    className="text-emerald-700 break-words"
                    title={`Thay: ${r.subs.map((s) => s.name || s.id).join(", ")}`}
                  >
                    ✓ {r.subs.map((s) => splitDriverName(s.name || s.id).name).join(", ")}
                  </span>
                  {editRow !== i && (
                    <button
                      type="button"
                      onClick={() => setEditRow(i)}
                      className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700"
                    >
                      Sửa
                    </button>
                  )}
                </>
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
            {r.subDutyConflicts?.map((duty) => (
              <DutyCoverRow key={duty.driver_id + duty.date + duty.from + duty.to}
                duty={duty} parentId={g.driver_id} drivers={drivers} onFill={onFill} />
            ))}
            {editRow === i && (
              <SubEditor
                row={r}
                drivers={drivers}
                initial={
                  r.subs.length > 0
                    ? r.subs.map((s) => ({ name: s.name, from: s.from ?? "", to: s.to ?? "" }))
                    : undefined
                }
                onCancel={() => setEditRow(null)}
                onSave={(subs) =>
                  onFill(
                    { driver_id: g.driver_id, leave_from: r.leave_from, timeLabel: r.timeLabel },
                    subs,
                    r.subs.length > 0,
                  )
                }
              />
            )}
          </div>
        ))}
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
  drivers,
  onFill,
  onDelete,
}: {
  item: UncoveredRow;
  drivers: ConfigDriver[];
  onFill: FillSubsFn;
  onDelete: DeleteRowFn;
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
            {/* Primary action first, destructive last. Reading order is action
                order here: "Thêm người thay" is what this row is FOR, and a
                delete sitting in front of it puts the irreversible option under
                the thumb that was reaching for the ordinary one. */}
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => setEditing(true)}
            >
              Thêm người thay
            </Button>
            <DeleteRowButton
              identity={{
                driver_id: item.driver_id,
                leave_from: item.row.leave_from,
                timeLabel: item.row.timeLabel,
              }}
              onDelete={onDelete}
            />
          </span>
        )}
      </div>
      {editing && (
        <SubEditor
          row={item.row}
          drivers={drivers}
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
  onRefresh: RefreshFn;
}) {
  const items = uncoveredWindows(groupByDriver(entries));
  const fillSubs = makeFillSubs(onRefresh);
  const deleteRow = makeDeleteRow(onRefresh);
  if (items.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <SectionHeader label={label} count={items.length} tone="amber" />
      <div className="divide-y divide-slate-100 overflow-hidden rounded-md border border-slate-200">
        {items.map((item) => (
          <UncoveredRowItem
            key={`${item.driver_id}-${item.row.leave_from}-${item.row.timeLabel ?? "full"}`}
            item={item}
            drivers={drivers}
            onFill={fillSubs}
            onDelete={deleteRow}
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
/** Vietnamese weekday, from a YYYY-MM-DD read as UTC so no local offset can
 *  shift it a day. Index 0 is Sunday, which is why the table starts there. */
const WEEKDAY = ["Chủ Nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"] as const;

/**
 * The Monday on or before `date`.
 *
 * Monday, not Sunday: the roster this panel reports on is worked Monday to
 * Saturday, and a week that breaks between Saturday and Sunday would split the
 * busiest stretch across two pages.
 */
export function weekStartOf(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return date;
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}

const DAYS_IN_WEEK = 7;

interface DayLeave {
  date: string;
  entries: LeaveOnDate[];
  invalid: InvalidLeaveRow[];
}

/**
 * A week of leave at a time, paged with the arrows.
 *
 * It replaced a single-date picker plus separate "today" and "tomorrow" blocks.
 * Two things were wrong with that: the question this panel answers is "who is
 * off, and is anyone uncovered" — which is a question about the WEEK, since
 * cover is arranged days ahead — and today appeared twice the moment anyone
 * picked a date, once in its own section and once in the picker's.
 *
 * Every day is listed, including the empty ones. An empty day costs one quiet
 * line and keeps the week's SHAPE readable: "Tuesday is clear, Thursday has
 * four" is the thing being looked for, and a list that silently omits the clear
 * days cannot show it.
 *
 * The whole week arrives in ONE request. `loadLeaveEntries` returns the entire
 * sheet and each day is a filter over that same cached parse, so seven days cost
 * no more upstream work than one — see the note on the route.
 */
/** Weekday, short for a column head and long for a screen reader. Index 0 is
 *  Sunday, matching getUTCDay. */
const WEEKDAY_SHORT = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"] as const;

function weekdayIndex(date: string): number {
  const d = new Date(date + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? -1 : d.getUTCDay();
}
function weekdayShort(date: string): string {
  const i = weekdayIndex(date);
  return i < 0 ? "" : WEEKDAY_SHORT[i];
}
function weekdayLong(date: string): string {
  const i = weekdayIndex(date);
  return i < 0 ? "" : WEEKDAY[i];
}

/** Which person, on which day, is open in the detail strip. Keyed by both
 *  because one person is off on several days of a week. */
interface Picked { date: string; personKey: string }

/**
 * The three things a name in the grid can be saying, in ONE vocabulary.
 *
 * A bare coloured dot said them before, and a dot is not a word: nothing on the
 * screen said what amber meant, and for a reader who cannot separate amber from
 * grey it said nothing at all. Colour is the wrong carrier for the primary
 * signal — it is the right carrier for the SECOND one. So each state now has a
 * SHAPE (the icon), a WORD (the legend under the grid, and the screen-reader
 * text on every row), and a colour reinforcing both.
 */
const STATUS_MARK = {
  uncovered: { Icon: AlertTriangle, tone: "text-amber-600", label: "Chưa có người thay" },
  covered: { Icon: Check, tone: "text-emerald-600", label: "Đã có người thay" },
  resigned: { Icon: Ban, tone: "text-red-600", label: "Nghỉ việc" },
} as const;

type LeaveStatus = keyof typeof STATUS_MARK;

function StatusMark({
  status,
  className = "size-3",
  labelled = false,
}: {
  status: LeaveStatus;
  className?: string;
  /** The legend spells the word out beside the icon, so it must not ALSO be
   *  read out invisibly; every other use is icon-only and needs the text. */
  labelled?: boolean;
}) {
  const { Icon, tone, label } = STATUS_MARK[status];
  return (
    <>
      <Icon className={`${className} shrink-0 ${tone}`} strokeWidth={2.5} aria-hidden />
      {!labelled && <span className="sr-only">{label}. </span>}
    </>
  );
}

/**
 * One PERSON in a day column — their full-time and part-time accounts on one
 * line instead of two.
 *
 * About a dozen people hold both a `DC…` and a `PT…` account, and since the MISA
 * sync began filing the day off against the twin, both are off on the same day.
 * The grid shows names with no staff code, so those arrived as the SAME NAME
 * TWICE in a column, one directly under the other, with nothing to say why.
 *
 * Merging is safe HERE and nowhere else: this grid carries no actions. The two
 * accounts are separate records with separate substitutes, so the card below —
 * where a substitute is actually filled in — still shows one card per account,
 * each with its own FT/PT chip. The grid answers "who is off", the card answers
 * "on which account", and neither has to answer both.
 *
 * Two accounts merge ONLY when they are one full-time and one part-time. That is
 * what a twin pair IS, and the guard matters: Vietnamese names repeat, so two
 * DIFFERENT full-time drivers can share one spelling, and merging THOSE would
 * hide a whole person from the day.
 */
interface PersonCell {
  key: string;
  name: string;
  /** The accounts behind this line, full-time first. */
  groups: DriverGroup[];
  employments: Employment[];
  status: LeaveStatus;
}

function personNameOf(g: DriverGroup): string {
  return splitDriverName(g.driver_name || g.driver_id).name;
}

/** Worst-first: a resigned account outranks an uncovered one, which outranks a
 *  covered one — the line must show the thing that still needs doing. */
function statusOf(groups: DriverGroup[]): LeaveStatus {
  if (groups.some((g) => g.loai_nghi === "Nghỉ việc")) return "resigned";
  return groups.some(
    (g) => g.loai_nghi !== "Nghỉ việc" && g.rows.some((r) => r.subs.length === 0),
  )
    ? "uncovered"
    : "covered";
}

export function mergePeople(groups: DriverGroup[]): PersonCell[] {
  const byPerson = new Map<string, DriverGroup[]>();
  for (const g of groups) {
    const key = personNameOf(g).trim().toLowerCase();
    const list = byPerson.get(key);
    if (list) list.push(g);
    else byPerson.set(key, [g]);
  }
  const cell = (key: string, gs: DriverGroup[]): PersonCell => {
    const sorted = [...gs].sort((a, b) => compareDriverNames(a.driver_name, b.driver_name));
    return {
      key,
      name: personNameOf(sorted[0]),
      groups: sorted,
      employments: sorted
        .map((g) => employmentOf(g.driver_name))
        .filter((e): e is Employment => e !== null),
      status: statusOf(sorted),
    };
  };
  const cells: PersonCell[] = [];
  for (const [key, gs] of byPerson) {
    const types = gs.map((g) => employmentOf(g.driver_name));
    const pair =
      gs.length > 1 &&
      types.every((t) => t !== null) &&
      new Set(types).size === gs.length;
    if (pair) cells.push(cell(key, gs));
    // Not a twin pair: keep every account its own line, keyed by the account so
    // two people sharing a name stay two lines.
    else for (const g of gs) cells.push(cell(`${key}|${g.driver_id}`, [g]));
  }
  return cells.sort(
    (a, b) => a.name.localeCompare(b.name, "vi") || a.key.localeCompare(b.key),
  );
}

/**
 * The week as SEVEN COLUMNS, with the day being worked on opened underneath.
 *
 * A column is ~150px, which fits a name and a window and nothing else — the sub
 * editor alone is a name field plus two time selects plus two buttons. So the
 * grid is not asked to carry the actions. It carries the SHAPE of the week,
 * which is what seven columns are uniquely good at: "Thursday is the problem"
 * is one glance here and a scroll through seven headings in a list.
 *
 * Picking a name opens that driver's day below the grid at full width, in the
 * SAME DriverCard the rest of the panel uses. That is the whole trick: the
 * compact view is new, the acting view is the one that already works, so there
 * is no second copy of the substitute editor or the delete guard to drift.
 *
 * Columns collapse before they get unreadable — two on a phone, four on a
 * tablet, seven only where seven fit. A 150px column at 7-across on a 700px
 * screen is 100px, and a Vietnamese name does not go in 100px.
 *
 * A column holds one line per PERSON, not per account (`mergePeople`), and each
 * line carries a marked STATE with a legend under the grid rather than an
 * unexplained coloured dot. Both are there for the same reason: a column this
 * narrow has room for one name and one symbol, so the name had better be a
 * person and the symbol had better mean something without being hovered.
 */
function WeekSection({
  today,
  drivers,
  onFill,
  onDelete,
  registerReload,
  refreshKey,
}: {
  /** Saigon's today: the default week, and the day marked as current. */
  today: string;
  drivers: ConfigDriver[];
  onFill: FillSubsFn;
  onDelete: DeleteRowFn;
  /** Hands the parent a way to re-read the shown week after a write, so a
   *  substitute filled in here does not leave the row still reading uncovered. */
  registerReload: (fn: RefreshFn | null) => void;
  /** Bumped by every explicit refresh upstream ("Làm mới"). The grid has its
   *  OWN fetch, which nothing else re-issues — so without this, pressing
   *  refresh re-read today and tomorrow and left this week exactly as it was,
   *  however many times it was pressed. A row typed straight into the workbook
   *  was then invisible here until the page was reloaded or the week paged away
   *  and back. */
  refreshKey: number;
}) {
  const [weekStart, setWeekStart] = useState(() => weekStartOf(today));
  const [picked, setPicked] = useState<Picked | null>(null);
  const [state, setState] = useState<{
    loading: boolean;
    error: string | null;
    /** The week actually loaded — not `weekStart`, which changes the moment an
     *  arrow is pressed. Keeping them apart is what stops one week's columns
     *  being labelled with another week's dates while a fetch is in flight. */
    shown: string | null;
    days: DayLeave[];
  }>({ loading: true, error: null, shown: null, days: [] });

  // `fresh` busts the SERVER's parse, not the browser's. Paging weeks does not
  // need it — every day is a filter over one cached read — but an explicit
  // refresh does: a row typed into the workbook by hand invalidates nothing, so
  // without it the answer can come from a copy taken before that edit and the
  // refresh reports the sheet as it was.
  const load = useCallback(async (from: string, fresh = false) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch(
        `/api/leave-status?date=${encodeURIComponent(from)}&days=${DAYS_IN_WEEK}${fresh ? "&fresh=1" : ""}`,
        { cache: "no-store" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.picked) throw new Error(data.error || `Lỗi ${res.status}`);
      setState({
        loading: false,
        error: null,
        shown: String(data.picked.from ?? from),
        days: Array.isArray(data.picked.days) ? (data.picked.days as DayLeave[]) : [],
      });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  useEffect(() => { void load(weekStart); }, [load, weekStart]);
  // A different week cannot keep the old week's selection open.
  useEffect(() => { setPicked(null); }, [weekStart]);

  // An upstream refresh re-reads THIS week too, and forces the sheet. Skipped on
  // mount, where the effect above has just loaded it.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    void load(weekStart, true);
    // weekStart is deliberately absent: a week CHANGE is already loaded above,
    // and listing it here would fire a second, forced read on every arrow press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, load]);

  useEffect(() => {
    registerReload(state.shown ? () => load(state.shown!) : null);
    return () => registerReload(null);
  }, [registerReload, load, state.shown]);

  const thisWeek = weekStartOf(today);
  const nextWeek = addDays(thisWeek, DAYS_IN_WEEK);
  const weekEnd = addDays(weekStart, DAYS_IN_WEEK - 1);

  // Grouped once, used by both the columns and the detail strip below. Counted
  // in PEOPLE, matching what the grid draws — a badge saying 9 above a column
  // you can count 8 names in is a badge nobody trusts again.
  const byDay = state.days.map((d) => ({
    date: d.date,
    people: mergePeople(groupByDriver(d.entries)),
    ignored: d.invalid.filter((r) => !r.recovered).length,
  }));
  const uncoveredOn = (people: PersonCell[]) =>
    people.filter((p) => p.status === "uncovered").length;
  const weekUncovered = byDay.reduce((n, d) => n + uncoveredOn(d.people), 0);

  // The open person, re-found in the CURRENT data rather than remembered: a
  // write may have removed the very row that was open, and a stale copy would
  // keep offering to delete something already gone.
  const openDay = picked ? byDay.find((d) => d.date === picked.date) : undefined;
  const openCell = openDay?.people.find((p) => p.key === picked?.personKey);

  return (
    <div className="mt-2 border-t border-slate-200 pt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex items-center gap-0.5">
          <Button
            size="sm" variant="outline"
            className="size-6 p-0"
            aria-label="Tuần trước"
            onClick={() => setWeekStart((w) => addDays(w, -DAYS_IN_WEEK))}
          >
            <ChevronLeft className="size-3.5" strokeWidth={2} />
          </Button>
          <Button
            size="sm" variant="outline"
            className="size-6 p-0"
            aria-label="Tuần sau"
            onClick={() => setWeekStart((w) => addDays(w, DAYS_IN_WEEK))}
          >
            <ChevronRight className="size-3.5" strokeWidth={2} />
          </Button>
        </div>
        {/* Announced, because the arrows change the whole grid below and a
            screen reader would otherwise hear nothing move. */}
        <span aria-live="polite" className="text-xs font-semibold text-slate-800">
          {ddmm(weekStart)} – {ddmm(weekEnd)}
        </span>
        {([["Tuần hiện tại", thisWeek], ["Tuần tới", nextWeek]] as const).map(([label, target]) => {
          const on = weekStart === target;
          return (
            <Button
              key={label}
              size="sm" variant="outline"
              className={`h-6 px-2 text-[11px] ${on ? "border-indigo-400 bg-indigo-50 text-indigo-900" : ""}`}
              aria-pressed={on}
              onClick={() => setWeekStart(target)}
            >
              {label}
            </Button>
          );
        })}
        {weekUncovered > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-100 px-1.5 py-0 text-[11px] font-semibold text-amber-800">
            <AlertTriangle className="size-3" strokeWidth={2} />
            {weekUncovered} chưa có người thay
          </span>
        )}
      </div>

      {state.loading && (
        <div className="mt-1.5 grid grid-cols-2 gap-1 md:grid-cols-4 xl:grid-cols-7" aria-hidden>
          {Array.from({ length: DAYS_IN_WEEK }, (_, i) => (
            <div key={i} className="h-20 animate-pulse rounded border border-slate-200 bg-slate-100 motion-reduce:animate-none" />
          ))}
        </div>
      )}
      <span role="status" className="sr-only">
        {state.loading ? "Đang tải lịch nghỉ trong tuần" : ""}
      </span>

      {state.error && (
        <div role="alert" className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-red-700">
          <span className="min-w-0 break-words">{state.error}</span>
          <Button
            size="sm" variant="outline"
            className="h-6 shrink-0 px-2 text-[11px]"
            onClick={() => void load(weekStart)}
          >
            Thử lại
          </Button>
        </div>
      )}

      {!state.loading && !state.error && state.shown && (
        <>
          <div className="mt-1.5 grid grid-cols-2 items-start gap-1 md:grid-cols-4 xl:grid-cols-7">
            {byDay.map((d) => {
              const isToday = d.date === today;
              const uncovered = uncoveredOn(d.people);
              return (
                <div
                  key={d.date}
                  className={`min-w-0 overflow-hidden rounded-md border ${
                    isToday ? "border-indigo-300 bg-indigo-50/50" : "border-slate-200 bg-white"
                  }`}
                >
                  <div className={`px-1.5 py-1 ${isToday ? "bg-indigo-100/70" : "bg-slate-50"}`}>
                    <div className="flex items-baseline justify-between gap-1">
                      {/* Short in the head, spelled out for a screen reader —
                          "T5" is a label a sighted reader decodes from position
                          and a screen reader cannot decode at all. */}
                      <span className="text-[11px] font-semibold text-slate-800">
                        <abbr title={`${weekdayLong(d.date)} ${ddmm(d.date)}`} className="no-underline">
                          {weekdayShort(d.date)}
                        </abbr>
                      </span>
                      <span className="font-mono text-[10px] text-slate-600">{ddmm(d.date)}</span>
                    </div>
                    {(uncovered > 0 || d.ignored > 0) && (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {uncovered > 0 && (
                          <span className="inline-flex items-center gap-0.5 rounded-full border border-amber-300 bg-amber-100 px-1 py-0 text-[10px] font-semibold text-amber-800">
                            <AlertTriangle className="size-2.5" strokeWidth={2} />
                            {uncovered}
                          </span>
                        )}
                        {d.ignored > 0 && (
                          <span className="rounded-full border border-red-200 bg-red-50 px-1 py-0 text-[10px] font-semibold text-red-700">
                            {d.ignored} lỗi
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {d.people.length === 0 ? (
                    // Named, not dashed. A day with nobody off is an ANSWER —
                    // the one the eye is looking for when it scans the week —
                    // and "—" reads as missing data rather than as good news.
                    <p className="px-1.5 py-1 text-[11px] text-slate-400">Không ai nghỉ</p>
                  ) : (
                    <ul className="divide-y divide-slate-100">
                      {d.people.map((p) => {
                        const sel = picked?.date === d.date && picked?.personKey === p.key;
                        const both = p.groups.length > 1;
                        const pt = p.employments.includes("part-time");
                        return (
                          <li key={p.key}>
                            <button
                              type="button"
                              aria-pressed={sel}
                              onClick={() =>
                                setPicked(sel ? null : { date: d.date, personKey: p.key })
                              }
                              title={`${p.name}${both ? " — nghỉ cả tài khoản FT và PT" : ""} — ${STATUS_MARK[p.status].label.toLowerCase()} — ${weekdayLong(d.date)} ${ddmm(d.date)}`}
                              className={`flex w-full items-center gap-1 px-1.5 py-1 text-left transition-colors duration-150 ${
                                sel ? "bg-indigo-100" : "hover:bg-slate-50"
                              }`}
                            >
                              <StatusMark status={p.status} className="size-3" />
                              <span className="min-w-0 flex-1 truncate text-[11px] text-slate-800">{p.name}</span>
                              {/* Only when it is not the ordinary case: a
                                  full-time-only line is most of the grid, and
                                  chipping every one of them spends the width on
                                  the thing that is always true. */}
                              {(both || pt) && (
                                <span className="shrink-0 rounded-full border border-indigo-200 bg-indigo-50 px-1 text-[9px] font-semibold leading-4 text-indigo-700">
                                  {both ? "FT+PT" : "PT"}
                                </span>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>

          {/* What the marks mean, written down. The grid is glanceable only if
              its symbols are already known, and this is where they become
              known — once, under the thing they label, rather than in a tooltip
              nobody hovers. */}
          <ul className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-slate-600">
            {(["uncovered", "covered", "resigned"] as const).map((k) => (
              <li key={k} className="inline-flex items-center gap-0.5">
                <StatusMark status={k} className="size-2.5" labelled />
                {STATUS_MARK[k].label}
              </li>
            ))}
            <li className="inline-flex items-center gap-0.5">
              <span className="rounded-full border border-indigo-200 bg-indigo-50 px-1 text-[9px] font-semibold leading-4 text-indigo-700">
                FT+PT
              </span>
              Nghỉ cả hai tài khoản
            </li>
          </ul>

          {/* The day being worked on, full width, in the card the rest of the
              panel already uses — so the substitute editor and the delete guard
              have exactly one implementation. */}
          {openCell && picked && (
            <div
              className="mt-1.5 rounded-md border border-indigo-300 bg-indigo-50/40 p-1.5"
              role="region"
              aria-label={`${openCell.name} — ${weekdayLong(picked.date)} ${ddmm(picked.date)}`}
            >
              <div className="mb-1 flex flex-wrap items-baseline gap-x-1.5">
                <span className="text-[11px] font-semibold text-slate-800">
                  {weekdayLong(picked.date)} {ddmm(picked.date)}
                </span>
                {openCell.groups.length > 1 && (
                  <span className="text-[11px] text-slate-600">
                    hai tài khoản — người thay điền riêng cho từng cái
                  </span>
                )}
                <Button
                  size="sm" variant="ghost"
                  className="ml-auto h-6 px-2 text-[11px]"
                  onClick={() => setPicked(null)}
                >
                  Đóng
                </Button>
              </div>
              {/* One card per ACCOUNT. The grid merged the twin pair into a
                  single name because it only had to say who is off; here the
                  substitute is actually written, and a substitute covers one
                  account — so the two come back apart, each with its FT/PT
                  chip. */}
              <div className="divide-y divide-slate-100 overflow-hidden rounded-md border border-slate-200 bg-white">
                {openCell.groups.map((g) => (
                  <DriverCard
                    key={g.driver_id}
                    g={g}
                    drivers={drivers}
                    onFill={onFill}
                    onDelete={onDelete}
                  />
                ))}
              </div>
            </div>
          )}
        </>
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
  refreshKey = 0,
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
  onRefresh: RefreshFn;
  /** Bumped by the dashboard on every explicit refresh, so the week grid
   *  below re-reads too — see WeekSection's own note. */
  refreshKey?: number;
}) {
  const [open, setOpen] = useState(false);
  const noData = today.length === 0 && tomorrow.length === 0;
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
  // Both, and not done until BOTH are — the write's caller keeps its button
  // busy on this promise, so releasing it while the week grid is still
  // re-reading is the same lie the un-awaited refresh told.
  const refreshBoth = useCallback(
    async () => { await Promise.all([onRefresh(), otherDayReload.current?.()]); },
    [onRefresh],
  );
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
          <div className="mt-2 max-h-[60vh] overflow-y-auto">
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
            {/* The whole week, today marked in place. There is no separate
                today/tomorrow block here: the always-visible "Cần xử lý" list
                above already carries the two urgent days, so repeating them
                inside the panel you EXPAND for a wider range only showed the
                same rows twice. */}
            {/* Above the week, because it is the one thing here that CREATES a
                row rather than repairing one — and after the alarms, which say
                whether the sheet can be trusted at all right now. */}
            <AddLeaveForm drivers={drivers} onSaved={refreshBoth} />
            <WeekSection
              today={vnDate()}
              drivers={drivers}
              onFill={otherDayFill}
              onDelete={otherDayDelete}
              registerReload={registerOtherDayReload}
              refreshKey={refreshKey}
            />
            {/* LAST, below the week. This is a reference list, not a task: every
                line on it is already handled — a day someone deliberately
                removed, held down so the sync cannot undo it. Reading it is how
                you check a past decision, which is what you do after looking at
                the week, not before. The unreadable-tab alarm above stays where
                it is: that one IS a fault, and it says the blocking is off. */}
            {suppressed.length > 0 && (
              <div className="mt-2 rounded-md border border-slate-300 bg-slate-50 px-2 py-1.5">
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
          </div>
        )}
      </CardContent>
    </Card>
  );
}
