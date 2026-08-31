"use client";

import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, ClipboardList, Clock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DIAG_LOCATIONS } from "@/lib/diag-locations";
import { DriverPicker } from "./driver-picker";
import { DayTimePicker, DAY_LABELS, vnNowLabel, scheduledAtFor, isTimePast } from "./day-time-picker";
import { NoteReviewPanel, type HeldJob } from "./note-review-panel";
import { NoteSuggestionPanel } from "./note-suggestion-panel";
import { SectionHeader } from "./section-header";
import { UncoveredLeaveSection, uncoveredLeaveCount } from "./leave-status-panel";
import type { CoverageGap, UnfinishedConfigRow, FailedJob, FailedReason, PickupWarning, ConfigDriver } from "@/lib/types";
import type { LeaveOnDate } from "@/lib/leave-config";

export interface ScheduleErrorRow {
  pickup_id: string;
  pickup_name?: string;
  dropoff_id: string;
  dropoff_name?: string;
  delivery_window: string;
  reference_number: string;
  message: string;
  job_id?: number;
}

const NAME_BY_ID = new Map(DIAG_LOCATIONS.map((l) => [l.customer_id, l.name]));
// Prefer the sheet's own name; fall back to the branch list, then the raw id.
const labelFor = (name: string | undefined, id: string) => name || NAME_BY_ID.get(id) || id;

// Reason → label + tone. Tone colours the section header (red = blocking,
// nothing the engine can do — needs a person; amber = config/ambiguity a
// supervisor resolves via Sheet edit or driver pick). Order = display priority.
const REASON_META: Record<
  FailedReason,
  { label: string; tone: "red" | "amber"; order: number }
> = {
  // RED vs AMBER is a statement about how much is broken, not how annoying it is.
  //
  //   red   — the branch cannot be served at all: there is no line for it, or the
  //           line it has names something the engine cannot use. Every job from
  //           there is stuck until someone adds or repairs a row.
  //   amber — the branch IS configured and works; one window, one destination or
  //           one day is uncovered. A boundary to adjust, not a row to create.
  //
  // These two were the wrong way round: a branch with no configuration at all was
  // the softer colour, while an uncovered hour — which usually means one shift
  // ends at 14:30 and the next starts at 16:30 — was the loud one.
  NO_MAPPING:     { label: "Chưa cấu hình (Sheet)", tone: "red",   order: 0 },
  UNAVAILABLE:    { label: "Giao Nhận Mẫu bận / offline", tone: "red", order: 1 },
  ON_LEAVE:       { label: "Nghỉ, không người thay", tone: "amber", order: 2 },
  CLASH:          { label: "Trùng tài xế trực", tone: "amber", order: 3 },
  SUB_CLASH:      { label: "Trùng người thay", tone: "amber", order: 4 },
  // "Không có tài xế trực" read as a staffing problem — nobody available — when
  // it almost always means the opposite: the drivers are there, no ROW covers
  // that hour. Named for the fix it needs, next to its sibling below.
  NO_DRIVER:      { label: "Thiếu ca cho giờ này", tone: "amber", order: 5 },
  NO_DROPOFF_RULE:{ label: "Chưa cấu hình điểm giao", tone: "amber", order: 6 },
  INVALID_DRIVER: { label: "Sai driver_id (Sheet)", tone: "red", order: 7 },
  DEACTIVATED:    { label: "Tài khoản tài xế đã bị khoá", tone: "red", order: 8 },
  NO_GPS:         { label: "Thiếu toạ độ GPS", tone: "red", order: 9 },
};

/**
 * A Google Maps route between the two ends of the trip.
 *
 * Coordinates, never names: the branch names in this list are internal codes
 * ("BRA - D001", "3PL - TLT") that no map could place. Returns null when either
 * end has no coordinates, so the caller falls back to the Cartrack link rather
 * than opening a map of nowhere.
 */
