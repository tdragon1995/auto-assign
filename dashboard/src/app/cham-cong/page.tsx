"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import { Calendar, Clock, ClipboardCheck, FileText, NotepadText, CalendarDays, Search, Truck, MapPin, ArrowLeftRight, CheckCircle2, LogOut, RefreshCw, AlertCircle, LogIn, Loader2, Gauge, ChevronRight } from "lucide-react";
import { DIAG_LOCATIONS } from "@/lib/diag-locations";

interface Driver {
  driver_id: string;
  driver_name: string;
}

interface Location {
  customer_id: string;
  name: string;
  address: string;
}

interface DriverJob {
  job_id: number;
  reference_number: string | null;
  pickup_name: string | null;
  dropoff_name: string | null;
  pickup_status_id: number | null;
  pickup_status_label: string | null;
  current_driver_id: string | null;
  current_driver_name: string | null;
  is_mine: boolean;
}

interface NvSession {
  // Display only. The authoritative driver_id lives in the HttpOnly session
  // cookie set by /api/driver-auth; the client never sees or sends it.
  driver_name: string;
}

interface OngoingChamCong {
  job_id: number;
  type: ActionType;
  customer_id: string | null;
  location_name: string | null;
}

type ChamCongState = "done" | "started" | "pending";

interface ChamCongTask {
  job_id: number;
  type: ActionType;
  customer_id: string | null;
  location_name: string | null;
  time: string | null;
  state: ChamCongState;
  switchable: boolean;
}

interface ShiftState {
  checkInCount: number;
  completedCheckOuts: number;
  activeCheckOuts: number;
  pendingJobs: number;
  pendingJobNames: string[];
  ongoing: OngoingChamCong | null;
  tasks: ChamCongTask[];
  fetchedAt: number;
}

type ActionType = "check-in" | "check-out";
type Status = "idle" | "loading" | "success" | "error";
type Tab = "cham-cong" | "nghi-phep" | "lich-cn" | "nhan-viec" | "hieu-suat";
type LeaveType = "" | "nguyen_buoi" | "nua_buoi" | "nghi_viec";

// ── Hiệu Suất (driver TAT report) ───────────────────────────────────────────
// Mirrors the /api/tat/me response. Every number arrives pre-computed and every
// clock pre-formatted to VN time: this screen is read by drivers on a phone and
// must not be re-deriving timezones or averages of its own.
//
// The unit is a LEG ("chặng") — the ride between two consecutive stops — not a
// job. See src/lib/tat.ts for why.

// "prev_month" exists because payroll runs on the 25th against the PREVIOUS
// month. Without it the report shows the wrong month during the one week it is
// most consulted.
type TatSpan = "today" | "week" | "month" | "prev_month";

interface TatSummary {
  trips_total: number;
  trips_measured: number;
  trips_graded: number;
  trips_on_time: number;
  long_gaps: number;
  on_time_pct: number | null;
  avg_tat_mins: number | null;
  total_tat_mins: number;
  total_km: number;
}

interface TatLegCardData {
  seq: number;
  from: string | null;
  to: string | null;
  left_at: string | null;
  arrived_at: string | null;
  distance_km: number | null;
  tat_mins: number | null;
  target_mins: number | null;
  /** Goong's travel-time estimate — an input to the benchmark, not the verdict. */
  eta_mins: number | null;
  /** What this leg was graded against: the higher of the flat rule and Goong. */
  benchmark_mins: number | null;
  long_gap: boolean;
  on_time: boolean | null;
  estimated: boolean;
}

interface TatDay {
  date: string;
  legs: number;
  avg_tat_mins: number | null;
  on_time_pct: number | null;
}

interface TatReport {
  ok: boolean;
  driver_name: string;
  mins_per_km: number;
  updated_at: string | null;
  refreshing: boolean;
  degraded?: string;
  today: { date: string; summary: TatSummary; legs: TatLegCardData[] };
  week: { from: string; to: string; summary: TatSummary; days: TatDay[] };
  prev_week: { from: string; to: string; summary: TatSummary };
  month: { from: string; to: string; summary: TatSummary; days: TatDay[] };
  prev_month: { from: string; to: string; summary: TatSummary; days: TatDay[] };
}

/** One past day, fetched on demand when a driver taps a day or picks a date. */
interface TatDayDetail {
  date: string;
  summary: TatSummary;
  legs: TatLegCardData[];
  refreshing?: boolean;
}

interface ScheduleEntry {
  stt: string;
  name: string;
  addr: string;
  ca: string;
  note: string;
  phone: string;
}

interface ScheduleData {
  morning: ScheduleEntry[];
  afternoon: ScheduleEntry[];
  dateLabel: string;
}