export function gmapsRoute(routeGps: string | undefined): string | null {
  const [from, to] = (routeGps ?? "").split(";");
  if (!from || !to) return null;
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&travelmode=driving`;
}

const cartrackJob = (jobId: number) => `https://fleetweb-vn.cartrack.com/delivery/map?job=${jobId}`;


/**
 * Fold accents so a name typed quickly still matches: "quynh" has to find
 * "Nguyễn Hữu Quỳnh". đ is handled separately — it is a distinct Vietnamese
 * letter, not a d with a mark, so decomposition leaves it untouched.
 */
const foldName = (v: string) =>
  v.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

/**
 * Resolve a typed name against the roster, refusing anything ambiguous.
 *
 * The roster is what the sheet's own lookup resolves against, so a name that is
 * not on it writes perfectly well and then resolves to nothing — a row that
 * looks finished and assigns nobody.
 */
function resolveDriver(typed: string, drivers: ConfigDriver[]): { name: string } | { error: string } {
  const q = foldName(typed.trim());
  if (!q) return { error: "Chưa chọn tài xế" };
  const exact = drivers.filter((d) => foldName(d.name) === q);
  const hits = exact.length ? exact : drivers.filter((d) => foldName(d.name).includes(q));
  if (hits.length === 0) return { error: `"${typed}" không có trong tab Driver — chọn từ danh sách` };
  if (hits.length > 1) return { error: `"${typed}" khớp ${hits.length} tài xế — gõ rõ hơn` };
  return { name: hits[0].name };
}

const CONFIG_NAMES_LIST_ID = "config-driver-names";

/**
 * One unfinished config line, and the decision it is waiting for.
 *
 * Shaped like the leave module's substitute editor on purpose: the same people
 * use both, and the same gesture should look the same — a name, a window, and a
 * button that splits the work across more than one row.
 *
 * The hours are editable because the engine only guessed them, from the hour
 * block around the job that failed. That is a hint about when the branch needs
 * collecting, not a shift anyone agreed to.
 */
function UnfinishedRow({
  u, drivers, onSaved,
}: {
  u: UnfinishedConfigRow;
  drivers: ConfigDriver[];
  onSaved: (key?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [from, to] = (u.window ?? "–").split("–");
  // One block = one rule. A branch collected morning and afternoon by different
  // drivers needs two rows, which is what "+ Thêm config" adds — the same split
  // the leave editor offers, for the same reason.
  const [blocks, setBlocks] = useState([{ name: "", start: from ?? "", end: to ?? "" }]);

  const patch = (i: number, v: Partial<(typeof blocks)[number]>) =>
    setBlocks((bs) => bs.map((b, j) => (j === i ? { ...b, ...v } : b)));
  const addBlock = () => setBlocks((bs) => [...bs, { name: "", start: "", end: "" }]);
  const dropBlock = (i: number) => setBlocks((bs) => bs.filter((_, j) => j !== i));

  async function save() {
    setErr(null);
    const resolved: { name: string; start: string; end: string }[] = [];
    for (const b of blocks) {
      const r = resolveDriver(b.name, drivers);
      if ("error" in r) { setErr(r.error); return; }
      // More than one rule for a branch means each MUST carry its own window:
      // an open one covers the whole day and would clash with its siblings.
      if (blocks.length > 1 && (!b.start.trim() || !b.end.trim())) {
        setErr("Nhiều dòng thì mỗi dòng cần khung giờ riêng");
        return;
      }
      resolved.push({ name: r.name, start: b.start.trim(), end: b.end.trim() });
    }

    setBusy(true);
    try {
      // The first block fills the row that already exists; the rest become new
      // rows. Sequential on purpose — a failure part way through then leaves a
      // clear picture rather than an unknown number of half-written lines.
      const [first, ...rest] = resolved;
      const post = async (url: string, body: unknown) => {
        const res = await fetch(url, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) throw new Error(j.error || `Lỗi ${res.status}`);
        return j;
      };
      await post("/api/config/complete-row", {
        row: u.row, pickup_name: u.pickup_name, driver_name: first.name,
        shift_start: first.start, shift_end: first.end,
      });
      for (const b of rest) {
        await post("/api/config/add-rule", {
          pickup_name: u.pickup_name, dropoff_name: u.dropoff_name,
          driver_name: b.name, shift_start: b.start, shift_end: b.end,
        });
      }
      toast.success(
        rest.length
          ? `Đã tạo ${resolved.length} dòng cho ${u.pickup_name}`
          : `Đã gán ${first.name} cho ${u.pickup_name} (dòng ${u.row})`,
      );
      setOpen(false);
      onSaved(`u:${u.row}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const timeBox = "w-[72px] rounded border border-slate-300 px-1.5 py-1 text-xs font-mono";

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
            Chọn tài xế
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-1 space-y-1 rounded border border-slate-300 bg-white p-1.5">
          {blocks.map((b, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1">
              <input
                type="text"
                list={CONFIG_NAMES_LIST_ID}
                placeholder="Tên tài xế…"
                value={b.name}
                onChange={(e) => patch(i, { name: e.target.value })}
                className="min-w-[140px] flex-1 rounded border border-slate-300 px-1.5 py-1 text-xs"
              />
              <input
                className={timeBox}
                value={b.start}
                placeholder="07:00"
                onChange={(e) => patch(i, { start: e.target.value })}
              />
              <span className="text-slate-400 text-[11px]">→</span>
              <input
                className={timeBox}
                value={b.end}
                placeholder="08:00"
                onChange={(e) => patch(i, { end: e.target.value })}
              />
              {blocks.length > 1 && (
                <button
                  type="button"
                  onClick={() => dropBlock(i)}
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
                + Thêm config
              </Button>
            )}
            <div className="ml-auto flex gap-1">
              <Button
                size="sm" variant="outline" className="h-6 px-2 text-[11px]"
                onClick={() => { setOpen(false); setErr(null); }} disabled={busy}
              >
                Hủy
              </Button>
              <Button
                size="sm" className="h-6 px-2 text-[11px] bg-indigo-600 hover:bg-indigo-700"
                onClick={save} disabled={busy}
              >
                {busy ? "Đang lưu…" : "Lưu"}
              </Button>
            </div>
          </div>
          {err && <div className="text-[11px] text-red-600">{err}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * An hour a job needed and nobody was rostered for.
 *
 * Shows the cover either side of the hole, because that is the diagnosis: "ends
 * 14:30, next starts 16:30" tells you at a glance which boundary is wrong.
 *
 * Only ONE of the three closes it. Widening both neighbours would leave them
 * overlapping, which is the fault this same panel reports elsewhere; and the
 * third — a rule of its own — is often the honest one, because when nobody
 * either side really works that stretch, stretching their hours records
 * something untrue about who is on duty.
 */
function GapRow({
  g, drivers, onSaved,
}: {
  g: CoverageGap;
  drivers: ConfigDriver[];
  onSaved: (key?: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [splitting, setSplitting] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const key = `g:${g.customer_id}|${g.at}`;
  const splitFrom = g.before ? g.before.window.split("–")[1] : g.at;
  const splitTo = g.after ? g.after.window.split("–")[0] : g.at;

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) throw new Error(j.error || `Lỗi ${res.status}`);
    return j;
  };

  async function stretch(row: number, edge: "start" | "end", tag: string) {
    setBusy(tag); setErr(null);
    try {
      await post("/api/config/stretch-rule", { row, pickup_name: g.pickup_name, edge, value: g.at });
      toast.success(`Đã sửa ca dòng ${row} — ${g.pickup_name}`);
      onSaved(key);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function addRule() {
    const r = resolveDriver(name, drivers);
    if ("error" in r) { setErr(r.error); return; }
    setBusy("split"); setErr(null);
    try {
      const j = await post("/api/config/add-rule", {
        pickup_name: g.pickup_name, driver_name: r.name, shift_start: splitFrom, shift_end: splitTo,
      });
      toast.success(`Đã thêm dòng ${j.row} — ${r.name} ${splitFrom}–${splitTo}`);
      setSplitting(false);
      onSaved(key);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="px-2 py-1.5 hover:bg-slate-50">
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[11px] text-amber-800">
          {g.at}
        </span>
        <span className="min-w-0 flex-1 break-words md:truncate text-sm font-medium text-slate-800" title={g.pickup_name}>
          {g.pickup_name}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-600">
        <span>
          {g.before ? `Ca trước hết lúc ${g.before.window.split("–")[1]}` : "Không có ca trước"}
          {" · "}
          {g.after ? `ca sau bắt đầu ${g.after.window.split("–")[0]}` : "không có ca sau"}
        </span>
        {g.before && (
          <Button
            size="sm" variant="outline" className="h-6 px-2 text-[11px]"
            disabled={busy !== null}
            onClick={() => stretch(g.before!.row, "end", "before")}
            title={`Dòng ${g.before.row} · ${g.before.driver}`}
          >
            {busy === "before" ? "Đang lưu…" : `Kéo dài ca trước đến ${g.at}`}
          </Button>
        )}
        {g.after && (
          <Button
            size="sm" variant="outline" className="h-6 px-2 text-[11px]"
            disabled={busy !== null}
            onClick={() => stretch(g.after!.row, "start", "after")}
            title={`Dòng ${g.after.row} · ${g.after.driver}`}
          >
            {busy === "after" ? "Đang lưu…" : `Ca sau bắt đầu từ ${g.at}`}
          </Button>
        )}
        {!splitting && splitFrom !== splitTo && (
          <Button
            size="sm" variant="outline" className="h-6 px-2 text-[11px]"
            disabled={busy !== null}
            onClick={() => { setSplitting(true); setErr(null); }}
          >
            + Thêm config {splitFrom}–{splitTo}
          </Button>
        )}
      </div>

      {splitting && (
        <div className="mt-1 space-y-1 rounded border border-slate-300 bg-white p-1.5">
          <div className="flex flex-wrap items-center gap-1">
            <input
              type="text"
              list={CONFIG_NAMES_LIST_ID}
              placeholder="Tên tài xế…"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="min-w-[140px] flex-1 rounded border border-slate-300 px-1.5 py-1 text-xs"
            />
            <span className="font-mono text-[11px] text-slate-600">{splitFrom}–{splitTo}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="ml-auto flex gap-1">
              <Button
                size="sm" variant="outline" className="h-6 px-2 text-[11px]"
                onClick={() => { setSplitting(false); setErr(null); }} disabled={busy !== null}
              >
                Hủy
              </Button>
              <Button
                size="sm" className="h-6 px-2 text-[11px] bg-indigo-600 hover:bg-indigo-700"
                onClick={addRule} disabled={busy !== null}
              >
                {busy === "split" ? "Đang tạo…" : "Tạo dòng"}
              </Button>
            </div>
          </div>
        </div>
      )}
      {err && <div className="mt-1 text-[11px] text-red-600">{err}</div>}
    </div>
  );
}

function metaFor(reason: FailedReason) {
  return REASON_META[reason] ?? { label: reason, tone: "red" as const, order: 99 };
}

/** Late duration: under 60 min as +N', otherwise +Xh / +Xh YY'. */
function fmtLate(m: number): string {
  if (m < 60) return `+${m}'`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `+${h}h${mm}'` : `+${h}h`;
}

/** Reference time the "+N'" delay is counted from: the start of the working day
 *  for pickups whose own anchor fell before it (clock_from), else the
 *  delivery-window start (the "arrive-at" time) for windowed pickups, else the
 *  job's creation time. `time` is
 *  the compact HH:mm shown next to the delay badge; `full` is the labelled form for
 *  the tooltip (carries the window's end time too). Window times are raw
 *  "HH:mm:ss+07:00" (slice HH:mm); create_ts is a Cartrack ts → HH:mm. */
function refTime(w: PickupWarning): { time: string; full: string } | null {
  // A floored clock wins: the delay is counted from the start of the working day,
  // not from a window or creation time that fell before it.
  if (w.clock_from) return { time: w.clock_from, full: `Tính từ ${w.clock_from}` };
  if (w.window_time_from) {
    const from = w.window_time_from.slice(0, 5);
    const to = w.window_time_to?.slice(0, 5);
    return { time: from, full: `Khung giờ ${from}${to ? `–${to}` : ""}` };
  }
  if (w.create_ts) {
    const m = /[ T](\d{2}:\d{2})/.exec(w.create_ts);
    if (m) return { time: m[1], full: `Tạo lúc ${m[1]}` };
  }
  return null;
}

function FailedRow({
  job,
  drivers,
  onAssign,
  onSchedule,
}: {
  job: FailedJob;
  drivers: ConfigDriver[];
  onAssign: (job: FailedJob, driverId: string) => void;
  onSchedule: (job: FailedJob, scheduledAt: string, label: string) => void;
}) {
  const [showDriverSelect, setShowDriverSelect] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [dayOffset, setDayOffset] = useState(0);
  const [timeLabel, setTimeLabel] = useState<string | null>(null);

  // Only unconfigured customers get the scheduler. Every other reason is a
  // roster problem the supervisor fixes by naming a driver; NO_MAPPING is the one
  // where the right answer is often "not now" — the client isn't in the sheet
  // yet, so park the job on its real pickup time instead of forcing it out to
  // whoever is free. Parking drops it off the unassigned list, so it stops
  // re-flagging every cycle, and it comes back an hour before it is due.
  const canSchedule = job.reason === "NO_MAPPING";
  const timeIsPast = isTimePast(dayOffset, timeLabel);
  const scheduleReady = !!timeLabel && !timeIsPast;

  const pickDay = (offset: number) => {
    // Switching back to today invalidates a slot that has already gone by.
    if (offset === 0 && timeLabel && timeLabel <= vnNowLabel()) setTimeLabel(null);
    setDayOffset(offset);
  };

  const closeSchedule = () => {
    setShowSchedule(false);
    setTimeLabel(null);
    setDayOffset(0);
  };

  return (
    <div className="px-2 py-1.5 hover:bg-slate-50">
      {/* Line 1: job link · route (reason lives in the section header) */}
      <div className="flex items-center gap-2 min-w-0">
        {/* The job number opens the ROUTE — the question being asked here is
            "where does this trip run", which Cartrack's own map answers slowly
            and only for someone already signed in. Cartrack stays one click
            away for the job's actual record. */}
        <a
          href={gmapsRoute(job.route_gps) ?? cartrackJob(job.job_id)}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 font-mono font-semibold text-indigo-600 underline hover:text-indigo-800"
          title={gmapsRoute(job.route_gps) ? "Mở đường đi trên Google Maps" : "Mở trên Cartrack (job này chưa có toạ độ)"}
        >
          Job {job.job_id}
        </a>
        {gmapsRoute(job.route_gps) && (
          <a
            href={cartrackJob(job.job_id)}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800"
            title="Mở job trên Cartrack"
          >
            Cartrack
          </a>
        )}
        {/* Mobile has no hover for the title tooltip, so wrap there; truncate from md up. */}
        <span className="min-w-0 flex-1 break-words md:truncate text-sm font-medium text-slate-800" title={job.customer}>
          {job.customer}
        </span>
        {/* Appointment time (pickup delivery window) when the job has one — a job
            only fails with its window already due, so this is what the manual pick
            is racing. ASAP jobs have none and show nothing. */}
        {job.delivery_window && (
          <span
            className="shrink-0 flex items-center gap-1 text-xs font-semibold tabular-nums text-slate-700 whitespace-nowrap"
            title={`Khung giờ ${job.delivery_window}`}
          >
            <Clock className="w-3.5 h-3.5 text-slate-400" aria-hidden />
            {job.delivery_window}
          </span>
        )}
      </div>
      {/* Line 2: detail · last-seen · manual-assign trigger */}
      <div className="mt-0.5 flex items-center gap-2 min-w-0">
        <span className="min-w-0 flex-1 break-words md:truncate text-[11px] text-slate-500" title={job.detail}>
          {job.detail}
        </span>
        <span className="shrink-0 text-[11px] text-slate-500">{job.ts.slice(11, 19)}</span>
        {!showDriverSelect && !showSchedule && (
          <>
            {canSchedule && (
              <Button
                size="sm"
                variant="outline"
                className="text-[11px] h-6 px-2 shrink-0"
                onClick={() => {
                  setShowDriverSelect(false);
                  setShowSchedule(true);
                }}
              >
                <Clock className="size-3 shrink-0" strokeWidth={2} aria-hidden />
                Hẹn giờ
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="text-[11px] h-6 px-2 shrink-0"
              onClick={() => {
                setShowSchedule(false);
                setShowDriverSelect(true);
              }}
            >
              Gán thủ công
            </Button>
          </>
        )}
      </div>

      {/* Every failed-assign reason ends with the job unassigned, so all of them
          allow a manual pick. (Manual assign is a direct Cartrack assign by
          job_id + driver_id — independent of the sheet mapping.) */}
      {showDriverSelect && (
        <DriverPicker
          drivers={drivers}
          onConfirm={(driverId) => onAssign(job, driverId)}
          onCancel={() => setShowDriverSelect(false)}
        />
      )}

      {/* Same machinery as the note-held "Hẹn giờ": a delivery window plus a
          release an hour before it, so the job parks and comes back when it is
          actually due. */}
      {showSchedule && (
        <div className="mt-1 animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none space-y-2 rounded-md border border-indigo-200 bg-indigo-50/50 px-2 py-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-700">Hẹn lấy mẫu lúc</span>
            <button
              type="button"
              onClick={closeSchedule}
              className="rounded px-1 text-xs font-medium text-slate-500 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
            >
              Hủy
            </button>
          </div>
          <DayTimePicker
            dayOffset={dayOffset}
            timeLabel={timeLabel}
            timeIsPast={timeIsPast}
            onDay={pickDay}
            onTime={setTimeLabel}
            warnId={`failed-time-warn-${job.job_id}`}
          />
          {timeIsPast && (
            <p id={`failed-time-warn-${job.job_id}`} role="alert" className="text-[11px] font-medium text-red-600">
              Giờ đã qua — chọn sau {vnNowLabel()} hoặc đổi sang ngày mai.
            </p>
          )}
          <div className="flex justify-end">
            <Button
              size="sm"
              className="bg-indigo-600 text-xs hover:bg-indigo-700"
              disabled={!scheduleReady}
              onClick={() => {
                if (!timeLabel || !scheduleReady) return;
                closeSchedule();
                onSchedule(job, scheduledAtFor(dayOffset, timeLabel), `${DAY_LABELS[dayOffset]} ${timeLabel}`);
              }}
            >
              {timeLabel ? `Lên lịch ${DAY_LABELS[dayOffset]} ${timeLabel}` : "Chọn giờ để lên lịch"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The dashboard's attention hub: jobs the engine couldn't auto-assign, plus late
 * pickups ("Lấy mẫu chậm") and fixed-schedule (Lịch cố định) run errors — all the
 * things a supervisor needs to act on, in one place.
 */
export function FailedJobsPanel({
  held,
  env,
  onNoteRefresh,
  onNoteAssigned,
  onNoteManualAssign,
  failed,
  unfinished,
  gaps,
  parsedAt,
  onUnfinishedSaved,
  warnings,
  scheduleErrors,
  drivers,
  onAssign,
  onScheduleFailed,
  onRetrySchedule,
  retryingSchedule,
  leaveToday,
  leaveTomorrow,
  onLeaveRefresh,
}: {
  held: HeldJob[];
  env: "prod" | "uat";
  onNoteRefresh: () => void;
  onNoteAssigned: (jobId: number) => void;
  onNoteManualAssign: (job: HeldJob, driverId: string) => void;
  failed: FailedJob[];
  /** Config lines naming a branch but no driver — waiting on a person. */
  unfinished: UnfinishedConfigRow[];
  /** Hours a job needed and no rule covered. */
  gaps: CoverageGap[];
  /** When the sheet behind both lists was last read. */
  parsedAt: string;
  /** Called after a row is completed. The key identifies what was finished so
   *  it can be hidden at once rather than waiting for the next cycle. */
  onUnfinishedSaved: (key?: string) => void;
  warnings: PickupWarning[];
  scheduleErrors: ScheduleErrorRow[];
  drivers: ConfigDriver[];
  onAssign: (job: FailedJob, driverId: string) => void;
  onScheduleFailed: (job: FailedJob, scheduledAt: string, label: string) => void;
  onRetrySchedule: () => void;
  retryingSchedule: boolean;
  leaveToday: LeaveOnDate[];
  leaveTomorrow: LeaveOnDate[];
  onLeaveRefresh: () => void;
}) {
  // Today's uncovered leave counts toward the tab's total: it is a section of
  // this list now, so an otherwise-clear day with an unfilled substitute must
  // not render the "nothing to do" state.
  const uncoveredLeave = uncoveredLeaveCount(leaveToday, leaveTomorrow);
  const total = held.length + failed.length + warnings.length + scheduleErrors.length + uncoveredLeave;

  // Group assign failures by reason in display-priority order.
  const byReason = new Map<FailedReason, FailedJob[]>();
  for (const job of failed) {
    const list = byReason.get(job.reason);
    if (list) list.push(job);
    else byReason.set(job.reason, [job]);
  }
  const groups = Array.from(byReason.entries())
    .sort((a, b) => metaFor(a[0]).order - metaFor(b[0]).order)
    .map(([reason, jobs]) => [reason, jobs.sort((a, b) => a.job_id - b.job_id)] as const);

  // Now the landing tab, so an empty list shows a friendly all-clear state
  // instead of vanishing.
  if (total === 0) {
    // A suggestion is not something that needs handling, so it must not keep the
    // all-clear card off the screen — but it still has to be reachable on the day
    // nothing else is wrong, which is most days.
    return (
      <div className="flex h-full flex-col gap-2">
      <NoteSuggestionPanel />
      <Card className="flex flex-1 flex-col items-center justify-center gap-1.5 py-8">
        <CheckCircle2 className="size-8 text-emerald-500" strokeWidth={1.75} />
        <p className="text-sm font-medium text-slate-600">Không có mục nào cần xử lý</p>
        <p className="text-xs text-slate-400">
          Job không gán được, chờ duyệt ghi chú, nghỉ chưa có người thay và lấy mẫu chậm sẽ hiện ở đây
        </p>
      </Card>
      </div>
    );
  }

  // Each section is a divided list (one bordered container, hairline rows) —
  // the tone-coloured header carries severity, so rows stay quiet.
  const listBox = "divide-y divide-slate-100 overflow-hidden rounded-md border border-slate-200";
  // Shut by default. This list is long-lived — 32 branches today, each waiting on
  // a person rather than on the engine — so leaving it open pushes the things
  // that ARE urgent off the screen. The count stays in the header, which is the
  // part that needs to be seen without opening anything.
  const [configOpen, setConfigOpen] = useState(false);

  return (
    <Card className="flex h-full flex-col gap-2 py-2 border-slate-200">
      {/* No card header: the "Cần xử lý" tab already names this panel and shows the
          count, and each section below carries its own labelled header. */}
      <CardContent className="px-3 flex-1 min-h-0">
        {/* Full-height scroll. Order: notes → other unassignable → late pickups. */}
        <div className="h-full max-w-5xl overflow-y-auto space-y-3 text-xs pr-1">
            {/* ── Sentences the engine is offering for the safe list ───────── */}
            <NoteSuggestionPanel refreshKey={held.length} />

            {/* ── Tasks with note (part of "unassignable") ─────────────────── */}
            {held.length > 0 && (
              <NoteReviewPanel
                held={held}
                env={env}
                onRefresh={onNoteRefresh}
                onAssigned={onNoteAssigned}
                drivers={drivers}
                onManualAssign={onNoteManualAssign}
                embedded
              />
            )}

            {/* ── Leave with nobody covering it, today then tomorrow ──────── */}
            <UncoveredLeaveSection
              entries={leaveToday}
              label="Nghỉ chưa có người thay"
              drivers={drivers}
              onRefresh={onLeaveRefresh}
            />
            <UncoveredLeaveSection
              entries={leaveTomorrow}
              label="Nghỉ ngày mai chưa có người thay"
              drivers={drivers}
              onRefresh={onLeaveRefresh}
            />

            {/* ── Other unassignable: assign failures ─────────────────────── */}
            {groups.map(([reason, jobs]) => (
              <div key={reason} className="space-y-1.5">
                <SectionHeader label={metaFor(reason).label} count={jobs.length} tone={metaFor(reason).tone} />
                <div className={listBox}>
                  {jobs.map((job) => (
                    <FailedRow
                      key={job.job_id}
                      job={job}
                      drivers={drivers}
                      onAssign={onAssign}
                      onSchedule={onScheduleFailed}
                    />
                  ))}
                </div>
              </div>
            ))}

            {/* ── Everything the config is waiting on a person for ────────
                One section, two shapes of the same problem: an hour nobody is
                rostered for, and a branch with a line but no driver. Shut by
                default and headed like the leave panel, because these are
                long-lived — each waits on a person, not on the engine — and left
                open they push the genuinely urgent things off the screen. */}
            {(gaps.length > 0 || unfinished.length > 0) && (
              <div className="space-y-1.5 pt-1">
                <datalist id={CONFIG_NAMES_LIST_ID}>
                  {drivers.map((d) => <option key={d.driver_id} value={d.name} />)}
                </datalist>
                <button
                  type="button"
                  onClick={() => setConfigOpen((v) => !v)}
                  className="flex w-full items-center gap-2 text-left"
                  aria-expanded={configOpen}
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
                  {/* When the sheet was last READ, not when the cycle ran. The
                      parse is event-based, so a hand-edit stays invisible until
                      someone presses Refresh — without this, a row already fixed
                      in the sheet reads as a bug rather than as a stale list. */}
                  {parsedAt && (
                    <span className="text-[11px] text-slate-400">
                      đọc sheet {parsedAt.slice(11, 16)} · vừa sửa sheet thì bấm Làm mới
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-xs text-slate-400">{configOpen ? "▾" : "▸"}</span>
                </button>

                {configOpen && gaps.length > 0 && (
                  <div className={listBox}>
                    {gaps.map((g) => (
                      <GapRow key={`${g.customer_id}-${g.at}`} g={g} drivers={drivers} onSaved={onUnfinishedSaved} />
                    ))}
                  </div>
                )}
                {configOpen && unfinished.length > 0 && (
                  <div className={listBox}>
                    {unfinished.map((u) => (
                      <UnfinishedRow key={u.row} u={u} drivers={drivers} onSaved={onUnfinishedSaved} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Other unassignable: fixed-schedule run errors ───────────── */}
            {scheduleErrors.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 pt-1">
                  <SectionHeader label="Lịch cố định lỗi" count={scheduleErrors.length} tone="red" />
                  <Button
                    size="sm"
                    className="h-6 text-[11px] px-2 bg-red-600 hover:bg-red-700"
                    disabled={retryingSchedule}
                    onClick={onRetrySchedule}
                  >
                    {retryingSchedule ? "Đang chạy…" : "Chạy lại lỗi"}
                  </Button>
                </div>
                <div className={listBox}>
                  {scheduleErrors.map((e, i) => (
                    <div
                      key={`${e.reference_number}-${i}`}
                      className="px-2 py-1.5 hover:bg-slate-50"
                    >
                      <div className="text-sm font-semibold text-slate-800 break-words md:truncate" title={`${labelFor(e.pickup_name, e.pickup_id)} → ${labelFor(e.dropoff_name, e.dropoff_id)}`}>
                        {labelFor(e.pickup_name, e.pickup_id)} <span className="text-slate-400">→</span> {labelFor(e.dropoff_name, e.dropoff_id)}
                        {e.delivery_window && (
                          <span className="ml-1.5 font-mono text-[11px] text-indigo-600">{e.delivery_window}</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-red-700 break-words md:truncate" title={e.message}>{e.message}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Late pickups ("Lấy mẫu chậm") — last ─────────────────────── */}
            {warnings.length > 0 && (
              <div className="space-y-1.5">
                <SectionHeader label="Lấy mẫu chậm" count={warnings.length} tone="amber" />
                <div className={listBox}>
                  {warnings.map((w) => {
                    const ref = refTime(w);
                    return (
                    <div
                      key={w.job_id}
                      className="px-2 py-1.5 hover:bg-slate-50"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <a
                          href={`https://fleetweb-vn.cartrack.com/delivery/map?job=${w.job_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 font-mono font-semibold text-indigo-600 underline hover:text-indigo-800"
                        >
                          Job {w.job_id}
                        </a>
                        <span
                          className="min-w-0 flex-1 break-words md:truncate text-sm font-medium text-slate-800"
                          title={`${w.pickup_customer_name ?? "—"} → ${w.dropoff_customer_name ?? "—"}`}
                        >
                          {w.pickup_customer_name ?? "—"} <span className="text-slate-400">→</span> {w.dropoff_customer_name ?? "—"}
                        </span>
                        {/* Anchor time + delay read as one unit: "since HH:MM, +N' late". */}
                        {ref && (
                          <span
                            className="shrink-0 flex items-center gap-1 text-xs font-semibold tabular-nums text-slate-700 whitespace-nowrap"
                            title={ref.full}
                          >
                            <Clock className="w-3.5 h-3.5 text-slate-400" aria-hidden />
                            {ref.time}
                          </span>
                        )}
                        <span className="shrink-0 font-bold text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-0.5 leading-none whitespace-nowrap">
                          {fmtLate(w.minutes_late ?? 0)}
                        </span>
                      </div>
                      {w.driver_name && (
                        <p className="mt-0.5 text-[11px] text-slate-500 break-words md:truncate" title={w.driver_name}>{w.driver_name}</p>
                      )}
                    </div>
                    );
                  })}
                </div>
              </div>
            )}
        </div>
      </CardContent>
    </Card>
  );
}