function ShiftSection({ title, accent, rows }: { title: string; accent: "amber" | "blue"; rows: ScheduleEntry[] }) {
  if (rows.length === 0) return null;
  const head = accent === "amber" ? "bg-amber-500" : "bg-blue-600";
  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      <div className={`${head} text-white text-sm font-bold px-4 py-2.5 flex items-center justify-between`}>
        <span>{title}</span>
        <span className="text-xs font-semibold opacity-90">{rows.length}</span>
      </div>
      <ul className="divide-y divide-gray-100">
        {rows.map((r, i) => (
          <li key={`${r.stt}-${i}`} className="px-4 py-2.5 flex gap-2">
            <span className="text-xs text-gray-400 w-5 shrink-0 pt-0.5">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-gray-800">
                {r.name || <span className="text-red-600">— Chưa có người —</span>}
              </p>
              {r.addr && <p className="text-sm text-gray-600">{r.addr}</p>}
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {r.ca && (
                  <span className="inline-block text-xs font-medium text-gray-700 bg-gray-100 rounded px-1.5 py-0.5">
                    {r.ca}
                  </span>
                )}
                {r.note && (
                  <span className="inline-block text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                    {r.note}
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const LS_DRIVER_ID   = "cc_driver_id";
const LS_DRIVER_NAME = "cc_driver_name";
const SHIFT_STATE_TTL_MS = 2 * 60 * 1000;
const SS_DRIVERS_KEY = "cc_drivers_cache";
const LS_NV_PHONE   = "cc_nv_phone";   // Nhận Việc: remembered phone (never the PIN)
const LS_NV_SESSION = "cc_nv_session"; // Nhận Việc: authenticated {driver_id, driver_name}

// Chấm-công task state → badge label + classes. "done" = finished in Cartrack,
// "started" = opened/en-route (locked, real record), "pending" = created but untouched.
const CC_STATE_BADGE: Record<ChamCongState, { label: string; cls: string }> = {
  done:    { label: "Hoàn thành",      cls: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  started: { label: "Đang thực hiện",  cls: "text-blue-700 bg-blue-50 border-blue-200" },
  pending: { label: "Chưa hoàn thành", cls: "text-amber-800 bg-amber-50 border-amber-200" },
};

// Nhận Việc: badge colour by Cartrack pickup stop_status_id (1 Chờ lấy, 2 Đang đến, 3 Đã đến).
function nvStatusClasses(id: number | null): string {
  switch (id) {
    case 2: return "bg-blue-100 text-blue-700";
    case 3: return "bg-indigo-100 text-indigo-700";
    default: return "bg-slate-100 text-slate-600";
  }
}

function NvJobCard({ job, claiming, onClaim }: { job: DriverJob; claiming: boolean; onClaim: () => void }) {
  return (
    <div className="rounded-xl border border-gray-200 p-3.5 space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <MapPin size={15} className="text-blue-600 shrink-0" />
          <div className="text-sm font-medium text-gray-800 min-w-0 truncate">
            {job.pickup_name ?? "—"}<span className="text-gray-400"> → </span>{job.dropoff_name ?? "—"}
          </div>
        </div>
        <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${nvStatusClasses(job.pickup_status_id)}`}>
          {job.pickup_status_label ?? "—"}
        </span>
      </div>
      {job.reference_number && <p className="text-xs text-gray-400">Mã: {job.reference_number}</p>}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-gray-500">
          {job.is_mine
            ? "Đang thuộc về bạn"
            : job.current_driver_name
              ? `Đang giao: ${job.current_driver_name}`
              : "Chưa phân công"}
        </p>
        {job.is_mine ? (
          <span className="flex items-center gap-1 text-xs font-medium text-green-600">
            <CheckCircle2 size={15} /> Của bạn
          </span>
        ) : (
          <button
            onClick={onClaim}
            disabled={claiming}
            className="flex items-center gap-1.5 bg-blue-600 text-white rounded-lg px-3 py-1.5 text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 transition-colors"
          >
            {claiming ? <Loader2 size={15} className="animate-spin" /> : <Truck size={15} />}
            Nhận việc
          </button>
        )}
      </div>
    </div>
  );
}

// ── Hiệu Suất presentation ──────────────────────────────────────────────────
//
// The audience is a driver on a phone who does not read dashboards. Three rules
// shape everything below:
//   1. One number leads. Everything else is support, at half the size.
//   2. No jargon on screen — no "TAT", no percentages without the fraction they
//      came from ("8/10 chuyến" beside "80%"), no bare minute counts without
//      what they were measured against.
//   3. Amber, never red. This screen is read by the person being measured; a
//      slow trip is information, not an accusation.

/** "95 phút" → "1 giờ 35 phút". Minutes alone stop being legible somewhere past
 *  an hour, and a driver's daily total is always past it. */
function fmtMins(mins: number | null | undefined): string {
  if (mins == null || !Number.isFinite(mins)) return "—";
  if (mins < 60) return `${mins} phút`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} giờ` : `${h} giờ ${m} phút`;
}

function TatStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 px-3 py-2.5 text-center">
      <p className="text-lg font-bold text-gray-800 leading-tight">{value}</p>
      <p className="text-[11px] text-gray-500 mt-0.5">{label}</p>
      {sub && <p className="text-[11px] text-gray-400">{sub}</p>}
    </div>
  );
}

/** The headline block. On-time share is shown as a bar rather than a ring: a bar
 *  reads correctly at a glance on a small screen and, unlike a ring, still makes
 *  sense when there is nothing to grade yet. */
function TatHeadline({ summary, title }: { summary: TatSummary; title: string }) {
  const pct = summary.on_time_pct;
  const graded = summary.trips_graded > 0;
  const tone = pct == null ? "bg-gray-300" : pct >= 80 ? "bg-green-500" : pct >= 50 ? "bg-amber-500" : "bg-amber-600";

  return (
    <div className="rounded-2xl border border-gray-200 overflow-hidden">
      <div className="px-4 pt-4 pb-3">
        <p className="text-xs text-gray-500">{title}</p>
        <p className="text-3xl font-bold text-gray-900 leading-tight mt-0.5">
          {summary.trips_total}
          <span className="text-base font-semibold text-gray-500 ml-1.5">chặng đường</span>
        </p>
      </div>

      {graded ? (
        <div className="px-4 pb-4 space-y-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-gray-500">Đúng giờ</span>
            <span className="text-sm font-bold text-gray-800">
              {summary.trips_on_time}/{summary.trips_graded}
              <span className="text-gray-400 font-medium ml-1.5">{pct}%</span>
            </span>
          </div>
          <div className="h-2.5 rounded-full bg-gray-100 overflow-hidden">
            <div className={`h-full rounded-full ${tone} transition-all`} style={{ width: `${pct ?? 0}%` }} />
          </div>
          {summary.long_gaps > 0 && (
            <p className="text-[11px] text-gray-400 pt-0.5">
              {summary.long_gaps} chặng có thời gian chờ/nghỉ dài — không tính vào tỉ lệ đúng giờ.
            </p>
          )}
        </div>
      ) : (
        <div className="px-4 pb-4">
          <p className="text-xs text-gray-400">Chưa có chặng nào tính được thời gian.</p>
        </div>
      )}
    </div>
  );
}

/** One leg. The comparison is spelled out in full — "34 phút / mục tiêu 32 phút"
 *  — because a lone number tells a driver nothing about whether it was good, and
 *  that is the entire question they opened this screen to answer. */
function TatLegRow({ leg }: { leg: TatLegCardData }) {
  const late = leg.on_time === false;
  const good = leg.on_time === true;
  const chip = good
    ? "bg-green-100 text-green-700"
    : late
      ? "bg-amber-100 text-amber-800"
      : "bg-slate-100 text-slate-500";
  const bench = leg.benchmark_mins ?? leg.target_mins;
  const over = late && leg.tat_mins != null && bench != null ? leg.tat_mins - bench : null;
  const chipText = good ? "Đúng giờ" : late ? `Trễ ${over} phút` : leg.long_gap ? "Chờ / nghỉ" : "—";

  return (
    <div className="rounded-xl border border-gray-200 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-1.5 min-w-0">
          <MapPin size={14} className="text-blue-600 shrink-0 mt-0.5" />
          <p className="text-sm font-medium text-gray-800 min-w-0">
            {leg.from ?? "—"}
            <span className="text-gray-400"> → </span>
            {leg.to ?? "—"}
          </p>
        </div>
        <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full ${chip}`}>{chipText}</span>
      </div>

      <div className="flex items-center gap-x-3 gap-y-1 text-xs text-gray-500 flex-wrap">
        {leg.left_at && leg.arrived_at && (
          <span className="inline-flex items-center gap-1">
            <Clock size={12} className="text-gray-400" />
            {leg.left_at} → {leg.arrived_at}
          </span>
        )}
        {leg.distance_km != null && <span>{leg.distance_km} km</span>}
        {leg.tat_mins != null && (
          <span className="font-semibold text-gray-700">
            {leg.estimated && <span className="text-gray-400 font-normal">≈ </span>}
            {fmtMins(leg.tat_mins)}
          </span>
        )}
        {leg.tat_mins == null && <span className="text-gray-400">Chưa đủ dữ liệu</span>}
      </div>

      {/* The two references, side by side. "Mục tiêu" is the flat rule the driver
          is actually graded on and can check in their head; "Goong" is what a
          routing service thinks this particular road takes. Showing both is what
          separates a slow driver from a slow route — the flat rule alone cannot
          tell those apart, and that ambiguity is where a late leg turns into an
          argument. Goong is deliberately styled as a note, not a verdict. */}
      {bench != null && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-baseline gap-1 text-[11px] rounded-md bg-gray-100 px-2 py-1">
            <span className="text-gray-500">Mục tiêu</span>
            <span className="font-semibold text-gray-700">{bench} phút</span>
          </span>
          {/* The two inputs behind that number, so the benchmark is never a figure
              the driver has to take on trust. Shown only when they differ — when
              they agree, repeating it twice is noise. */}
          {leg.target_mins != null && leg.eta_mins != null && leg.target_mins !== leg.eta_mins && (
            <span className="text-[11px] text-gray-400">
              (4 × km: {leg.target_mins} · Goong: {leg.eta_mins} — lấy số cao hơn)
            </span>
          )}
        </div>
      )}

      {leg.long_gap && (
        <p className="text-[11px] text-gray-400">
          Chặng này lâu hơn mục tiêu rất nhiều — thường là giờ nghỉ hoặc chờ tại điểm, nên không tính đúng/trễ.
        </p>
      )}
      {leg.estimated && !leg.long_gap && (
        <p className="text-[11px] text-gray-400">
          ≈ Chưa bấm &quot;đã đến&quot;, nên tính theo giờ hoàn thành (có thể lâu hơn thực tế).
        </p>
      )}
    </div>
  );
}

/** One day in a day list. Tappable: a day summary that cannot be opened answers
 *  "Tuesday was 60%" without ever answering "why", which is the only question a
 *  driver actually has after a bad day. */
function TatDayRow({
  day, open, loading, detail, onToggle,
}: {
  day: TatDay; open: boolean; loading: boolean; detail: TatDayDetail | null; onToggle: () => void;
}) {
  const pct = day.on_time_pct;
  const tone = pct == null ? "text-gray-400" : pct >= 80 ? "text-green-600" : "text-amber-600";
  return (
    <li>
      <button
        onClick={onToggle}
        className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors ${
          open ? "bg-blue-50/50" : "hover:bg-gray-50"
        }`}
      >
        <div className="min-w-0 flex items-center gap-1.5">
          <ChevronRight
            size={14}
            className={`text-gray-400 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-800">{vnWeekday(day.date)}</p>
            <p className="text-[11px] text-gray-400">{fmtDate(day.date)}</p>
          </div>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <div className="text-right">
            <p className="text-sm font-semibold text-gray-700">{day.legs}</p>
            <p className="text-[11px] text-gray-400">chặng</p>
          </div>
          <div className="text-right w-14">
            <p className="text-sm font-semibold text-gray-700">{day.avg_tat_mins ?? "—"}</p>
            <p className="text-[11px] text-gray-400">phút TB</p>
          </div>
          <div className="text-right w-14">
            <p className={`text-sm font-semibold ${tone}`}>{pct == null ? "—" : `${pct}%`}</p>
            <p className="text-[11px] text-gray-400">đúng giờ</p>
          </div>
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2 bg-blue-50/30">
          {loading ? (
            <div className="flex justify-center py-4 text-gray-400"><Loader2 size={18} className="animate-spin" /></div>
          ) : !detail || detail.legs.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-3">
              {detail?.refreshing ? "Đang tải dữ liệu ngày này, thử lại sau giây lát..." : "Không có chặng nào."}
            </p>
          ) : (
            detail.legs.map((leg) => <TatLegRow key={leg.seq} leg={leg} />)
          )}
        </div>
      )}
    </li>
  );
}

/** A day list with drill-down, shared by the week and month spans. */
function TatDayList({
  days, openDay, dayLoading, dayDetail, onToggle,
}: {
  days: TatDay[]; openDay: string | null; dayLoading: boolean;
  dayDetail: TatDayDetail | null; onToggle: (date: string) => void;
}) {
  if (days.length === 0) return <p className="text-center text-sm text-gray-400 py-8">Chưa có số liệu.</p>;
  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      <ul className="divide-y divide-gray-100">
        {days.map((d) => (
          <TatDayRow
            key={d.date}
            day={d}
            open={openDay === d.date}
            loading={openDay === d.date && dayLoading}
            detail={openDay === d.date ? dayDetail : null}
            onToggle={() => onToggle(d.date)}
          />
        ))}
      </ul>
    </div>
  );
}

/** Week-on-week, written as a sentence rather than an arrow and a delta. "Nhanh
 *  hơn tuần trước 3 phút mỗi chuyến" needs no explanation; "▼ 3" does. */
function TatTrend({ current, previous }: { current: TatSummary; previous: TatSummary }) {
  if (current.avg_tat_mins == null || previous.avg_tat_mins == null) return null;
  const diff = current.avg_tat_mins - previous.avg_tat_mins;
  if (diff === 0) {
    return <p className="text-xs text-gray-500 text-center">Tốc độ trung bình bằng tuần trước.</p>;
  }
  const faster = diff < 0;
  return (
    <p className={`text-xs text-center font-medium ${faster ? "text-green-600" : "text-amber-600"}`}>
      {faster ? "Nhanh hơn" : "Chậm hơn"} tuần trước {Math.abs(diff)} phút mỗi chặng.
    </p>
  );
}

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

async function fetchDriversCached(): Promise<unknown> {
  if (typeof window !== "undefined") {
    try {
      const raw = sessionStorage.getItem(SS_DRIVERS_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
  }
  const data = await fetch("/api/drivers").then((r) => r.json());
  try {
    sessionStorage.setItem(SS_DRIVERS_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
  return data;
}

function todayVnStr(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()).slice(0, 10);
}

function vnWeekday(dateStr: string): string {
  if (!dateStr) return "";
  const [y, mo, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, mo - 1, d);
  const days = ["Chủ Nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];
  return days[dt.getDay()];
}

function fmtDate(dateStr: string): string {
  if (!dateStr) return "";
  const [y, mo, d] = dateStr.split("-").map(Number);
  return `Ngày ${d} tháng ${mo}, ${y}`;
}

function DateField({ value, min, onChange }: { value: string; min: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);

  function open() {
    try { ref.current?.showPicker(); } catch { ref.current?.focus(); }
  }

  return (
    <div className="relative cursor-pointer" onClick={open}>
      <Calendar size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none z-10" />
      <div className="w-full border border-gray-300 rounded-lg pl-9 pr-10 py-2 text-sm min-h-[38px] select-none">
        {value
          ? <span className="text-gray-900">{fmtDate(value)}</span>
          : <span className="text-gray-400">Chọn ngày</span>
        }
      </div>
      {/* Visible calendar toggle icon on the right (desktop hint) */}
      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none text-xs">▼</span>
      <input
        ref={ref}
        type="date"
        min={min}
        value={value}
        onChange={(e) => { if (!e.target.value || e.target.value >= min) onChange(e.target.value); }}
        className="opacity-0 absolute inset-0 w-full h-full cursor-pointer"
        tabIndex={-1}
      />
    </div>
  );
}

export default function ChamCongPage() {
  // ── Shared ────────────────────────────────────────────────────────────────
  const [tab, setTab] = useState<Tab>("cham-cong");
  const [drivers, setDrivers] = useState<Driver[]>([]);
  // Seeded from the compiled-in constant rather than fetched. GET /api/cham-cong with no
  // driver_id did nothing but JSON-serialise DIAG_LOCATIONS — a serverless invocation, on
  // every page open, to hand back a list that already ships in the bundle. The API branch
  // stays for any other caller; this screen just stops asking.
  const [locations] = useState<Location[]>(DIAG_LOCATIONS);
  const [initialLoading, setInitialLoading] = useState(true);

  const [driverId,       setDriverId]      = useState(() => typeof window !== "undefined" ? localStorage.getItem(LS_DRIVER_ID)   ?? "" : "");
  const [driverName,     setDriverName]    = useState(() => typeof window !== "undefined" ? localStorage.getItem(LS_DRIVER_NAME) ?? "" : "");
  const [driverSearch,   setDriverSearch]  = useState(() => typeof window !== "undefined" ? localStorage.getItem(LS_DRIVER_NAME) ?? "" : "");
  const [showDriverList, setShowDriverList] = useState(false);

  // ── Chấm Công tab ─────────────────────────────────────────────────────────
  const [locationId,       setLocationId]      = useState("");
  const [locationName,     setLocationName]    = useState("");
  const [locationSearch,   setLocationSearch]  = useState("");
  const [showLocationList, setShowLocationList] = useState(false);
  const [ccStatus,   setCcStatus]  = useState<Status>("idle");
  const [ccMessage,  setCcMessage] = useState("");
  const [pendingNames, setPendingNames] = useState<string[]>([]);
  const shiftStateRef  = useRef<ShiftState | null>(null);
  const [shiftFetching, setShiftFetching] = useState(false);
  // Today's chấm-công tasks, mirrored out of shiftStateRef so the list re-renders on it.
  const [tasks,          setTasks]          = useState<ChamCongTask[]>([]);
  const [switching,      setSwitching]      = useState(false);
  // Which task's change-location picker is open (job_id), and its search text. The picker
  // carries its own location box — it must not reuse the "Địa điểm" field above, which
  // still holds the location just checked into and would start the control dead.
  const [switchingJobId, setSwitchingJobId] = useState<number | null>(null);
  const [switchSearch,   setSwitchSearch]   = useState("");

  // ── Nộp Đơn Nghỉ tab ──────────────────────────────────────────────────────
  const [leaveType,         setLeaveType]         = useState<LeaveType>("");
  const [leaveFromDate,     setLeaveFromDate]     = useState("");
  const [leaveToDate,       setLeaveToDate]       = useState("");
  const [leaveDate,         setLeaveDate]         = useState("");
  const [leaveStartTime,    setLeaveStartTime]    = useState("");
  const [leaveEndTime,      setLeaveEndTime]      = useState("");
  const [leaveStatus,       setLeaveStatus]       = useState<Status>("idle");
  const [leaveError,        setLeaveError]        = useState("");
  const [leaveSummary,      setLeaveSummary]      = useState("");

  // ── Lịch CN tab ───────────────────────────────────────────────────────────
  const [schedule,       setSchedule]       = useState<ScheduleData | null>(null);
  const [scheduleStatus, setScheduleStatus] = useState<Status>("idle");
  const [scheduleSearch, setScheduleSearch] = useState("");

  // ── Nhận Việc tab ─────────────────────────────────────────────────────────
  const [nvPhone,     setNvPhone]     = useState(() => typeof window !== "undefined" ? localStorage.getItem(LS_NV_PHONE) ?? "" : "");
  const [nvPin,       setNvPin]       = useState("");
  const [nvSession,   setNvSession]   = useState<NvSession | null>(() => {
    if (typeof window === "undefined") return null;
    try { const raw = localStorage.getItem(LS_NV_SESSION); return raw ? JSON.parse(raw) : null; } catch { return null; }
  });
  const [nvLoginBusy,  setNvLoginBusy]  = useState(false);
  const [nvLoginError, setNvLoginError] = useState<string | null>(null);
  const [nvJobs,       setNvJobs]       = useState<DriverJob[]>([]);
  const [nvJobsLoading, setNvJobsLoading] = useState(false);
  const [nvJobsError,  setNvJobsError]  = useState<string | null>(null);
  const [nvRecognized, setNvRecognized] = useState(true);
  const [nvClaiming,   setNvClaiming]   = useState<number | null>(null);
  const [nvToast,      setNvToast]      = useState<string | null>(null);

  // ── Hiệu Suất tab ─────────────────────────────────────────────────────────
  // Shares the Nhận Việc session: both read data scoped to one authenticated
  // driver, so logging in once covers both.
  const [tatSpan,    setTatSpan]    = useState<TatSpan>("today");
  const [tatReport,  setTatReport]  = useState<TatReport | null>(null);
  const [tatLoading, setTatLoading] = useState(false);
  const [tatError,   setTatError]   = useState<string | null>(null);
  // Drill-down: which past day is expanded, and its legs once fetched.
  const [tatOpenDay,   setTatOpenDay]   = useState<string | null>(null);
  const [tatDayDetail, setTatDayDetail] = useState<TatDayDetail | null>(null);
  const [tatDayLoading, setTatDayLoading] = useState(false);

  // ── Init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const savedId = typeof window !== "undefined" ? localStorage.getItem(LS_DRIVER_ID) : null;

    // The Sunday roster is NOT fetched here — it lives behind the Lịch CN tab and loads
    // when that tab is opened. It used to ride along on every clock-in, so every driver
    // downloaded a rota most of them never look at, on a page they open to press one
    // button. The route's cache is per serverless instance, so a share of those went out
    // to Google Sheets for real.
    fetchDriversCached().then((driversData) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sorted = ((driversData as any).data ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((d: any) => d.is_active !== false)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((d: any): Driver => ({
          driver_id: d.delivery_driver_id,
          driver_name: `${d.first_name ?? ""} ${d.last_name ?? ""}`.trim(),
        }))
        .filter((d: Driver) => d.driver_id && d.driver_name && d.driver_name.startsWith("P - "))
        .sort((a: Driver, b: Driver) => a.driver_name.localeCompare(b.driver_name, "vi"));
      setDrivers(sorted);
    }).finally(() => setInitialLoading(false));

    if (savedId) fetchShiftState(savedId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Nhận Việc: logged in = a stored authenticated session. Identity comes from the
  // phone+PIN login itself (bridged to the fleet driver_id) — no name-picker gate.
  const nvLoggedIn = !!nvSession;
  const nvDisplayName = nvSession ? nvSession.driver_name.replace(/^.*?(?:PT|DC)\d+\s+/i, "").trim() : "";

  // Sunday roster: load when its tab is first opened, mirroring nhan-viec below. Once per
  // page life is enough — ops edits the sheet weekly, not while a driver is looking at it,
  // and the route holds a day-keyed cache behind this anyway.
  const scheduleLoadedRef = useRef(false);
  useEffect(() => {
    if (tab !== "lich-cn" || scheduleLoadedRef.current) return;
    scheduleLoadedRef.current = true;
    setScheduleStatus("loading");
    fetch("/api/sunday-schedule")
      .then((r) => r.json())
      .then((sd) => {
        if (sd.error) { setScheduleStatus("error"); return; }
        setSchedule({ morning: sd.morning ?? [], afternoon: sd.afternoon ?? [], dateLabel: sd.dateLabel ?? "" });
        setScheduleStatus("success");
      })
      .catch(() => setScheduleStatus("error"));
  }, [tab]);

  // Nhận Việc: (re)load jobs when the tab is opened while logged in.
  useEffect(() => {
    if (tab === "nhan-viec" && nvSession) nvLoadJobs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, nvSession]);

  // Hiệu Suất: same pattern. Loads on open rather than on mount — most visits to
  // this page are a driver clocking in, and they should not pay for a report
  // they did not ask for.
  useEffect(() => {
    if (tab === "hieu-suat" && nvSession) tatLoad();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, nvSession]);

  // ── Shift state ───────────────────────────────────────────────────────────
  async function fetchShiftState(id: string): Promise<ShiftState | null> {
    setShiftFetching(true);
    try {
      const res = await fetch(`/api/cham-cong?driver_id=${id}`);
      if (res.ok) {
        const data = await res.json();
        const state: ShiftState = { ...data, fetchedAt: Date.now() };
        shiftStateRef.current = state;
        setTasks(state.tasks ?? []);
        return state;
      }
      return null;
    } catch {
      shiftStateRef.current = null;
      setTasks([]);
      return null;
    } finally {
      setShiftFetching(false);
    }
  }

  async function getShiftState(id: string = driverId): Promise<ShiftState | null> {
    const cached = shiftStateRef.current;
    if (cached && (Date.now() - cached.fetchedAt < SHIFT_STATE_TTL_MS || shiftFetching)) return cached;
    try {
      const res = await fetch(`/api/cham-cong?driver_id=${id}`);
      if (!res.ok) return null;
      const data = await res.json();
      const state: ShiftState = { ...data, fetchedAt: Date.now() };
      shiftStateRef.current = state;
      setTasks(state.tasks ?? []);
      return state;
    } catch {
      return null;
    }
  }

  // Strip leading payroll prefix e.g. "P - P - PT101639 " → "Đặng Thanh Duy"
  const driverCleanName = useMemo(
    () => driverName.replace(/^.*?(?:PT|DC)\d+\s+/i, "").trim(),
    [driverName]
  );

  // Count of schedule rows matching the selected driver (0 when schedule not loaded yet).
  const driverShiftCount = useMemo(() => {
    if (!schedule || !driverCleanName) return 0;
    const q = driverCleanName.toLowerCase();
    return (
      schedule.morning.filter((e) => e.name.toLowerCase().includes(q)).length +
      schedule.afternoon.filter((e) => e.name.toLowerCase().includes(q)).length
    );
  }, [schedule, driverCleanName]);

  const filteredSchedule = useMemo(() => {
    if (!schedule) return { morning: [], afternoon: [], emptySlots: [] };
    const q = scheduleSearch.toLowerCase().trim();
    const matchesFilled = (e: ScheduleEntry) =>
      !!e.name && (!q || e.name.toLowerCase().includes(q) || e.addr.toLowerCase().includes(q));
    const morning   = schedule.morning.filter(matchesFilled);
    const afternoon = schedule.afternoon.filter(matchesFilled);
    // Empty slots are always collected from the full list, separate from matched rows.
    const emptySlots = [
      ...schedule.morning.filter((e) => !e.name),
      ...schedule.afternoon.filter((e) => !e.name),
    ];
    return { morning, afternoon, emptySlots };
  }, [schedule, scheduleSearch]);

  // ── Driver dropdown ───────────────────────────────────────────────────────
  const filteredDrivers = useMemo(() =>
    driverSearch.trim() && !driverId
      ? drivers.filter((d) => d.driver_name.toLowerCase().includes(driverSearch.toLowerCase()))
      : drivers,
    [drivers, driverSearch, driverId]
  );

  function selectDriver(d: Driver) {
    setDriverId(d.driver_id);
    setDriverName(d.driver_name);
    setDriverSearch(d.driver_name);
    setShowDriverList(false);
    localStorage.setItem(LS_DRIVER_ID, d.driver_id);
    localStorage.setItem(LS_DRIVER_NAME, d.driver_name);
    shiftStateRef.current = null;
    fetchShiftState(d.driver_id);
  }

  // Resolve free-typed text to a driver so a typed-but-not-clicked entry still counts:
  // exact name match first, then a unique substring match. Ambiguous / no match → null.
  function resolveDriverFromText(text: string): Driver | null {
    const q = text.trim().toLowerCase();
    if (!q) return null;
    const exact = drivers.find((d) => d.driver_name.toLowerCase() === q);
    if (exact) return exact;
    const matches = drivers.filter((d) => d.driver_name.toLowerCase().includes(q));
    return matches.length === 1 ? matches[0] : null;
  }

  function clearDriver() {
    setDriverId("");
    setDriverName("");
    setDriverSearch("");
    shiftStateRef.current = null;
    setTasks([]);
    setSwitchingJobId(null);
    localStorage.removeItem(LS_DRIVER_ID);
    localStorage.removeItem(LS_DRIVER_NAME);
  }

  // ── Nhận Việc ─────────────────────────────────────────────────────────────
  // The session cookie expired (or was cleared) server-side → drop back to login.
  function nvHandleExpired() {
    setNvSession(null);
    setNvJobs([]);
    try { localStorage.removeItem(LS_NV_SESSION); } catch { /* ignore */ }
    setNvLoginError("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
  }

  async function nvLoadJobs() {
    setNvJobsLoading(true);
    setNvJobsError(null);
    try {
      // driver_id comes from the HttpOnly session cookie server-side.
      const res = await fetch("/api/driver-jobs");
      const data = await res.json();
      if (res.status === 401 || data?.expired) { nvHandleExpired(); return; }
      if (!res.ok || !data.ok) { setNvJobsError(data.error ?? "Không tải được danh sách."); return; }
      setNvRecognized(data.recognized !== false);
      setNvJobs(data.jobs ?? []);
    } catch {
      setNvJobsError("Không kết nối được máy chủ.");
    } finally {
      setNvJobsLoading(false);
    }
  }

  async function nvLogin(e: React.FormEvent) {
    e.preventDefault();
    if (nvLoginBusy) return;
    setNvLoginError(null);
    setNvLoginBusy(true);
    try {
      const res = await fetch("/api/driver-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: nvPhone.trim(), pin: nvPin.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) { setNvLoginError(data.error ?? "Đăng nhập thất bại."); setNvPin(""); return; }

      // The auth cookie is set by the server response; we only keep the name for UI.
      const session: NvSession = { driver_name: data.driver_name };
      setNvSession(session);
      setNvPin("");
      try {
        localStorage.setItem(LS_NV_SESSION, JSON.stringify(session));
        localStorage.setItem(LS_NV_PHONE, nvPhone.trim());
      } catch { /* ignore */ }
      nvLoadJobs();
    } catch {
      setNvLoginError("Không kết nối được máy chủ. Vui lòng thử lại.");
    } finally {
      setNvLoginBusy(false);
    }
  }

  function nvLogout() {
    fetch("/api/driver-auth", { method: "DELETE" }).catch(() => {}); // clear the cookie
    setNvSession(null);
    setNvJobs([]);
    setNvToast(null);
    setNvJobsError(null);
    setTatReport(null); // shares the same session — must not survive a logout
    try { localStorage.removeItem(LS_NV_SESSION); } catch { /* ignore */ }
    // Keep the remembered phone so they don't retype it.
  }

  // ── Hiệu Suất ─────────────────────────────────────────────────────────────

  /**
   * Load the driver's report. The server answers from its archive immediately and
   * refreshes behind the response when today's rows have aged out, reporting that
   * as `refreshing`. One delayed re-fetch picks the fresher day up, so a driver
   * who opens the tab right after finishing a leg sees it appear without having
   * to know to pull down — and without every open paying for a Cartrack fetch.
   */
  async function tatLoad(allowFollowUp = true) {
    setTatLoading(true);
    setTatError(null);
    try {
      const res = await fetch("/api/tat/me");
      const data = await res.json();
      if (res.status === 401) {
        // Cookie expired while the name lingered in localStorage — drop the stale
        // session so the tab shows the login form rather than an empty report.
        setNvSession(null);
        try { localStorage.removeItem(LS_NV_SESSION); } catch { /* ignore */ }
        return;
      }
      if (!res.ok || !data.ok) { setTatError(data.error ?? "Không tải được báo cáo."); return; }
      setTatReport(data as TatReport);
      if (data.refreshing && allowFollowUp) {
        window.setTimeout(() => { tatLoad(false); }, 12_000);
      }
    } catch {
      setTatError("Không kết nối được máy chủ.");
    } finally {
      setTatLoading(false);
    }
  }

  /** Open (or close) one past day. Tapping the open day closes it, so the list
   *  stays a list rather than becoming a stack of expanded days. */
  async function tatToggleDay(date: string) {
    if (tatOpenDay === date) { setTatOpenDay(null); setTatDayDetail(null); return; }
    setTatOpenDay(date);
    setTatDayDetail(null);
    setTatDayLoading(true);
    try {
      const res = await fetch(`/api/tat/me?date=${date}`);
      const data = await res.json();
      if (res.status === 401) {
        setNvSession(null);
        try { localStorage.removeItem(LS_NV_SESSION); } catch { /* ignore */ }
        return;
      }
      if (data.ok) setTatDayDetail({ date, summary: data.summary, legs: data.legs ?? [], refreshing: data.refreshing });
    } catch {
      /* the row renders its own empty state */
    } finally {
      setTatDayLoading(false);
    }
  }

  async function nvClaim(job: DriverJob) {
    if (nvClaiming || !nvSession) return;
    setNvClaiming(job.job_id);
    setNvToast(null);
    try {
      const res = await fetch("/api/driver-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.job_id }),
      });
      const data = await res.json();
      if (res.status === 401 || data?.expired) { nvHandleExpired(); return; }
      if (!res.ok || !data.ok) { setNvToast(data.error ?? "Nhận việc thất bại."); return; }
      setNvToast("Đã nhận việc ✓");
      await nvLoadJobs();
    } catch {
      setNvToast("Nhận việc thất bại.");
    } finally {
      setNvClaiming(null);
    }
  }

  // ── Location dropdown ─────────────────────────────────────────────────────
  const filteredLocations = useMemo(() =>
    locationSearch.trim() && !locationId
      ? locations.filter((l) =>
          l.name.toLowerCase().includes(locationSearch.toLowerCase()) ||
          l.address.toLowerCase().includes(locationSearch.toLowerCase())
        )
      : locations,
    [locations, locationSearch, locationId]
  );

  function selectLocation(l: Location) {
    setLocationId(l.customer_id);
    setLocationName(l.name);
    setLocationSearch(l.name);
    setShowLocationList(false);
  }

  // Same idea as resolveDriverFromText: a typed-but-not-clicked location (e.g. "D001")
  // still resolves. Exact name/code match first, then a unique name+address substring hit.
  function resolveLocationFromText(text: string): Location | null {
    const q = text.trim().toLowerCase();
    if (!q) return null;
    const exact = locations.find(
      (l) => l.name.toLowerCase() === q || l.customer_id.toLowerCase() === q
    );
    if (exact) return exact;
    const matches = locations.filter(
      (l) => l.name.toLowerCase().includes(q) || l.address.toLowerCase().includes(q)
    );
    return matches.length === 1 ? matches[0] : null;
  }

  function clearLocation() {
    setLocationId("");
    setLocationName("");
    setLocationSearch("");
  }

  // ── Đổi địa điểm ──────────────────────────────────────────────────────────
  // Moves one task (identified by task) to the location picked from its own row picker.
  async function switchLocation(task: ChamCongTask, target: Location) {
    if (switching) return;
    setSwitching(true);
    setCcMessage("");
    setPendingNames([]);
    try {
      const res = await fetch("/api/cham-cong", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driver_id: driverId, job_id: task.job_id, psc_customer_id: target.customer_id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCcStatus("error");
        setCcMessage(data.error ?? "Đổi địa điểm thất bại.");
        // A rejection usually means the task moved on (started/finished) — resync so the
        // list reflects what Cartrack actually has.
        shiftStateRef.current = null;
        fetchShiftState(driverId);
        return;
      }
      setCcStatus("success");
      setCcMessage(`Đã đổi địa điểm chấm công ${task.type === "check-in" ? "vào ca" : "ra ca"} sang ${data.location_name} (Job #${data.job_id}).`);
      setSwitchingJobId(null);
      setSwitchSearch("");
      shiftStateRef.current = null;
      fetchShiftState(driverId);
    } catch {
      setCcStatus("error");
      setCcMessage("Không thể kết nối. Vui lòng thử lại.");
    } finally {
      setSwitching(false);
    }
  }

  // Locations offered by the open row's picker — all except where that task already is.
  const switchingTask = useMemo(
    () => tasks.find((t) => t.job_id === switchingJobId) ?? null,
    [tasks, switchingJobId]
  );
  const switchOptions = useMemo(() => {
    const pool = locations.filter((l) => l.customer_id !== switchingTask?.customer_id);
    const q = switchSearch.trim().toLowerCase();
    if (!q) return pool;
    return pool.filter((l) => l.name.toLowerCase().includes(q) || l.address.toLowerCase().includes(q));
  }, [locations, switchingTask, switchSearch]);

  // ── Chấm Công submit ──────────────────────────────────────────────────────
  async function submitChamCong(type: ActionType) {
    // Safety net: clicking a button blurs the input, but the button's onClick fires
    // before the input's (debounced) blur-resolve runs — so a value the driver typed
    // but never clicked in the list can still be unresolved here. Resolve it now, and
    // thread the resolved values through directly (state updates aren't visible until
    // the next render, so we can't read driverId/locationId back this tick).
    let did = driverId;
    let dname = driverName;
    if (!did) {
      const d = resolveDriverFromText(driverSearch);
      if (d) { selectDriver(d); did = d.driver_id; dname = d.driver_name; }
    }
    let lid = locationId;
    let lname = locationName;
    if (!lid) {
      const l = resolveLocationFromText(locationSearch);
      if (l) { selectLocation(l); lid = l.customer_id; lname = l.name; }
    }

    if (!did || !lid) {
      setCcStatus("error");
      if (!did && !lid) {
        setCcMessage("Vui lòng chọn tên nhân viên và địa điểm từ danh sách gợi ý.");
      } else if (!did) {
        setCcMessage(
          driverSearch.trim()
            ? `Không tìm thấy nhân viên “${driverSearch.trim()}”. Vui lòng chọn tên từ danh sách gợi ý.`
            : "Vui lòng chọn tên nhân viên từ danh sách gợi ý."
        );
      } else {
        setCcMessage(
          locationSearch.trim()
            ? `Không tìm thấy địa điểm “${locationSearch.trim()}”. Vui lòng chọn địa điểm từ danh sách gợi ý.`
            : "Vui lòng chọn địa điểm từ danh sách gợi ý."
        );
      }
      return;
    }
    setCcStatus("loading");
    setCcMessage("");
    setPendingNames([]);

    const shift = await getShiftState(did);
    if (shift) {
      const hasOpenShift = shift.checkInCount > shift.completedCheckOuts;
      if (type === "check-in" && hasOpenShift) {
        setCcStatus("error");
        setCcMessage("Đã có task vào ca chưa hoàn thành. Vui lòng mở app Cartrack và hoàn thành task trước khi tạo mới!");
        return;
      }
      if (type === "check-out" && shift.activeCheckOuts > 0) {
        setCcStatus("error");
        setCcMessage("Đã có task ra ca chưa hoàn thành. Vui lòng mở app Cartrack và hoàn thành task!");
        return;
      }
    }

    try {
      const res = await fetch("/api/cham-cong", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driver_id: did, driver_name: dname, psc_customer_id: lid, psc_name: lname, type }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCcStatus("error");
        setCcMessage(data.error ?? "Có lỗi xảy ra.");
        return;
      }
      // Show the new task in "Chấm công hôm nay" immediately — don't wait for the
      // background refetch (~2s), which otherwise leaves the list looking empty right
      // after a successful create. fetchShiftState below reconciles with the server.
      const vnNow = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(new Date());
      setTasks((prev) =>
        prev.some((t) => t.job_id === data.job_id)
          ? prev
          : [
              ...prev,
              { job_id: data.job_id, type, customer_id: lid, location_name: lname, time: vnNow, state: "pending" as const, switchable: true },
            ].sort((a, b) => a.job_id - b.job_id)
      );
      shiftStateRef.current = null;
      fetchShiftState(did);
      // The picked location was input to an action that's now done — leaving it filled
      // would contradict the địa điểm the switch panel reports as authoritative.
      clearLocation();
      setCcStatus("success");
      if (type === "check-in") {
        setCcMessage(`Đã tạo task vào ca (Job #${data.job_id}). Vui lòng mở app Cartrack và hoàn thành task để chấm công vào ca!`);
      } else {
        const names = shift?.pendingJobNames ?? [];
        setPendingNames(names);
        setCcMessage(`Đã tạo task ra ca (Job #${data.job_id}). Vui lòng mở app Cartrack và hoàn thành task để chấm công ra ca!`);
      }
    } catch {
      setCcStatus("error");
      setCcMessage("Không thể kết nối. Vui lòng thử lại.");
    }
  }

  // ── Leave form ────────────────────────────────────────────────────────────
  const canSubmitLeave = useMemo(() => {
    if (!driverId || !leaveType) return false;
    if (leaveType === "nguyen_buoi") return !!(leaveFromDate && leaveToDate);
    if (leaveType === "nua_buoi")    return !!(leaveDate && leaveStartTime && leaveEndTime);
    if (leaveType === "nghi_viec")   return !!leaveDate;
    return false;
  }, [driverId, leaveType, leaveFromDate, leaveToDate, leaveDate, leaveStartTime, leaveEndTime]);

  const endTimeSlots = useMemo(() => {
    if (!leaveStartTime) return TIME_SLOTS;
    const [sh, sm] = leaveStartTime.split(":").map(Number);
    const minMins = sh * 60 + sm + 60;
    return TIME_SLOTS.filter((t) => {
      const [eh, em] = t.split(":").map(Number);
      return eh * 60 + em >= minMins;
    });
  }, [leaveStartTime]);

  function resetLeaveForm() {
    setLeaveType("");
    setLeaveFromDate("");
    setLeaveToDate("");
    setLeaveDate("");
    setLeaveStartTime("");
    setLeaveEndTime("");
    setLeaveStatus("idle");
    setLeaveError("");
    setLeaveSummary("");
  }

  async function submitLeave() {
    setLeaveError("");
    if (!driverId) { setLeaveError("Vui lòng chọn tên nhân viên"); return; }
    if (!leaveType) { setLeaveError("Vui lòng chọn loại nghỉ"); return; }
    if (leaveType === "nguyen_buoi") {
      if (!leaveFromDate || !leaveToDate) { setLeaveError("Vui lòng chọn đầy đủ ngày nghỉ từ và đến"); return; }
      if (leaveToDate < leaveFromDate)    { setLeaveError("Ngày kết thúc phải bằng hoặc sau ngày bắt đầu"); return; }
    } else if (leaveType === "nua_buoi") {
      if (!leaveDate)      { setLeaveError("Vui lòng chọn ngày nghỉ"); return; }
      if (!leaveStartTime) { setLeaveError("Vui lòng chọn giờ bắt đầu"); return; }
      if (!leaveEndTime)   { setLeaveError("Vui lòng chọn giờ kết thúc"); return; }
    } else {
      if (!leaveDate) { setLeaveError("Vui lòng chọn ngày làm việc cuối cùng"); return; }
    }

    // Build the Zalo template up front so the exact same text is shown to the
    // driver (copy/share) AND relayed to the admin Zalo group.
    let copyText = "";

    if (leaveType === "nguyen_buoi") {
      copyText = `⚠️ Thông Báo Nghỉ Nguyên Buổi, ${driverName} đã nộp yêu cầu nghỉ từ ${fmtDate(leaveFromDate)} (${vnWeekday(leaveFromDate)}) đến ${fmtDate(leaveToDate)} (${vnWeekday(leaveToDate)}). Nhờ đội điều phối hỗ trợ sắp xếp để không gián đoạn công việc!`;
    } else if (leaveType === "nua_buoi") {
      copyText = `⚠️ Thông Báo Nghỉ Nửa Buổi, ${driverName} đã nộp yêu cầu nghỉ từ ${leaveStartTime} đến ${leaveEndTime} ngày ${fmtDate(leaveDate)} (${vnWeekday(leaveDate)}). Nhờ đội điều phối hỗ trợ sắp xếp để không gián đoạn công việc!`;
    } else {
      copyText = `⚠️ Thông Báo Nghỉ Việc, ${driverName} đã nộp đơn chấm dứt hợp tác làm việc với Diag. Ngày cuối cùng làm việc là ${fmtDate(leaveDate)} (${vnWeekday(leaveDate)}). Nhờ đội điều phối hỗ trợ sắp xếp và hướng dẫn các thủ tục bàn giao!`;
    }

    setLeaveStatus("loading");

    const payload = {
      driver_id: driverId,
      driver_name: driverName,
      loai_nghi: leaveType,
      ngay_bat_dau: leaveType === "nguyen_buoi" ? leaveFromDate : leaveDate,
      ngay_ket_thuc: leaveType === "nguyen_buoi" ? leaveToDate : undefined,
      gio_bat_dau:   leaveType === "nua_buoi"    ? leaveStartTime : undefined,
      gio_ket_thuc:  leaveType === "nua_buoi"    ? leaveEndTime   : undefined,
      notify_message: copyText,
    };

    try {
      const res = await fetch("/api/nghi-phep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setLeaveError(errData.error ?? "Đơn bị lỗi, vui lòng gửi lại hoặc chụp màn hình gửi vào nhóm Zalo công việc để được hỗ trợ!");
        setLeaveStatus("error");
        return;
      }

      // Notification to điều phối is sent server-side from `notify_message` (the
      // copyText above), so the form only needs to confirm what was submitted.
      let summary = "";
      if (leaveType === "nguyen_buoi") {
        summary = `Bạn đã nộp phép thành công: nghỉ nguyên buổi từ ${fmtDate(leaveFromDate)} (${vnWeekday(leaveFromDate)}) đến ${fmtDate(leaveToDate)} (${vnWeekday(leaveToDate)}).`;
      } else if (leaveType === "nua_buoi") {
        summary = `Bạn đã nộp phép thành công: nghỉ nửa buổi ngày ${fmtDate(leaveDate)} (${vnWeekday(leaveDate)}) từ ${leaveStartTime} đến ${leaveEndTime}.`;
      } else {
        summary = `Bạn đã nộp đơn nghỉ việc thành công. Ngày làm việc cuối cùng: ${fmtDate(leaveDate)} (${vnWeekday(leaveDate)}).`;
      }

      setLeaveSummary(summary);
      setLeaveStatus("success");
    } catch (e) {
      setLeaveError(`Lỗi kết nối: ${String(e)}`);
      setLeaveStatus("error");
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (initialLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-3">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-gray-400">Đang tải...</p>
      </div>
    );
  }

  const today = todayVnStr();

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-md overflow-hidden">

        {/* Tab bar. Icon ABOVE label, not beside it: at five tabs the side-by-side
            row needed 373px inside a 343px card on a 375px phone, so the last tab
            was clipped by the card's overflow-hidden. Stacking drops each tab's
            width to its label alone, which fits with room to spare. */}
        <div className="flex border-b border-gray-200">
          <button
            onClick={() => setTab("cham-cong")}
            className={`flex-1 py-2.5 text-[11px] font-semibold transition-colors flex flex-col items-center justify-center gap-0.5 whitespace-nowrap ${
              tab === "cham-cong"
                ? "text-blue-600 border-b-2 border-blue-600 bg-blue-50/40"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <ClipboardCheck size={14} />
            Chấm Công
          </button>
          <button
            onClick={() => setTab("nghi-phep")}
            className={`flex-1 py-2.5 text-[11px] font-semibold transition-colors flex flex-col items-center justify-center gap-0.5 whitespace-nowrap ${
              tab === "nghi-phep"
                ? "text-blue-600 border-b-2 border-blue-600 bg-blue-50/40"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <FileText size={14} />
            Đơn Nghỉ
          </button>
          <button
            onClick={() => {
              setTab("lich-cn");
              if (driverCleanName) setScheduleSearch(driverCleanName);
            }}
            className={`flex-1 py-2.5 text-[11px] font-semibold transition-colors flex flex-col items-center justify-center gap-0.5 whitespace-nowrap relative ${
              tab === "lich-cn"
                ? "text-blue-600 border-b-2 border-blue-600 bg-blue-50/40"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <CalendarDays size={14} />
            Lịch CN
            {driverShiftCount > 0 && tab !== "lich-cn" && (
              <span className="absolute top-1 right-1 min-w-[16px] h-4 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center px-1 leading-none">
                {driverShiftCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setTab("nhan-viec")}
            className={`flex-1 py-2.5 text-[11px] font-semibold transition-colors flex flex-col items-center justify-center gap-0.5 whitespace-nowrap ${
              tab === "nhan-viec"
                ? "text-blue-600 border-b-2 border-blue-600 bg-blue-50/40"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <Truck size={14} />
            Nhận Việc
          </button>
          <button
            onClick={() => setTab("hieu-suat")}
            className={`flex-1 py-2.5 text-[11px] font-semibold transition-colors flex flex-col items-center justify-center gap-0.5 whitespace-nowrap ${
              tab === "hieu-suat"
                ? "text-blue-600 border-b-2 border-blue-600 bg-blue-50/40"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <Gauge size={14} />
            Hiệu Suất
          </button>
        </div>

        <div className="p-6 space-y-5">

          {/* ── Shared: Driver dropdown (hidden wherever identity is not a picker:
                 the schedule tab needs none, and the self-claim + performance tabs
                 take their driver from the authenticated session instead) ── */}
          {tab !== "lich-cn" && tab !== "nhan-viec" && tab !== "hieu-suat" && (
          <div className="space-y-1 relative">
            <label className="text-sm font-medium text-gray-700">
              Nhân Viên Giao Nhận
              {shiftFetching && tab === "cham-cong" && (
                <span className="ml-2 text-xs text-gray-400">Đang kiểm tra ca...</span>
              )}
            </label>
            <div className="relative">
              <input
                type="text"
                className={`w-full border rounded-lg px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 ${
                  !driverId && driverSearch.trim()
                    ? "border-amber-400 focus:ring-amber-500"
                    : "border-gray-300 focus:ring-blue-500"
                }`}
                placeholder={drivers.length ? "Chọn tên..." : "Đang tải..."}
                value={driverSearch}
                onChange={(e) => { setDriverSearch(e.target.value); setDriverId(""); setShowDriverList(true); }}
                onFocus={() => setShowDriverList(true)}
                onBlur={() => setTimeout(() => {
                  setShowDriverList(false);
                  // Commit a typed-but-not-clicked name if it resolves unambiguously.
                  if (!driverId) { const d = resolveDriverFromText(driverSearch); if (d) selectDriver(d); }
                }, 150)}
              />
              {driverSearch && (
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  onMouseDown={(e) => { e.preventDefault(); clearDriver(); }}
                >
                  ×
                </button>
              )}
            </div>
            {!driverId && driverSearch.trim() && !showDriverList && (
              <p className="text-xs text-amber-600">Chưa chọn tên. Vui lòng chọn từ danh sách gợi ý.</p>
            )}
            {showDriverList && !driverId && filteredDrivers.length > 0 && (
              <ul className="absolute z-10 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-52 overflow-y-auto mt-1">
                {filteredDrivers.map((d) => (
                  <li
                    key={d.driver_id}
                    className="px-3 py-2 text-sm hover:bg-blue-50 cursor-pointer"
                    onMouseDown={() => selectDriver(d)}
                  >
                    {d.driver_name}
                  </li>
                ))}
              </ul>
            )}
          </div>
          )}

          {/* ── Chấm Công tab ───────────────────────────────────────────── */}
          {tab === "cham-cong" && (
            <>
              {/* Location dropdown for creating a new Vào Ca / Ra Ca. The per-task
                  change-location pickers live inline in the task list below and carry
                  their own box, so this one never conflicts with them. */}
              <div className="space-y-1 relative">
                <label className="text-sm font-medium text-gray-700">Địa điểm</label>
                <div className="relative">
                  <input
                    type="text"
                    className={`w-full border rounded-lg px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 ${
                      !locationId && locationSearch.trim()
                        ? "border-amber-400 focus:ring-amber-500"
                        : "border-gray-300 focus:ring-blue-500"
                    }`}
                    placeholder={locations.length ? "Tìm địa điểm..." : "Đang tải..."}
                    value={locationSearch}
                    onChange={(e) => { setLocationSearch(e.target.value); setLocationId(""); setShowLocationList(true); }}
                    onFocus={() => setShowLocationList(true)}
                    onBlur={() => setTimeout(() => {
                      setShowLocationList(false);
                      // Commit a typed-but-not-clicked location (e.g. "D001") if it resolves.
                      if (!locationId) { const l = resolveLocationFromText(locationSearch); if (l) selectLocation(l); }
                    }, 150)}
                  />
                  {locationSearch && (
                    <button
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      onMouseDown={(e) => { e.preventDefault(); clearLocation(); }}
                    >
                      ×
                    </button>
                  )}
                </div>
                {!locationId && locationSearch.trim() && !showLocationList && (
                  <p className="text-xs text-amber-600">Chưa chọn địa điểm. Vui lòng chọn từ danh sách gợi ý.</p>
                )}
                {showLocationList && !locationId && filteredLocations.length > 0 && (
                  <ul className="absolute z-10 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-52 overflow-y-auto mt-1">
                    {filteredLocations.map((l) => (
                      <li
                        key={l.customer_id}
                        className="px-3 py-2 cursor-pointer hover:bg-blue-50"
                        onMouseDown={() => selectLocation(l)}
                      >
                        <div className="text-sm font-medium text-gray-800">{l.name}</div>
                        {l.address && <div className="text-xs text-gray-400">{l.address}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Check-in / Check-out buttons — always available. A pending Vào Ca must
                  not hide Ra Ca: a driver who checked in, forgot to finish the task in
                  Cartrack, and returns at end of shift still needs to check out. The
                  shift-state guard in submitChamCong already blocks re-submitting the
                  SAME type with a clear message; only that case is actually dead. */}
              <div className="grid grid-cols-2 gap-3 pt-1">
                <button
                  disabled={ccStatus === "loading"}
                  onClick={() => submitChamCong("check-in")}
                  className="bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white font-semibold rounded-xl py-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-green-600"
                >
                  {ccStatus === "loading" ? "Đang xử lý..." : "Tạo Task Vào Ca"}
                </button>
                <button
                  disabled={ccStatus === "loading"}
                  onClick={() => submitChamCong("check-out")}
                  className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-semibold rounded-xl py-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-red-500"
                >
                  {ccStatus === "loading" ? "Đang xử lý..." : "Tạo Task Ra Ca"}
                </button>
              </div>

              {/* Today's chấm-công tasks — the full record of the day. Un-started tasks
                  ("pending") carry an inline change-location control; "started"/"done"
                  ones are locked (Cartrack won't move a real record, PATCH rejects it). */}
              {driverId && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-800">Chấm công hôm nay</h3>
                    {shiftFetching && tasks.length > 0 && <Loader2 size={13} className="animate-spin text-gray-400" />}
                  </div>

                  {tasks.length === 0 ? (
                    <p className="text-sm text-gray-400 py-1.5">
                      {shiftFetching ? "Đang tải..." : "Chưa có chấm công nào hôm nay."}
                    </p>
                  ) : (
                    <div className="rounded-xl border border-gray-200 divide-y divide-gray-100 overflow-hidden">
                      {tasks.map((t) => {
                        const badge = CC_STATE_BADGE[t.state];
                        const isCheckin = t.type === "check-in";
                        const open = switchingJobId === t.job_id;
                        return (
                          <div key={t.job_id} className="px-3 py-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                {isCheckin
                                  ? <LogIn size={16} className="text-gray-500 shrink-0" />
                                  : <LogOut size={16} className="text-gray-500 shrink-0" />}
                                <div className="min-w-0">
                                  <div className="text-sm font-semibold text-gray-800 truncate">
                                    {isCheckin ? "Vào ca" : "Ra ca"}
                                    <span className="font-normal text-gray-500"> · {t.location_name ?? "—"}</span>
                                  </div>
                                  {t.time && <div className="text-xs text-gray-500 tabular-nums">{t.time}</div>}
                                </div>
                              </div>
                              <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full border ${badge.cls}`}>
                                {badge.label}
                              </span>
                            </div>

                            {t.switchable && (
                              open ? (
                                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 space-y-2">
                                  <div className="relative">
                                    <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                                    <input
                                      type="text"
                                      autoFocus
                                      className="w-full border border-amber-300 rounded-lg pl-8 pr-3 py-2.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                                      placeholder="Tìm địa điểm mới..."
                                      value={switchSearch}
                                      onChange={(e) => setSwitchSearch(e.target.value)}
                                      disabled={switching}
                                    />
                                  </div>
                                  <ul className="bg-white border border-amber-200 rounded-lg max-h-36 overflow-y-auto divide-y divide-gray-100">
                                    {switchOptions.length === 0 ? (
                                      <li className="px-2.5 py-1.5 text-xs text-gray-500">Không tìm thấy địa điểm.</li>
                                    ) : (
                                      switchOptions.map((l) => (
                                        <li key={l.customer_id}>
                                          <button
                                            onClick={() => switchLocation(t, l)}
                                            disabled={switching}
                                            className="w-full text-left px-2.5 py-2 hover:bg-amber-50 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500"
                                          >
                                            <div className="text-xs font-medium text-gray-800">{l.name}</div>
                                            {l.address && <div className="text-[11px] text-gray-500 truncate">{l.address}</div>}
                                          </button>
                                        </li>
                                      ))
                                    )}
                                  </ul>
                                  <button
                                    onClick={() => { setSwitchingJobId(null); setSwitchSearch(""); }}
                                    disabled={switching}
                                    className="w-full text-xs font-medium text-amber-800 rounded-lg py-2 hover:bg-amber-100 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                                  >
                                    {switching ? "Đang đổi địa điểm..." : "Huỷ"}
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => { setSwitchingJobId(t.job_id); setSwitchSearch(""); }}
                                  disabled={switching}
                                  className="mt-2 w-full flex items-center justify-center gap-1.5 text-xs font-medium text-amber-800 bg-amber-100 border border-amber-300 rounded-lg py-2.5 hover:bg-amber-200 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-amber-500"
                                >
                                  <ArrowLeftRight size={13} /><MapPin size={13} /> Đổi địa điểm
                                </button>
                              )
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Chấm công status message */}
              {ccMessage && (
                <div className="space-y-3">
                  <div
                    className={`rounded-lg px-4 py-3 text-sm font-medium ${
                      ccStatus === "success"
                        ? "bg-green-50 text-green-700 border border-green-200"
                        : ccStatus === "error"
                        ? "bg-red-50 text-red-700 border border-red-200"
                        : ""
                    }`}
                  >
                    {ccMessage}
                  </div>
                  {pendingNames.length > 0 && (
                    <div className="rounded-lg px-4 py-3 text-sm border border-yellow-300 bg-yellow-50 text-yellow-800">
                      <p className="font-semibold flex items-center gap-1.5">
                        <span>⚠️</span> Lưu ý, vẫn còn những công việc chưa hoàn tất:
                      </p>
                      <ol className="list-decimal list-inside mt-1.5 space-y-0.5 font-normal">
                        {pendingNames.map((name, i) => <li key={i}>{name}</li>)}
                      </ol>
                      <p className="mt-1.5 font-medium">Vui lòng liên hệ điều phối trước khi rời ca!</p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── Nộp Đơn Nghỉ tab ────────────────────────────────────────── */}
          {tab === "nghi-phep" && (
            <>
              {leaveStatus === "success" ? (
                /* Minimal success view — the điều phối notification is sent by a
                   bot trigger on submit, so this only confirms what was nộp. */
                <div className="space-y-4">
                  <div className="rounded-lg px-4 py-3 bg-green-50 border border-green-200">
                    <p className="text-sm font-medium text-green-800 leading-relaxed">{leaveSummary}</p>
                  </div>

                  <button
                    onClick={resetLeaveForm}
                    className="w-full border border-gray-300 rounded-xl py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Nộp thêm đơn khác
                  </button>
                </div>
              ) : (
                /* Leave form */
                <>
                  {/* Loại nghỉ */}
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-gray-700">Loại nghỉ</label>
                    <select
                      value={leaveType}
                      onChange={(e) => {
                        setLeaveType(e.target.value as LeaveType);
                        setLeaveFromDate(""); setLeaveToDate(""); setLeaveDate("");
                        setLeaveStartTime(""); setLeaveEndTime(""); setLeaveError("");
                      }}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    >
                      <option value="">-- Chọn loại nghỉ --</option>
                      <option value="nguyen_buoi">Nghỉ nguyên buổi (nghỉ toàn bộ ca làm)</option>
                      <option value="nua_buoi">Nghỉ nửa buổi (nghỉ một/một vài tiếng ở đầu hoặc cuối ca)</option>
                      <option value="nghi_viec">Nghỉ việc (Kết thúc hợp tác)</option>
                    </select>
                  </div>

                  {/* Disclaimers — always right beneath the selector */}
                  {(leaveType === "nguyen_buoi" || leaveType === "nua_buoi") && (
                    <p className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      <NotepadText size={13} className="shrink-0" />
                      Cần báo trước 3 – 7 ngày để không gián đoạn công việc
                    </p>
                  )}
                  {leaveType === "nghi_viec" && (
                    <p className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      <NotepadText size={13} className="shrink-0" />
                      Cần báo trước tối thiểu 14 ngày để không gián đoạn công việc
                    </p>
                  )}

                  {/* Nghỉ nguyên buổi: date range */}
                  {leaveType === "nguyen_buoi" && (
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <label className="text-sm font-medium text-gray-700">Nghỉ từ ngày</label>
                        <DateField
                          value={leaveFromDate}
                          min={today}
                          onChange={(v) => { setLeaveFromDate(v); if (leaveToDate && v > leaveToDate) setLeaveToDate(""); }}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-sm font-medium text-gray-700">Đến ngày</label>
                        <DateField
                          value={leaveToDate}
                          min={leaveFromDate || today}
                          onChange={setLeaveToDate}
                        />
                      </div>
                    </div>
                  )}

                  {/* Nghỉ nửa buổi: date + time range */}
                  {leaveType === "nua_buoi" && (
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <label className="text-sm font-medium text-gray-700">Ngày nghỉ</label>
                        <DateField value={leaveDate} min={today} onChange={setLeaveDate} />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <label className="text-sm font-medium text-gray-700">Giờ bắt đầu</label>
                          <div className="relative">
                            <Clock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none z-10" />
                            <select
                              value={leaveStartTime}
                              onChange={(e) => { setLeaveStartTime(e.target.value); setLeaveEndTime(""); }}
                              className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                            >
                              <option value="">-- Chọn --</option>
                              {TIME_SLOTS.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </div>
                        </div>
                        <div className="space-y-1">
                          <label className="text-sm font-medium text-gray-700">Giờ kết thúc</label>
                          <div className="relative">
                            <Clock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none z-10" />
                            <select
                              value={leaveEndTime}
                              onChange={(e) => setLeaveEndTime(e.target.value)}
                              disabled={!leaveStartTime}
                              className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white disabled:opacity-50"
                            >
                              <option value="">-- Chọn --</option>
                              {endTimeSlots.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Nghỉ việc: last working day */}
                  {leaveType === "nghi_viec" && (
                    <div className="space-y-1">
                      <label className="text-sm font-medium text-gray-700">Ngày làm việc cuối cùng</label>
                      <DateField value={leaveDate} min={today} onChange={setLeaveDate} />
                    </div>
                  )}

                  {/* Error */}
                  {(leaveError || leaveStatus === "error") && (
                    <div className="rounded-lg px-4 py-3 bg-red-50 border border-red-200 text-sm text-red-700">
                      {leaveError || "Đơn bị lỗi, vui lòng gửi lại hoặc chụp màn hình gửi vào nhóm Zalo công việc để được hỗ trợ!"}
                    </div>
                  )}

                  <button
                    disabled={leaveStatus === "loading" || !canSubmitLeave}
                    onClick={submitLeave}
                    className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-xl py-3 text-sm transition-colors"
                  >
                    {leaveStatus === "loading" ? "Đang gửi..." : "Nộp Đơn"}
                  </button>
                </>
              )}
            </>
          )}

          {/* ── Lịch CN tab ─────────────────────────────────────────────── */}
          {tab === "lich-cn" && (
            <>
              {scheduleStatus === "loading" && (
                <div className="flex flex-col items-center justify-center py-10 gap-3">
                  <div className="w-7 h-7 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm text-gray-400">Đang tải lịch...</p>
                </div>
              )}

              {scheduleStatus === "error" && (
                <div className="rounded-lg px-4 py-3 bg-red-50 border border-red-200 text-sm text-red-700">
                  Không tải được lịch. Vui lòng thử lại sau.
                </div>
              )}

              {scheduleStatus === "success" && schedule && (
                <>
                  <div className="text-center">
                    <p className="text-xs uppercase tracking-wide text-gray-400 font-semibold">
                      Lịch làm việc Chủ Nhật
                    </p>
                    {schedule.dateLabel && (
                      <p className="text-base font-bold text-gray-800">Ngày {schedule.dateLabel}</p>
                    )}
                  </div>

                  <div className="relative">
                    <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                    <input
                      type="text"
                      className="w-full border border-gray-300 rounded-lg pl-9 pr-8 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Tìm tên hoặc địa điểm..."
                      value={scheduleSearch}
                      onChange={(e) => setScheduleSearch(e.target.value)}
                    />
                    {scheduleSearch && (
                      <button
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        onClick={() => setScheduleSearch("")}
                      >
                        ×
                      </button>
                    )}
                  </div>

                  <ShiftSection title="🌅 Ca sáng" accent="amber" rows={filteredSchedule.morning} />
                  <ShiftSection title="🌆 Ca chiều" accent="blue" rows={filteredSchedule.afternoon} />

                  {filteredSchedule.morning.length === 0 && filteredSchedule.afternoon.length === 0 && filteredSchedule.emptySlots.length === 0 && (
                    <p className="text-center text-sm text-gray-400 py-6">
                      {scheduleSearch ? "Không tìm thấy kết quả." : "Chưa có lịch."}
                    </p>
                  )}

                  {filteredSchedule.emptySlots.length > 0 && (
                    <div className="rounded-xl border border-red-300 overflow-hidden">
                      <div className="bg-red-50 text-red-700 text-sm font-bold px-4 py-2.5 flex items-center justify-between border-b border-red-200">
                        <span>Ca trống chưa có người</span>
                        <span className="text-xs font-semibold">{filteredSchedule.emptySlots.length}</span>
                      </div>
                      <ul className="divide-y divide-gray-100">
                        {filteredSchedule.emptySlots.map((r, i) => (
                          <li key={`empty-${i}`} className="px-4 py-2.5 flex gap-2">
                            <span className="text-xs text-gray-400 w-5 shrink-0 pt-0.5">{i + 1}</span>
                            <div className="min-w-0 flex-1">
                              {r.addr && <p className="text-sm text-gray-600">{r.addr}</p>}
                              {r.ca && (
                                <div className="mt-1">
                                  <span className="inline-block text-xs font-medium text-gray-700 bg-gray-100 rounded px-1.5 py-0.5">{r.ca}</span>
                                </div>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                      <p className="text-xs text-blue-700 bg-blue-50 border-t border-blue-100 px-4 py-2.5 leading-relaxed">
                        📋 Vui lòng liên hệ lên nhóm làm việc để đăng ký ca làm việc còn trống!
                      </p>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* ── Nhận Việc tab ───────────────────────────────────────────── */}
          {tab === "nhan-viec" && (
            <>
              {!nvLoggedIn ? (
                /* Login */
                <form onSubmit={nvLogin} className="space-y-4">
                  <p className="text-sm text-gray-500">
                    Đăng nhập bằng số điện thoại và mã PIN Cartrack của bạn để nhận việc.
                  </p>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Tài Khoản Đăng Nhập Cartrack</label>
                    <input
                      type="tel" inputMode="tel" autoComplete="off" value={nvPhone}
                      onChange={(e) => setNvPhone(e.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Mã PIN</label>
                    <input
                      type="password" inputMode="numeric" autoComplete="off" value={nvPin}
                      onChange={(e) => setNvPin(e.target.value)} placeholder="••••••"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500"
                      required
                    />
                  </div>
                  {nvLoginError && (
                    <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                      <AlertCircle size={16} className="mt-0.5 shrink-0" />
                      <span>{nvLoginError}</span>
                    </div>
                  )}
                  <button
                    type="submit" disabled={nvLoginBusy}
                    className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white rounded-xl py-2.5 text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 transition-colors"
                  >
                    {nvLoginBusy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}
                    Đăng nhập
                  </button>
                </form>
              ) : (
                /* Job list */
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs text-gray-500">Đã đăng nhập</p>
                      <p className="text-sm font-semibold text-gray-800 truncate">{nvDisplayName}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => nvLoadJobs()}
                        disabled={nvJobsLoading}
                        className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                        title="Tải lại"
                      >
                        <RefreshCw size={16} className={nvJobsLoading ? "animate-spin" : ""} />
                      </button>
                      <button onClick={nvLogout} className="p-2 rounded-lg text-gray-500 hover:bg-gray-100" title="Đăng xuất">
                        <LogOut size={16} />
                      </button>
                    </div>
                  </div>

                  {nvToast && (
                    <div className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 text-center">{nvToast}</div>
                  )}

                  {nvJobsLoading ? (
                    <div className="flex items-center justify-center py-12 text-gray-400"><Loader2 size={22} className="animate-spin" /></div>
                  ) : nvJobsError ? (
                    <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">
                      <AlertCircle size={16} className="mt-0.5 shrink-0" />
                      <span>{nvJobsError}</span>
                    </div>
                  ) : !nvRecognized ? (
                    <p className="text-center text-sm text-gray-400 py-8">Bạn chưa được phân tuyến nào trong hệ thống.</p>
                  ) : nvJobs.length === 0 ? (
                    <p className="text-center text-sm text-gray-400 py-8">Hiện không có công việc nào cần nhận.</p>
                  ) : (
                    nvJobs.map((job) => (
                      <NvJobCard key={job.job_id} job={job} claiming={nvClaiming === job.job_id} onClaim={() => nvClaim(job)} />
                    ))
                  )}
                </div>
              )}
            </>
          )}

          {/* ── Hiệu Suất tab ───────────────────────────────────────────── */}
          {tab === "hieu-suat" && (
            <>
              {!nvLoggedIn ? (
                <div className="space-y-3">
                  <p className="text-sm text-gray-500">
                    Đăng nhập ở tab <span className="font-semibold text-gray-700">Nhận Việc</span> để xem
                    báo cáo của bạn. Mỗi người chỉ xem được số liệu của chính mình.
                  </p>
                  <button
                    onClick={() => setTab("nhan-viec")}
                    className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white rounded-xl py-2.5 text-sm font-semibold hover:bg-blue-700 transition-colors"
                  >
                    <LogIn size={16} />
                    Tới trang đăng nhập
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs text-gray-500">Báo cáo của</p>
                      <p className="text-sm font-semibold text-gray-800 truncate">{nvDisplayName}</p>
                    </div>
                    <button
                      onClick={() => tatLoad()}
                      disabled={tatLoading}
                      className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                      title="Tải lại"
                    >
                      <RefreshCw size={16} className={tatLoading ? "animate-spin" : ""} />
                    </button>
                  </div>

                  {/* Span switcher */}
                  <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
                    {([
                      ["today", "Hôm nay"],
                      ["week", "Tuần này"],
                      ["month", "Tháng này"],
                      ["prev_month", "Tháng trước"],
                    ] as [TatSpan, string][]).map(([key, label]) => (
                      <button
                        key={key}
                        onClick={() => { setTatSpan(key); setTatOpenDay(null); setTatDayDetail(null); }}
                        className={`flex-1 py-1.5 rounded-lg text-[11px] font-semibold transition-colors whitespace-nowrap ${
                          tatSpan === key ? "bg-white text-blue-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {tatLoading && !tatReport ? (
                    <div className="flex items-center justify-center py-12 text-gray-400">
                      <Loader2 size={22} className="animate-spin" />
                    </div>
                  ) : tatError ? (
                    <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">
                      <AlertCircle size={16} className="mt-0.5 shrink-0" />
                      <span>{tatError}</span>
                    </div>
                  ) : !tatReport ? null : (
                    <>
                      {tatReport.degraded && (
                        <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 rounded-lg px-4 py-3">
                          <AlertCircle size={16} className="mt-0.5 shrink-0" />
                          <span>{tatReport.degraded}</span>
                        </div>
                      )}

                      {tatSpan === "today" && (
                        <>
                          <TatHeadline summary={tatReport.today.summary} title="Hôm nay bạn đã chạy" />
                          <div className="grid grid-cols-3 gap-2">
                            <TatStat label="Tổng quãng đường" value={`${tatReport.today.summary.total_km} km`} />
                            <TatStat label="Thời gian chạy" value={fmtMins(tatReport.today.summary.total_tat_mins)} />
                            <TatStat label="TB mỗi chặng" value={fmtMins(tatReport.today.summary.avg_tat_mins)} />
                          </div>

                          {tatReport.today.legs.length === 0 ? (
                            <p className="text-center text-sm text-gray-400 py-8">
                              Hôm nay chưa có chặng nào được ghi nhận.
                            </p>
                          ) : (
                            <div className="space-y-2">
                              {tatReport.today.legs.map((leg) => (
                                <TatLegRow key={leg.seq} leg={leg} />
                              ))}
                            </div>
                          )}
                        </>
                      )}

                      {tatSpan === "week" && (
                        <>
                          <TatHeadline summary={tatReport.week.summary} title="Tuần này bạn đã chạy" />
                          <div className="grid grid-cols-3 gap-2">
                            <TatStat label="Tổng quãng đường" value={`${tatReport.week.summary.total_km} km`} />
                            <TatStat label="Thời gian chạy" value={fmtMins(tatReport.week.summary.total_tat_mins)} />
                            <TatStat label="TB mỗi chặng" value={fmtMins(tatReport.week.summary.avg_tat_mins)} />
                          </div>
                          <TatTrend current={tatReport.week.summary} previous={tatReport.prev_week.summary} />

                          <TatDayList
                            days={tatReport.week.days}
                            openDay={tatOpenDay}
                            dayLoading={tatDayLoading}
                            dayDetail={tatDayDetail}
                            onToggle={tatToggleDay}
                          />
                        </>
                      )}

                      {tatSpan === "month" && (
                        <>
                          <TatHeadline summary={tatReport.month.summary} title="Tháng này bạn đã chạy" />
                          <div className="grid grid-cols-3 gap-2">
                            <TatStat label="Tổng quãng đường" value={`${tatReport.month.summary.total_km} km`} />
                            <TatStat label="Thời gian chạy" value={fmtMins(tatReport.month.summary.total_tat_mins)} />
                            <TatStat label="TB mỗi chặng" value={fmtMins(tatReport.month.summary.avg_tat_mins)} />
                          </div>
                          <p className="text-xs text-gray-400 text-center">
                            Từ {fmtDate(tatReport.month.from)} đến {fmtDate(tatReport.month.to)}
                          </p>
                          <TatDayList
                            days={tatReport.month.days}
                            openDay={tatOpenDay}
                            dayLoading={tatDayLoading}
                            dayDetail={tatDayDetail}
                            onToggle={tatToggleDay}
                          />
                        </>
                      )}

                      {tatSpan === "prev_month" && (
                        <>
                          <TatHeadline summary={tatReport.prev_month.summary} title="Tháng trước bạn đã chạy" />
                          <div className="grid grid-cols-3 gap-2">
                            <TatStat label="Tổng quãng đường" value={`${tatReport.prev_month.summary.total_km} km`} />
                            <TatStat label="Thời gian chạy" value={fmtMins(tatReport.prev_month.summary.total_tat_mins)} />
                            <TatStat label="TB mỗi chặng" value={fmtMins(tatReport.prev_month.summary.avg_tat_mins)} />
                          </div>
                          <p className="text-xs text-gray-400 text-center">
                            Từ {fmtDate(tatReport.prev_month.from)} đến {fmtDate(tatReport.prev_month.to)}
                          </p>
                          <TatDayList
                            days={tatReport.prev_month.days}
                            openDay={tatOpenDay}
                            dayLoading={tatDayLoading}
                            dayDetail={tatDayDetail}
                            onToggle={tatToggleDay}
                          />
                        </>
                      )}

                      {/* Jump straight to a date. The day lists cover browsing; this covers
                          the other case — someone naming a specific day in a pay dispute,
                          which may be outside whichever span is on screen. */}
                      <div className="rounded-xl border border-gray-200 px-3 py-2.5 space-y-2">
                        <label className="text-[11px] font-medium text-gray-600 flex items-center gap-1.5">
                          <Calendar size={13} className="text-gray-400" />
                          Xem một ngày bất kỳ
                        </label>
                        <input
                          type="date"
                          max={tatReport.today.date}
                          value={tatOpenDay ?? ""}
                          onChange={(e) => { if (e.target.value) tatToggleDay(e.target.value); }}
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        {tatOpenDay && (
                          <div className="space-y-2 pt-1">
                            <div className="flex items-center justify-between">
                              <p className="text-xs font-semibold text-gray-700">
                                {vnWeekday(tatOpenDay)}, {fmtDate(tatOpenDay)}
                              </p>
                              <button
                                onClick={() => { setTatOpenDay(null); setTatDayDetail(null); }}
                                className="text-[11px] text-gray-400 hover:text-gray-600"
                              >
                                Đóng
                              </button>
                            </div>
                            {tatDayLoading ? (
                              <div className="flex justify-center py-4 text-gray-400"><Loader2 size={18} className="animate-spin" /></div>
                            ) : !tatDayDetail || tatDayDetail.legs.length === 0 ? (
                              <p className="text-xs text-gray-400 text-center py-3">
                                {tatDayDetail?.refreshing
                                  ? "Đang tải dữ liệu ngày này, thử lại sau giây lát..."
                                  : "Không có chặng nào trong ngày này."}
                              </p>
                            ) : (
                              <>
                                <div className="grid grid-cols-3 gap-2">
                                  <TatStat label="Chặng" value={String(tatDayDetail.summary.trips_total)} />
                                  <TatStat label="Đúng giờ" value={tatDayDetail.summary.on_time_pct == null ? "—" : `${tatDayDetail.summary.on_time_pct}%`} />
                                  <TatStat label="TB mỗi chặng" value={fmtMins(tatDayDetail.summary.avg_tat_mins)} />
                                </div>
                                {tatDayDetail.legs.map((leg) => <TatLegRow key={leg.seq} leg={leg} />)}
                              </>
                            )}
                          </div>
                        )}
                      </div>

                      {/* The rule, stated once, in the driver's own units. A target
                          nobody can reproduce in their head is a target nobody trusts. */}
                      <div className="rounded-xl bg-gray-50 border border-gray-200 px-3 py-2.5 space-y-1">
                        <p className="text-[11px] text-gray-600">
                          <span className="font-semibold">Cách tính mục tiêu:</span> mỗi km được tính{" "}
                          {tatReport.mins_per_km} phút, làm tròn lên. Ví dụ 7,2 km → 8 km → {8 * tatReport.mins_per_km} phút.
                        </p>
                        <p className="text-[11px] text-gray-500">
                          Thời gian được tính từ lúc bạn xong điểm này đến lúc tới điểm kế tiếp.
                        </p>
                        <p className="text-[11px] text-gray-500">
                          Mục tiêu lấy <span className="font-semibold">số cao hơn</span> giữa cách tính
                          trên và thời gian bản đồ (Goong) ước tính cho đúng đoạn đường đó. Đường nào
                          thực tế đi lâu hơn thì mục tiêu tự động nới ra.
                        </p>
                        {tatReport.updated_at && (
                          <p className="text-[11px] text-gray-400">
                            Cập nhật lúc{" "}
                            {new Intl.DateTimeFormat("en-GB", {
                              timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false,
                            }).format(new Date(tatReport.updated_at))}
                            {tatReport.refreshing && " · đang cập nhật..."}
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}

        </div>
      </div>
    </div>
  );
}
