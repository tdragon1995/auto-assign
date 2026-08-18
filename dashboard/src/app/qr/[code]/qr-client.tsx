"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
// PSC routes are a hard-coded constant ([[psc-routes-data]]); look up directly instead of
// fetching /api/psc-routes — no function invocation, no network round-trip, instant render.
import {
  Package, Check, ChevronDown, ChevronRight, Clock, Phone, Bike, CalendarDays,
  ArrowUp, ArrowDown, ArrowRight, Loader2, Search, XCircle,
} from "lucide-react";
import { PSC_ROUTES } from "@/lib/psc-routes-data";
import { placeLabel } from "@/lib/place-label";
import { Photos, Timeline, TODO_ICON, type TlEvent } from "@/components/trip-sheet";
import { proxyKind, driverLabel, THREE_PL_LABEL } from "@/lib/proxy-drivers";

interface Stop {
  stop_id: number;
  stop_type_id: number;
  stop_status_id: number;
  customer_id: string;
  customer_name: string;
  address_line_1?: string | null;
  activity_started_ts?: string | null;
  activity_arrived_ts?: string | null;
  activity_completed_ts?: string | null;
  delivery_windows?: { time_from?: string | null; time_to?: string | null }[];
  todos?: {
    todo_type_id: number;
    description?: string;
    note?: string;
    images?: { image_id: number; image_url: string; is_deleted: boolean }[];
  }[];
}

interface Job {
  job_id: number;
  reference_number: string;
  job_status_id: number;
  scheduled_delivery_ts: string | null;
  last_assigned_plan_id?: number | null;
  item_tracking_numbers?: string[];
  driver?: { last_name?: string | null; phone_local?: string | null; phone_e164?: string | null } | null;
  stops: Stop[];
  // Set only on jobs from the unrouted pool (status 3).
  rejected_ts?: string | null;
  rejected_reason?: string | null;
}

// A request this device created that hasn't surfaced on a driver's route yet.
// Cartrack's route feed only contains jobs already handed to a driver, so a job
// we created and can't find there is still waiting for dispatch.
interface PendingReq {
  job_id: number;
  reference: string;
  created_ts: string; // "HH:mm"
  date: string;       // YYYY-MM-DD it was created on
  /** Filled in seconds after booking, once the trip has been handed to a driver. The
   *  published day will not carry this trip for minutes yet, so without this the branch
   *  stares at "chờ điều phối" while a driver is already riding to them. */
  driver_name?: string;
}

type Status = "idle" | "loading" | "success" | "error";

const STEPS = ["Yêu cầu", "Lấy mẫu", "Đang giao", "Đã giao"] as const;

// Shortest gap between two automatic feed refreshes. Mirrors MAX_AGE_MS in
// lib/day-snapshot — a request inside that window gets the snapshot already on screen,
// so it costs an invocation and changes nothing. Hard-coded rather than imported because
// day-snapshot pulls in the Redis client, which has no business in a phone's bundle.
// Raising it there means raising it here.
// Applies to the visibility refresh. Nothing on this page forces a rebuild any more —
// actions update the list from their own response instead — so this is now the only
// throttle that matters, and it guards an invocation rather than a day rebuild.
const MIN_REFRESH_MS = 60_000;

function todayVN(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()).slice(0, 10);
}

function nowHm(): string {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());
}

function fmtTs(ts?: string | null): string | null {
  return ts ? ts.slice(11, 16) : null;
}

// Requests we create carry the creation time in the reference ("D038→D001_17:21"),
// which is the only place it survives — the route feed has no create_ts.
function requestedAt(job: Job): string | null {
  const m = /_(\d{2}:\d{2})/.exec(job.reference_number ?? "");
  return m ? m[1] : fmtTs(job.scheduled_delivery_ts);
}

// Proxy accounts are classified in @/lib/proxy-drivers — an earlier /proxy|3pl/ regex
// here matched the parking account too, so a job merely waiting for dispatch displayed
// as "Đã gửi qua đối tác" (handed to Grab), which it had not been.
function isThreePl(name?: string | null): boolean {
  return proxyKind(name) === "3pl";
}

function isParked(name?: string | null): boolean {
  const k = proxyKind(name);
  return k === "queue" || k === "reject";
}

function driverText(name?: string | null): string {
  return driverLabel(name) ?? "—";
}

// Cartrack sends window bounds as time-only strings ("07:00:00+07"). Only client pickups
// carry them — no Diag site has ever had one — so this shows up on inbound legs only.
function windowLabel(stop?: Stop | null): string | null {
  const w = (stop?.delivery_windows ?? [])[0];
  if (!w) return null;
  const hm = (t?: string | null) => (t ? t.slice(0, 5) : null);
  const from = hm(w.time_from), to = hm(w.time_to);
  if (from && to) return `${from}–${to}`;
  return from ?? to ?? null;
}

// Diacritic-insensitive search so "duc" matches "Đức". NFD splits the accent off as a
// combining mark; đ/Đ has no decomposition, so it needs replacing separately.
function norm(s: string): string {
  return (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
}

function pickupOf(j: Job) { return j.stops.find((s) => s.stop_type_id === 1); }
function dropoffOf(j: Job) { return j.stops.find((s) => s.stop_type_id !== 1); }

// 0 waiting for dispatch · 1 driver heading to pickup · 2 sample collected, en route
// to the destination · 3 handed over · 4 rejected by a driver · 5 parked until its
// appointed time.
//
// Status 2 (unassigned) and 3 (rejected) arrive from the unrouted pool. A job parked on
// a proxy account is waiting too, but for a different reason and with a different answer
// to "when?": nobody is looking for a driver yet because the pickup time hasn't come
// round. Collapsing the two into "Chờ điều phối" made a scheduled trip look stuck.
type TripState = 0 | 1 | 2 | 3 | 4 | 5;

function stateOf(j: Job): TripState {
  const p = pickupOf(j), d = dropoffOf(j);
  if (j.job_status_id === 3) return 4;
  if (d?.activity_completed_ts || j.job_status_id === 5) return 3;
  if (p?.activity_completed_ts) return 2;
  if (isParked(j.driver?.last_name) && !p?.activity_started_ts) return 5;
  if (j.job_status_id === 2) return 0;
  return 1;
}

/** True while a trip is still waiting to start — either state of waiting. */
function isWaiting(state: TripState): boolean {
  return state === 0 || state === 5;
}

const STATE_STYLE: Record<number, string> = {
  0: "bg-amber-100 text-amber-700",
  1: "bg-blue-100 text-blue-700",
  2: "bg-blue-100 text-blue-700",
  3: "bg-green-100 text-green-700",
  4: "bg-red-100 text-red-700",
  5: "bg-amber-100 text-amber-700",
};

// "lab" only ever meant D001. Hub routes drop at D007/D009/D046 and inbound client legs
// drop at the branch itself, so the destination is named rather than assumed.
function stateText(state: TripState, dest?: string): string {
  const to = dest ? ` đến ${dest}` : "";
  if (state === 0) return "Chờ điều phối";
  if (state === 5) return "Chờ tới giờ hẹn";
  if (state === 1) return "Giao Nhận Mẫu đang đến lấy";
  if (state === 2) return `Đang giao${to}`;
  if (state === 4) return "Đã từ chối";
  return "Đã giao";
}

function initial(name?: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1][0].toUpperCase() : "?";
}

// Whose work a trip is: samples leaving this branch, or a client's samples coming in.
// Both directions share the feed and are otherwise indistinguishable at a glance.
// Styles live in a lookup rather than an inline ternary so each pairing is one complete
// unit — sky-800/sky-100 is 6.6:1, violet-700/violet-100 is 6.0:1. Outbound is sky rather
// than the state chips' blue-700/blue-100 so the two never read as the same badge; they
// sit on the same row and mean entirely different things.
const DIRECTION_STYLE = {
  out: "bg-sky-100 text-sky-800",
  in: "bg-violet-100 text-violet-700",
} as const;

function DirectionTag({ outbound }: { outbound: boolean }) {
  const Icon = outbound ? ArrowUp : ArrowDown;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-md ${outbound ? DIRECTION_STYLE.out : DIRECTION_STYLE.in}`}>
      <Icon aria-hidden className="w-3 h-3" />
      {outbound ? "Gửi đi" : "Nhận về"}
    </span>
  );
}

/* ─────────────────────────── progress stepper ─────────────────────────── */

function Stepper({ job, state }: { job: Job; state: TripState }) {
  const p = pickupOf(job), d = dropoffOf(job);
  const times = [requestedAt(job), fmtTs(p?.activity_completed_ts), fmtTs(d?.activity_started_ts), fmtTs(d?.activity_completed_ts)];
  // Steps completed so far; the "current" step pulses.
  const doneUpto = state === 2 ? 1 : state === 3 ? 3 : 0;
  const nowIdx = state === 3 ? -1 : isWaiting(state) ? 0 : state === 1 ? 1 : 2;

  return (
    <div className="flex items-start mt-1 mb-1">
      {STEPS.map((label, i) => {
        const done = state === 3 || i <= doneUpto;
        const current = i === nowIdx;
        return (
          <div key={label} className="flex-1 flex flex-col items-center relative">
            {i > 0 && (
              <span
                aria-hidden
                className={`absolute top-[5px] -left-1/2 w-full h-[3px] ${done || current ? "bg-green-600" : "bg-slate-200"}`}
              />
            )}
            <span
              aria-hidden
              className={`relative z-10 w-3.5 h-3.5 rounded-full border-[3px] ${
                done ? "bg-green-600 border-green-600"
                  : current ? "bg-white border-blue-600 animate-pulse"
                  : "bg-slate-200 border-slate-200"
              }`}
            />
            <span className={`mt-1.5 text-[10px] font-semibold leading-tight text-center ${
              done ? "text-green-700" : current ? "text-blue-700" : "text-slate-500"
            }`}>
              {label}
            </span>
            {times[i] && <span className="text-[10px] font-bold tabular-nums text-slate-500">{times[i]}</span>}
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────────────────── detail sheet ─────────────────────────── */
// Photos and Timeline live in src/components/trip-sheet.tsx, shared with /psc-tinh.

// Chain of custody, oldest first. Each leg contributes a completed event when it has a
// timestamp, the live event when it's the stop in progress, and a greyed placeholder
// otherwise — so the branch always sees the full shape of the trip.
function buildEvents(
  job: Job, state: TripState,
  p: Stop | undefined, d: Stop | undefined,
  pTodos: NonNullable<Stop["todos"]>, dTodos: NonNullable<Stop["todos"]>, threePl = false,
): TlEvent[] {
  const destName = placeLabel(d?.customer_name ?? "");
  const addr = (s?: Stop | null) =>
    s?.address_line_1 ? <p className="text-xs text-slate-500 mt-0.5 leading-snug">{s.address_line_1}</p> : undefined;
  const win = windowLabel(p);

  const ev: TlEvent[] = [{
    tone: "done", time: requestedAt(job), label: "Yêu cầu được tạo",
    body: (
      <>
        <p className="text-xs text-slate-500 mt-0.5">Từ {placeLabel(p?.customer_name ?? "")}</p>
        {win && <p className="text-xs font-semibold text-amber-700 mt-0.5">Khung giờ hẹn lấy: {win}</p>}
      </>
    ),
  }];

  // A 3PL handoff has no Diag driver and no delivery leg — Cartrack closes both stops at
  // the same instant on submission. Walking the four-step journey would invent a pickup
  // run and a drive to the destination that never happened, so it collapses to the fact.
  if (threePl) {
    ev.push({
      tone: "done",
      time: fmtTs(d?.activity_completed_ts ?? p?.activity_completed_ts),
      label: `Đã gửi qua ${THREE_PL_LABEL}`,
      body: (
        <p className="text-xs text-slate-500 mt-0.5">
          Mẫu bàn giao cho đơn vị giao ngoài để chuyển đến {destName}.
        </p>
      ),
    });
    return ev;
  }

  if (p?.activity_started_ts) ev.push({ tone: "done", time: fmtTs(p.activity_started_ts), label: "Giao Nhận Mẫu bắt đầu đi lấy mẫu" });
  else if (state === 5) ev.push({ tone: "now", label: "Chờ tới giờ hẹn lấy mẫu…" });
  else ev.push({ tone: state === 0 ? "now" : "future", label: state === 0 ? "Đang chờ điều phối Giao Nhận Mẫu…" : "Giao Nhận Mẫu đi lấy mẫu" });

  if (p?.activity_arrived_ts) ev.push({ tone: "done", time: fmtTs(p.activity_arrived_ts), label: "Đến điểm lấy mẫu", body: addr(p) });
  else if (state === 1) ev.push({ tone: "now", label: "Đang đến điểm lấy mẫu", body: addr(p) });

  if (p?.activity_completed_ts) ev.push({ tone: "done", time: fmtTs(p.activity_completed_ts), label: "Lấy mẫu xong", body: pTodos.length ? <Photos todos={pTodos} /> : undefined });
  else ev.push({ tone: "future", label: "Lấy mẫu" });

  if (d?.activity_started_ts) ev.push({ tone: "done", time: fmtTs(d.activity_started_ts), label: `Bắt đầu giao đến ${destName}` });
  else ev.push({ tone: "future", label: `Giao đến ${destName}` });

  if (d?.activity_arrived_ts) ev.push({ tone: "done", time: fmtTs(d.activity_arrived_ts), label: `Đến ${destName}`, body: addr(d) });
  else if (state === 2) ev.push({ tone: "now", label: `Đang trên đường đến ${destName}`, body: addr(d) });

  if (d?.activity_completed_ts) ev.push({ tone: "done", time: fmtTs(d.activity_completed_ts), label: "Bàn giao hoàn tất", body: dTodos.length ? <Photos todos={dTodos} /> : undefined });
  else ev.push({ tone: "future", label: `Bàn giao tại ${destName}` });

  return ev;
}

function JobSheet({ job, onClose }: { job: Job; onClose: () => void }) {
  const [detail, setDetail] = useState<Job | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);

  // The list payload already carries route, addresses, timings and batch codes, so the
  // sheet renders instantly; only the POD photos and the driver's phone need fetching,
  // and that call takes a few seconds — hence the separate loading hint.
  useEffect(() => {
    let alive = true;
    fetch(`/api/location-jobs?job_id=${job.job_id}`)
      .then((r) => r.json())
      .then((d) => { if (alive && d.job) setDetail(d.job); })
      .catch(() => {})
      .finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [job.job_id]);

  const shown: Job = detail ? { ...detail, stops: detail.stops } : job;
  const p = pickupOf(shown), d = dropoffOf(shown);
  const state = stateOf(shown);
  const destName = placeLabel(d?.customer_name ?? "");
  const batches = shown.item_tracking_numbers ?? [];
  const threePl = isThreePl(shown.driver?.last_name);
  const parked = isParked(shown.driver?.last_name);
  // Proxy accounts carry a phone number that belongs to Diag's own parking/handoff
  // account — a branch calling it reaches nobody, so it is never offered.
  const phone = parked || threePl ? null : detail?.driver?.phone_local;
  const phoneE164 = detail?.driver?.phone_e164;
  const driver = driverText(shown.driver?.last_name);

  const pTodos = (p?.todos ?? []).filter((t) => TODO_ICON[t.todo_type_id]);
  const dTodos = (d?.todos ?? []).filter((t) => TODO_ICON[t.todo_type_id]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Chi tiết chuyến"
        className="w-full max-w-sm bg-white rounded-t-[20px] max-h-[86vh] overflow-y-auto px-5 pt-2.5 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div aria-hidden className="w-10 h-1 rounded-full bg-slate-200 mx-auto mt-1 mb-3.5" />

        <div className="flex items-center justify-between gap-2.5">
          <p className="text-lg font-extrabold tracking-tight text-slate-800">
            {placeLabel(p?.customer_name ?? "")} <ArrowRight aria-hidden className="inline w-4 h-4 text-slate-500 mx-0.5 shrink-0" /> {placeLabel(d?.customer_name ?? "")}
          </p>
          <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${STATE_STYLE[state]}`}>
            {stateText(state, destName)}
          </span>
        </div>

        <div className="flex items-center gap-2.5 mt-3.5 p-3 bg-slate-100 rounded-2xl">
          <span aria-hidden className="w-9 h-9 flex-none rounded-full bg-blue-100 text-blue-700 font-extrabold text-sm flex items-center justify-center">
            {threePl ? <Bike aria-hidden className="w-4 h-4" /> : parked ? <Clock aria-hidden className="w-4 h-4" /> : initial(driver)}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-slate-800">{parked ? "Chưa có Giao Nhận Mẫu" : driver}</p>
            {phone ? (
              <div className="flex items-center gap-3 mt-0.5">
                <a href={`tel:${phoneE164}`} className="inline-flex items-center gap-1.5 text-sm font-bold text-green-700 active:opacity-70"><Phone aria-hidden className="w-3.5 h-3.5" />{phone}</a>
                <a href={`https://zalo.me/${phoneE164?.replace("+", "")}`} target="_blank" rel="noopener noreferrer"
                   className="text-xs font-extrabold text-[#0068ff] bg-blue-50 rounded-lg px-2 py-0.5">Zalo</a>
              </div>
            ) : (
              <p className="text-[11px] text-slate-500">
                {threePl ? "Đơn vị giao ngoài" : parked ? "Chuyến đã đặt lịch, chờ tới giờ hẹn" : "Giao Nhận Mẫu Diag"}
              </p>
            )}
          </div>
        </div>

        {batches.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mt-3">
            <span className="text-[10px] font-bold text-slate-500 uppercase">Mã batch</span>
            {batches.map((b) => (
              <span key={b} className="text-[11px] font-mono font-semibold bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded-md break-all">{b}</span>
            ))}
          </div>
        )}

        <Timeline events={buildEvents(shown, state, p, d, pTodos, dTodos, threePl)} />

        {detailLoading && !detail && (
          <p className="text-[11px] text-slate-500 text-center">Đang tải ảnh giao nhận và số điện thoại Giao Nhận Mẫu…</p>
        )}

        <p className="text-[10px] text-slate-500 text-center break-all mt-1">{shown.reference_number}</p>

        <button onClick={onClose} className="w-full mt-4 py-3 rounded-xl text-sm font-semibold border border-slate-200 text-slate-600 active:bg-slate-50">
          Đóng
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────── feed cards ─────────────────────────── */

function TripCard({ job, code, onOpen, onCancel, onSendVia3pl, onChangeDriver }: {
  job: Job;
  code: string;
  onOpen: () => void;
  onCancel: (t: { job_id: number; reference: string }) => void;
  onSendVia3pl: (t: { job_id: number; reference: string }) => void;
  onChangeDriver: (t: { job_id: number; reference: string }) => void;
}) {
  const state = stateOf(job);
  const p = pickupOf(job), d = dropoffOf(job);
  const destName = placeLabel(d?.customer_name ?? "");
  const threePl = isThreePl(job.driver?.last_name);
  const driver = driverText(job.driver?.last_name);
  const win = windowLabel(p);
  // Whose work this is: samples leaving this branch, or a client's samples coming in.
  // Both directions sit in the same feed and used to look identical.
  const outbound = p?.customer_id === code;

  // A rejected trip is already closed — there is nothing left to cancel or hand off.
  const rejected = state === 4;
  // Cancellable only while this location's own pickup is untouched.
  const cancellable = !rejected && !!p && p.customer_id === code && p.stop_status_id === 1 &&
    !p.activity_started_ts && !p.activity_arrived_ts && !p.activity_completed_ts;
  // 3PL handoff stays open until the sample is actually collected.
  const via3plEligible = !rejected && !!p && p.customer_id === code && !p.activity_completed_ts && p.stop_status_id !== 5;
  // Changing hands stays open exactly as long as the 3PL handoff does — right up until
  // the samples are collected. That window is the point: a branch usually discovers the
  // assigned driver is not coming AFTER the trip has already been dispatched to them.
  const changeDriverEligible = via3plEligible;

  const target = { job_id: job.job_id, reference: job.reference_number };

  return (
    <div className="rounded-2xl bg-white shadow-sm border border-slate-100 p-4">
      <button onClick={onOpen} className="w-full text-left active:opacity-70">
        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0">
            <p className="text-base font-extrabold tracking-tight text-slate-800">
              {placeLabel(p?.customer_name ?? "")} <ArrowRight aria-hidden className="inline w-4 h-4 text-slate-500 mx-0.5 shrink-0" /> {destName}
            </p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
              <DirectionTag outbound={outbound} />
              <span className="text-[11px] font-semibold text-slate-500">Yêu cầu lúc {requestedAt(job) ?? "—"}</span>
              {win && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700">
                  <Clock aria-hidden className="w-3 h-3" />Hẹn {win}
                </span>
              )}
            </div>
          </div>
          <span className={`flex-none text-[11px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${STATE_STYLE[state]}`}>
            {threePl ? "Đã gửi qua đối tác" : stateText(state, destName)}
          </span>
        </div>

        {threePl ? (
          <p className="flex items-center gap-1.5 mt-2.5 text-[13px] font-semibold text-teal-700">
            <Bike aria-hidden className="w-4 h-4 shrink-0" />Đã gửi qua {THREE_PL_LABEL} lúc {fmtTs(d?.activity_completed_ts ?? p?.activity_completed_ts) ?? "—"}
          </p>
        ) : state === 4 ? (
          // A rejected trip never progressed, so the four-step bar would be a lie. The
          // reason the driver gave is the only thing worth showing.
          <div className="mt-2.5 rounded-xl bg-red-50 border border-red-200 p-3">
            <p className="flex items-start gap-1.5 text-[13px] font-semibold text-red-700">
              <XCircle aria-hidden className="w-4 h-4 shrink-0 mt-px" />
              <span>
                Đã từ chối{fmtTs(job.rejected_ts) ? ` lúc ${fmtTs(job.rejected_ts)}` : ""}
                {job.rejected_reason ? ` — ${job.rejected_reason}` : ""}
              </span>
            </p>
          </div>
        ) : (
          <Stepper job={job} state={state} />
        )}

        {isWaiting(state) ? (
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-100 text-[13px] font-semibold text-amber-700">
            <Clock aria-hidden className="w-4 h-4 shrink-0" />
            {state === 5 ? "Đã đặt lịch, chờ tới giờ hẹn lấy mẫu" : "Đang chờ điều phối Giao Nhận Mẫu"}
          </div>
        ) : state === 4 ? null : !threePl && (
          <div className="flex items-center gap-2.5 mt-3 pt-3 border-t border-slate-100">
            <span aria-hidden className="w-8 h-8 flex-none rounded-full bg-blue-100 text-blue-700 font-extrabold text-xs flex items-center justify-center">
              {initial(driver)}
            </span>
            <span className="flex-1 min-w-0 text-sm font-bold text-slate-800">{driver}</span>
            <ChevronRight aria-hidden className="w-4 h-4 text-slate-400 shrink-0" />
          </div>
        )}
      </button>

      {(via3plEligible || cancellable || changeDriverEligible) && (
        <div className="space-y-1.5 mt-3">
          {changeDriverEligible && (
            <button onClick={() => onChangeDriver(target)}
              className="w-full py-2.5 rounded-xl text-xs font-bold text-blue-700 border border-blue-200 active:bg-blue-50">
              Đổi Giao Nhận Mẫu đang ở đây
            </button>
          )}
          {via3plEligible && (
            <button onClick={() => onSendVia3pl(target)}
              className="w-full py-2.5 rounded-xl text-xs font-bold text-white bg-teal-600 active:bg-teal-800">
              Gửi mẫu qua Grab/Be/XanhSM/Ahamove
            </button>
          )}
          {cancellable && (
            <button onClick={() => onCancel(target)}
              className="w-full py-2.5 rounded-xl text-xs font-bold text-red-600 border border-red-200 active:bg-red-50">
              Huỷ chuyến
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PendingCard({ req, onCancel, onSendVia3pl }: {
  req: PendingReq;
  onCancel: (t: { job_id: number; reference: string }) => void;
  onSendVia3pl: (t: { job_id: number; reference: string }) => void;
}) {
  const target = { job_id: req.job_id, reference: req.reference };
  const [from, to] = req.reference.split("_")[0].split("→");
  return (
    <div className="rounded-2xl bg-white shadow-sm border border-amber-200 p-4">
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <p className="text-base font-extrabold tracking-tight text-slate-800">
            {from} <ArrowRight aria-hidden className="inline w-4 h-4 text-slate-500 mx-0.5 shrink-0" /> {to}
          </p>
          <p className="text-[11px] font-semibold text-slate-500 mt-0.5">Yêu cầu lúc {req.created_ts}</p>
        </div>
        <span className={`flex-none text-[11px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${STATE_STYLE[0]}`}>
          {stateText(0)}
        </span>
      </div>
      {req.driver_name ? (
        <div className="flex items-center gap-2.5 mt-3 pt-3 border-t border-slate-100">
          <span aria-hidden className="w-8 h-8 flex-none rounded-full bg-blue-100 text-blue-700 font-extrabold text-xs flex items-center justify-center">
            {initial(driverText(req.driver_name))}
          </span>
          <span className="flex-1 min-w-0 text-sm font-bold text-slate-800 truncate">{driverText(req.driver_name)}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-100 text-[13px] font-semibold text-amber-700">
        <Clock aria-hidden className="w-4 h-4 shrink-0" />Đã gửi lúc {req.created_ts} — đang chờ điều phối Giao Nhận Mẫu
        </div>
      )}
      <div className="space-y-1.5 mt-3">
        <button onClick={() => onSendVia3pl(target)}
          className="w-full py-2.5 rounded-xl text-xs font-bold text-white bg-teal-600 active:bg-teal-800">
          Gửi mẫu qua Grab/Be/XanhSM/Ahamove
        </button>
        <button onClick={() => onCancel(target)}
          className="w-full py-2.5 rounded-xl text-xs font-bold text-red-600 border border-red-200 active:bg-red-50">
          Huỷ yêu cầu
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────── page ─────────────────────────── */

export default function QrPage() {
  const params = useParams<{ code: string }>();
  const code = decodeURIComponent(params.code ?? "").trim();

  const route = useMemo(() => PSC_ROUTES.find((r) => r.pickup === code) ?? null, [code]);

  const [assignStatus, setAssignStatus] = useState<Status>("idle");
  const [assignError, setAssignError] = useState("");

  const [date, setDate] = useState(todayVN());
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  // Whether the feed has been fetched at all. Distinct from `loading`, and load-bearing:
  // the page no longer fetches on mount, so without this an unread feed would render
  // "Chưa có chuyến nào đang chạy" — telling a branch no driver is coming when we simply
  // have not looked. That is the sentence most likely to make them request a second
  // pickup for a trip already on its way.
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<PendingReq[]>([]);

  const [sheetJob, setSheetJob] = useState<Job | null>(null);
  // Open by default: the completed list is the branch's record of its own day, and
  // collapsing it hid the thing most staff open this page to check.
  const [doneOpen, setDoneOpen] = useState(true);
  const [doneQuery, setDoneQuery] = useState("");
  const [datePanel, setDatePanel] = useState(false);

  const [cancelTarget, setCancelTarget] = useState<{ job_id: number; reference: string } | null>(null);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState("");

  const [via3plTarget, setVia3plTarget] = useState<{ job_id: number; reference: string } | null>(null);
  const [via3plLoading, setVia3plLoading] = useState(false);
  const [via3plError, setVia3plError] = useState("");
  const [batchInput, setBatchInput] = useState("");

  // Change-driver: the branch's escape hatch for the trips configuration cannot describe.
  // The list is fetched fresh every time it opens — who is standing at the door is the one
  // thing that must never come from a cache.
  const [changeTarget, setChangeTarget] = useState<{ job_id: number; reference: string } | null>(null);
  const [changeList, setChangeList] = useState<{ driverId: string; name: string; metres: number }[]>([]);
  const [changeLoading, setChangeLoading] = useState(false);
  const [changeBusyId, setChangeBusyId] = useState("");
  const [changeError, setChangeError] = useState("");

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3200);
  };

  const pendingKey = `qr-pending:${code}`;

  // Restore this device's not-yet-dispatched requests, dropping any from earlier days.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(pendingKey);
      if (!raw) return;
      const today = todayVN();
      setPending((JSON.parse(raw) as PendingReq[]).filter((p) => p.date === today));
    } catch {}
  }, [pendingKey]);

  const persistPending = useCallback((next: PendingReq[]) => {
    setPending(next);
    try { localStorage.setItem(pendingKey, JSON.stringify(next)); } catch {}
  }, [pendingKey]);

  // When the feed last reached the server, so a refresh can be skipped while the answer
  // is guaranteed unchanged. A ref, not state: reading it must not re-render the feed.
  const lastLoadRef = useRef(0);

  // Never asks for fresh=1. Every read this page makes is happy with the day the assign
  // cycle publishes each time it runs — and the moments that genuinely need to reflect a
  // change (booking, cancelling, handing to a 3PL) are now served from that action's own
  // response, which is both faster and more truthful than re-reading a Cartrack listing
  // that may not have indexed the change yet.
  const loadJobs = useCallback(async () => {
    lastLoadRef.current = Date.now();
    setLoading(true);
    try {
      const res = await fetch(`/api/location-jobs?date=${date}&status=all&code=${encodeURIComponent(code)}`);
      const data = await res.json();
      const list: Job[] = (data.jobs ?? [])
        .filter((j: Job) => (j.stops ?? []).length > 1)
        // Plan slots regenerate daily; the unfinished ones are noise, not real trips.
        .filter((j: Job) => j.last_assigned_plan_id == null || j.job_status_id === 5)
        // Rejections are a dispatch matter, not the branch's: a rejected trip is
        // re-created or re-routed by the team, and surfacing it here only prompts
        // calls about a trip the branch cannot act on. /psc-tinh still shows them —
        // there the branch owns the 3PL handoff and does need to know.
        .filter((j: Job) => j.job_status_id !== 3);
      list.sort((a, b) => {
        const t = (j: Job) => j.stops.map((s) => s.activity_completed_ts ?? s.activity_arrived_ts ?? s.activity_started_ts).filter(Boolean).sort().at(-1) ?? "";
        return t(b).localeCompare(t(a));
      });
      setJobs(list);
    } catch {
      setJobs([]);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [date, code]);

  // No fetch on mount. Opening /qr is not by itself a request to read the day — most
  // visits are a branch scanning the QR to CALL a pickup, and every one of those was
  // paying a full snapshot read for a list nobody looked at. Submitting reloads the feed
  // anyway, so it fills in exactly when it starts to matter.
  // Changing the DATE is explicit intent and still loads, which is why this effect stays
  // rather than being deleted: loadJobs is keyed on [date, code], so it re-runs only when
  // the branch picks a different day.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    loadJobs();
  }, [loadJobs]);

  // Refresh when the branch comes BACK to the feed, not on a timer. A 60s interval meant
  // every open tab re-fetched the day forever whether or not anyone was looking, and 42
  // branches doing that is what set the floor on how often the whole network's day had to
  // be rebuilt. Tying it to attention instead means the rebuild rate follows real usage.
  // Freshness doesn't suffer: the day snapshot rebuilds if it's older than 30s, so
  // looking at the feed shows a state at most half a minute old — where the old interval
  // could serve a 90s-old cache. Làm mới and the post-action reloads still force a rebuild.
  //
  // The 30s floor is what keeps this cheaper than the timer it replaced, and it is not
  // optional. Branch staff work from a phone and flip constantly between Zalo and the
  // feed, so returning to the tab is a FAR more frequent event than a 60s tick — the
  // more so because a backgrounded tab's timers are throttled or frozen outright, which
  // made the old poll near-free while nobody was looking. Some Android browsers also
  // fire this when the soft keyboard opens over the request form. Unthrottled, that is
  // a request per app-switch. Below 30s the snapshot has not rebuilt, so the answer is
  // byte-for-byte the one already on screen: skipping costs the branch nothing.
  useEffect(() => {
    if (date !== todayVN()) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastLoadRef.current < MIN_REFRESH_MS) return;
      loadJobs();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [date, loadJobs]);

  // A pending request that now appears on a driver's route has been dispatched —
  // the fetched job takes over and the local placeholder retires.
  useEffect(() => {
    if (!pending.length || !jobs.length) return;
    const known = new Set(jobs.map((j) => j.job_id));
    const still = pending.filter((p) => !known.has(p.job_id));
    if (still.length !== pending.length) persistPending(still);
  }, [jobs, pending, persistPending]);

  const handleAssign = async () => {
    if (!route) return;
    setAssignStatus("loading");
    setAssignError("");
    try {
      const res = await fetch(`/api/psc-assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          psc_pickup: route.psc_pickup,
          dropoff_location: route.dropoff_location,
          pickup: route.pickup,
          dropoff: route.dropoff,
          ref_number: route.ref_number,
          via_pickup: route.via_pickup,
          via_pickup_name: route.via_pickup_name,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setAssignStatus("success");
        if (data.job_id) {
          persistPending([
            { job_id: data.job_id, reference: data.reference, created_ts: nowHm(), date: todayVN() },
            ...pending,
          ]);
          // The driver lands on this trip a few seconds from now. Ask, so the branch sees
          // a name instead of "waiting for dispatch" while somebody is already riding over.
          watchForDriver(data.job_id);
        }
        showToast("Đã gửi yêu cầu lấy mẫu", true);
        setTimeout(() => setAssignStatus("idle"), 3500);
        // No reload. The response already carries job_id and reference, and the pending
        // placeholder above renders the new trip immediately — re-reading the whole
        // network's day would only fetch back what we just put on screen, and Cartrack
        // often has not indexed the job yet anyway, so it could come back WITHOUT it.
        // The placeholder retires itself once the job appears on a driver's route.
      } else if (res.status === 409) {
        setAssignStatus("error");
        const hhmm = /(\d{2}:\d{2})$/.exec(data.reference_number ?? "")?.[1];
        setAssignError(
          data.job_id
            ? `Đã có yêu cầu được tạo lúc ${hhmm ?? "trước đó"} vẫn chưa rời chi nhánh, vui lòng chờ thêm hoặc liên hệ đội điều phối. Xin cám ơn!`
            : (data.message ?? "Đang xử lý yêu cầu, vui lòng đợi.")
        );
      } else {
        setAssignStatus("error");
        setAssignError(data.error || "Không tạo được yêu cầu. Vui lòng thử lại.");
      }
    } catch {
      setAssignStatus("error");
      setAssignError("Không thể kết nối. Vui lòng thử lại.");
    }
  };

  const handleCancel = async () => {
    if (!cancelTarget) return;
    setCancelLoading(true);
    setCancelError("");
    try {
      const res = await fetch(`/api/psc-assign?job_id=${cancelTarget.job_id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setCancelError(data.error ?? "Huỷ thất bại");
        return;
      }
      const cancelledId = cancelTarget.job_id;
      persistPending(pending.filter((p) => p.job_id !== cancelledId));
      // Drop it locally instead of reloading. A cancelled job (status 7) is not one of the
      // statuses this feed shows, so removing it here produces exactly the list a reload
      // would have returned — for the cost of a state update rather than a day rebuild.
      setJobs((js) => js.filter((j) => j.job_id !== cancelledId));
      setCancelTarget(null);
      showToast("Đã huỷ chuyến thành công.", true);
    } catch {
      setCancelError("Không thể kết nối. Vui lòng thử lại.");
    } finally {
      setCancelLoading(false);
    }
  };

  const openVia3pl = (t: { job_id: number; reference: string }) => {
    setVia3plTarget(t);
    setVia3plError("");
    setBatchInput("");
  };

  /** The trip was just created; the driver lands on it a few seconds later. Ask twice,
   *  then stop — this is a courtesy update, and the feed corrects everything anyway once
   *  the day rebuilds. Deliberately not a poll loop: 40-odd branches quietly retrying
   *  forever is how a free Redis tier gets spent. */
  const watchForDriver = (jobId: number) => {
    let tries = 0;
    const ask = async () => {
      tries++;
      try {
        const res = await fetch(`/api/psc-assign?job_id=${jobId}`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (data?.driver_name) {
          setPending((ps) => ps.map((p) => (p.job_id === jobId ? { ...p, driver_name: data.driver_name } : p)));
          return;
        }
      } catch { /* a courtesy update that failed is not worth telling anyone about */ }
      if (tries < 2) setTimeout(ask, 6000);
    };
    setTimeout(ask, 4000);
  };

  const openChangeDriver = async (t: { job_id: number; reference: string }) => {
    setChangeTarget(t);
    setChangeList([]);
    setChangeError("");
    setChangeLoading(true);
    try {
      const res = await fetch("/api/psc-assign/reassign?job_id=" + t.job_id, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setChangeError(data.error ?? "Không tải được danh sách"); return; }
      setChangeList(data.drivers ?? []);
    } catch {
      setChangeError("Không thể kết nối. Vui lòng thử lại.");
    } finally {
      setChangeLoading(false);
    }
  };

  const handleChangeDriver = async (driverId: string, name: string) => {
    if (!changeTarget) return;
    setChangeBusyId(driverId);
    setChangeError("");
    try {
      const res = await fetch("/api/psc-assign/reassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: changeTarget.job_id, driver_id: driverId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setChangeError(data.error ?? "Đổi thất bại"); return; }
      setChangeTarget(null);
      showToast("Đã chuyển chuyến cho " + (data.driver_name ?? name) + ".", true);
      // The feed is the authority on who holds a trip. Reload rather than patch the row
      // locally: this name is the one the branch will go and physically hand a box to.
      loadJobs();
    } catch {
      setChangeError("Không thể kết nối. Vui lòng thử lại.");
    } finally {
      setChangeBusyId("");
    }
  };

  const handleSendVia3pl = async () => {
    if (!via3plTarget) return;
    const batchIds = batchInput.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (batchIds.length === 0) {
      setVia3plError("Vui lòng nhập ít nhất một mã Batch.");
      return;
    }
    const invalid = batchIds.filter((b) => !/^B\d+$/.test(b));
    if (invalid.length > 0) {
      setVia3plError(`Mã Batch không hợp lệ (phải dạng B + số): ${invalid.join(", ")}`);
      return;
    }
    setVia3plLoading(true);
    setVia3plError("");
    try {
      const res = await fetch(`/api/psc-assign`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: via3plTarget.job_id, batch_ids: batchIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setVia3plError(data.error ?? "Gửi thất bại");
        return;
      }
      const handedId = via3plTarget.job_id;
      persistPending(pending.filter((p) => p.job_id !== handedId));
      // The response carries the trip as it now stands — 3PL driver attached, completed,
      // with the real completion time the "Đã gửi qua…" line prints. Patch it in rather
      // than rebuilding the day to learn about one job. If the server's read-back failed
      // (`job` null) leave the row alone; the next feed load corrects it, and claiming the
      // handoff failed would be worse than showing it a few minutes late.
      if (data.job) {
        setJobs((js) => js.map((j) => (j.job_id === handedId ? { ...j, ...data.job } : j)));
      }
      setVia3plTarget(null);
      setBatchInput("");
      showToast("Đã gửi mẫu qua Grab/Be/XanhSM/Ahamove thành công.", true);
    } catch {
      setVia3plError("Không thể kết nối. Vui lòng thử lại.");
    } finally {
      setVia3plLoading(false);
    }
  };

  if (!route) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow p-6 text-center">
          <p className="text-lg font-bold text-red-600">Không tìm thấy địa điểm</p>
          <p className="text-sm text-slate-500 mt-1">Không có tuyến PSC nào cho mã <strong>{code}</strong>.</p>
        </div>
      </div>
    );
  }

  const active = jobs.filter((j) => stateOf(j) !== 3);
  const done = jobs.filter((j) => stateOf(j) === 3);
  const q = norm(doneQuery);
  const doneShown = q
    ? done.filter((j) => norm(`${j.stops.map((s) => s.customer_name).join(" ")} ${j.driver?.last_name ?? ""} ${(j.item_tracking_numbers ?? []).join(" ")}`).includes(q))
    : done;

  const isToday = date === todayVN();

  return (
    <div className="min-h-screen bg-slate-100 flex justify-center">
      <div className="w-full max-w-[430px] px-4 pb-12">

        <header className="pt-5 pb-3.5 px-1">
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">{route.psc_pickup}</h1>
          <p className="text-sm text-slate-500 mt-0.5">Điểm đến: {route.dropoff_location}</p>
        </header>

        {!route.no_request && (
          <div className="bg-white rounded-2xl shadow-sm p-4 mb-5">
            <button
              onClick={handleAssign}
              disabled={assignStatus === "loading" || assignStatus === "success"}
              className={`w-full rounded-2xl py-4 text-white text-lg font-extrabold flex items-center justify-center gap-2.5 active:scale-[.97] transition disabled:opacity-70 ${
                assignStatus === "success" ? "bg-green-600" : "bg-blue-700"
              }`}
            >
              {assignStatus === "loading" ? (
                <>
                  <Loader2 aria-hidden className="w-5 h-5 animate-spin" />
                  Đang gửi…
                </>
              ) : assignStatus === "success"
                ? <><Check aria-hidden className="w-5 h-5" />Đã gửi yêu cầu</>
                : <><Package aria-hidden className="w-5 h-5" />Đề Nghị Giao Mẫu</>}
            </button>
            {assignStatus === "error" && (
              <p role="alert" className="mt-3 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">{assignError}</p>
            )}
          </div>
        )}

        {/* The date scopes everything below it, so it sits above the feed rather than at the
            foot of a long completed list where it read as unrelated.

            There is no Làm mới button. It was the single most expensive control in the app:
            every tap forced a full rebuild of the whole network's day — and once the assign
            cycle began publishing that day every ~3 minutes, nearly all of those taps were
            re-fetching something already current. The feed reloads on its own when the
            branch returns to the tab, and every action they take (booking, cancelling,
            handing to a 3PL) reloads it immediately — which is when they actually want to
            see a change. */}
        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={() => setDatePanel((v) => !v)}
            aria-expanded={datePanel}
            className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-semibold text-slate-600 bg-white shadow-sm active:bg-slate-50"
          >
            <CalendarDays aria-hidden className="w-4 h-4" />
            {isToday ? "Hôm nay" : date}
            <ChevronDown aria-hidden className={`w-4 h-4 text-slate-500 transition-transform ${datePanel ? "rotate-180" : ""}`} />
          </button>
        </div>

        {datePanel && (
          <div className="bg-white rounded-2xl shadow-sm p-4 mb-3">
            <input
              type="date"
              value={date}
              max={todayVN()}
              onChange={(e) => setDate(e.target.value)}
              aria-label="Chọn ngày"
              className="w-full border border-slate-200 rounded-xl px-3 py-3 text-base"
            />
          </div>
        )}

        <div className="space-y-3">
          {pending.map((p) => (
            <PendingCard key={p.job_id} req={p} onCancel={(t) => { setCancelTarget(t); setCancelError(""); }} onSendVia3pl={openVia3pl} />
          ))}
          {active.map((j) => (
            <TripCard key={j.job_id} job={j} code={code} onOpen={() => setSheetJob(j)}
              onCancel={(t) => { setCancelTarget(t); setCancelError(""); }} onSendVia3pl={openVia3pl}
              onChangeDriver={openChangeDriver} />
          ))}
          {!loaded && !loading && (
            <button
              onClick={() => loadJobs()}
              className="w-full py-7 rounded-2xl bg-white shadow-sm text-sm font-semibold text-blue-700 active:bg-slate-50"
            >
              Xem danh sách chuyến
            </button>
          )}
          {loaded && !loading && !pending.length && !active.length && (
            <p className="text-center text-sm text-slate-500 py-7">
              {isToday ? <>Chưa có chuyến nào đang chạy.{!route.no_request && <><br />Bấm nút phía trên để gọi Giao Nhận Mẫu.</>}</> : "Không có chuyến đang chạy."}
            </p>
          )}
          {loading && <p className="text-center text-sm text-slate-500 py-7">Đang tải…</p>}
        </div>

        <div className="bg-white rounded-2xl shadow-sm mt-3 overflow-hidden">
          <button onClick={() => { setDoneOpen((v) => !v); if (!loaded) loadJobs(); }} aria-expanded={doneOpen}
            className="w-full flex items-center justify-between px-4 py-3.5 text-[15px] font-bold text-slate-800">
            {/* The count is omitted until the feed has been read — "(0)" before we have
                looked reads as "nothing was delivered today", which is a different claim. */}
            <span className="flex items-center gap-2"><Check aria-hidden className="w-4 h-4 text-green-600" />Xong {isToday ? "hôm nay" : ""} {loaded && <span className="text-green-600">({done.length})</span>}</span>
            <ChevronDown aria-hidden className={`w-5 h-5 text-slate-500 transition-transform ${doneOpen ? "rotate-180" : ""}`} />
          </button>
          {doneOpen && (
            <div className="border-t border-slate-100">
              <div className="px-4 pt-3 pb-1">
                <div className="relative">
                  <Search aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
                <input
                  type="search"
                  value={doneQuery}
                  onChange={(e) => setDoneQuery(e.target.value)}
                  placeholder="Tìm địa điểm, Giao Nhận Mẫu, mã batch…"
                  aria-label="Tìm trong chuyến đã xong"
                  className="w-full bg-slate-100 rounded-xl pl-9 pr-3 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-300"
                />
                </div>
              </div>
              {doneShown.length === 0 ? (
                // This panel starts expanded, so it is on screen before the feed has been
                // read. "Chưa có chuyến nào hoàn thành" would then be asserting something
                // we have not checked; offer to look instead.
                !loaded && !loading && !doneQuery ? (
                  <button onClick={() => loadJobs()} className="w-full py-5 text-center text-sm font-semibold text-blue-700 active:bg-slate-50">
                    Xem chuyến đã xong
                  </button>
                ) : (
                  <p className="text-center text-sm text-slate-500 py-5">
                    {doneQuery ? `Không tìm thấy chuyến nào khớp “${doneQuery}”` : "Chưa có chuyến nào hoàn thành."}
                  </p>
                )
              ) : doneShown.map((j) => {
                const p = pickupOf(j), d = dropoffOf(j);
                const threePl = isThreePl(j.driver?.last_name);
                const outbound = p?.customer_id === code;
                return (
                  <button key={j.job_id} onClick={() => setSheetJob(j)}
                    aria-label={`Xem chi tiết chuyến ${placeLabel(p?.customer_name ?? "")} đến ${placeLabel(d?.customer_name ?? "")}`}
                    className="group w-full block px-4 py-3 border-t border-slate-100 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors">
                    <span className="flex items-start gap-2.5">
                      <Check aria-hidden className="w-4 h-4 text-green-600 shrink-0 mt-0.5" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-semibold text-slate-800">
                          {placeLabel(p?.customer_name ?? "")} <ArrowRight aria-hidden className="inline w-3.5 h-3.5 text-slate-500 mx-0.5 shrink-0" /> {placeLabel(d?.customer_name ?? "")}
                        </span>
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                          <DirectionTag outbound={outbound} />
                          <span className="text-[11px] text-slate-500">{driverText(j.driver?.last_name)}</span>
                          {windowLabel(p) && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700">
                              <Clock aria-hidden className="w-3 h-3" />Hẹn {windowLabel(p)}
                            </span>
                          )}
                        </span>
                      </span>
                      {/* These rows open the detail sheet, but read as static text without a
                          chevron — the same affordance the active cards already carry. */}
                      <ChevronRight aria-hidden className="w-4 h-4 text-slate-400 shrink-0 mt-0.5 group-hover:text-slate-600 transition-colors" />
                    </span>
                    {/* A finished trip's four timestamps are the useful part here — the old row
                        showed a bare "15:23 → 15:33" pair with nothing saying what it meant. */}
                    {threePl ? (
                      <span className="block mt-2 text-[12px] font-semibold text-teal-700">
                        Gửi qua {THREE_PL_LABEL} · {fmtTs(d?.activity_completed_ts ?? p?.activity_completed_ts) ?? "—"}
                      </span>
                    ) : (
                      <Stepper job={j} state={3} />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

      </div>

      {sheetJob && <JobSheet job={sheetJob} onClose={() => setSheetJob(null)} />}

      {cancelTarget && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-4"
          onClick={() => { if (!cancelLoading) { setCancelTarget(null); setCancelError(""); } }}>
          <div role="dialog" aria-modal="true" className="w-full max-w-sm bg-white rounded-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="space-y-1">
              <p className="text-base font-bold text-slate-800">Huỷ chuyến?</p>
              <p className="text-xs text-slate-500 font-semibold break-all">{cancelTarget.reference}</p>
              <p className="text-xs text-slate-500">Chỉ huỷ được khi Giao Nhận Mẫu chưa bắt đầu lấy mẫu. Hành động này không thể hoàn tác.</p>
            </div>
            {cancelError && <p role="alert" className="text-xs text-red-600 font-medium">{cancelError}</p>}
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => { setCancelTarget(null); setCancelError(""); }} disabled={cancelLoading}
                className="py-3 rounded-xl text-sm font-semibold border border-slate-200 text-slate-600 disabled:opacity-40">Quay lại</button>
              <button onClick={handleCancel} disabled={cancelLoading}
                className="py-3 rounded-xl text-sm font-bold bg-red-600 text-white disabled:opacity-40">
                {cancelLoading ? "Đang huỷ…" : "Xác nhận huỷ"}
              </button>
            </div>
          </div>
        </div>
      )}

      {via3plTarget && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-4"
          onClick={() => { if (!via3plLoading) { setVia3plTarget(null); setVia3plError(""); setBatchInput(""); } }}>
          <div role="dialog" aria-modal="true" className="w-full max-w-sm bg-white rounded-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="space-y-1">
              <p className="text-base font-bold text-slate-800">Gửi mẫu qua Grab/Be/XanhSM/Ahamove?</p>
              <p className="text-xs text-slate-500 font-semibold break-all">{via3plTarget.reference}</p>
              <p className="text-xs text-slate-500">Chuyến sẽ được gán cho Giao Nhận Mẫu và đánh dấu hoàn thành. Hành động này không thể hoàn tác.</p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="batch-input" className="block text-xs font-semibold text-slate-700">
                Mã Batch (mỗi dòng một mã, VD: B006260628101037)
              </label>
              <textarea id="batch-input" value={batchInput} onChange={(e) => setBatchInput(e.target.value)} rows={3}
                placeholder="B006260628101037"
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-teal-400 resize-none" />
            </div>
            {via3plError && <p role="alert" className="text-xs text-red-600 font-medium">{via3plError}</p>}
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => { setVia3plTarget(null); setVia3plError(""); setBatchInput(""); }} disabled={via3plLoading}
                className="py-3 rounded-xl text-sm font-semibold border border-slate-200 text-slate-600 disabled:opacity-40">Quay lại</button>
              <button onClick={handleSendVia3pl} disabled={via3plLoading}
                className="py-3 rounded-xl text-sm font-bold bg-teal-600 text-white disabled:opacity-40">
                {via3plLoading ? "Đang gửi…" : "Xác nhận gửi"}
              </button>
            </div>
          </div>
        </div>
      )}

      {changeTarget && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-4"
          onClick={() => { if (!changeBusyId) setChangeTarget(null); }}>
          <div role="dialog" aria-modal="true" className="w-full max-w-sm bg-white rounded-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="space-y-1">
              <p className="text-base font-bold text-slate-800">Đổi Giao Nhận Mẫu</p>
              <p className="text-xs text-slate-500 font-semibold break-all">{changeTarget.reference}</p>
              <p className="text-xs text-slate-500">Những người đang ở trong bán kính 100m quanh chi nhánh.</p>
            </div>

            {changeLoading ? (
              <p className="py-6 text-center text-sm font-semibold text-slate-500">Đang tìm…</p>
            ) : changeList.length === 0 ? (
              <p className="py-6 text-center text-sm font-semibold text-slate-500">
                Hiện không có Giao Nhận Mẫu nào ở gần chi nhánh.
              </p>
            ) : (
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {changeList.map((d) => (
                  <button key={d.driverId} onClick={() => handleChangeDriver(d.driverId, d.name)}
                    disabled={!!changeBusyId}
                    className="w-full flex items-center gap-2.5 p-3 rounded-xl border border-slate-200 text-left active:bg-slate-50 disabled:opacity-40">
                    <span aria-hidden className="w-8 h-8 flex-none rounded-full bg-blue-100 text-blue-700 font-extrabold text-xs flex items-center justify-center">
                      {initial(driverText(d.name))}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-bold text-slate-800 truncate">{driverText(d.name)}</span>
                      <span className="block text-[11px] font-semibold text-slate-500">Cách {d.metres}m</span>
                    </span>
                    {changeBusyId === d.driverId && <span className="text-[11px] font-bold text-blue-700">Đang đổi…</span>}
                  </button>
                ))}
              </div>
            )}

            {changeError && <p role="alert" className="text-xs text-red-600 font-medium">{changeError}</p>}
            <button onClick={() => setChangeTarget(null)} disabled={!!changeBusyId}
              className="w-full py-3 rounded-xl text-sm font-semibold border border-slate-200 text-slate-600 disabled:opacity-40">Quay lại</button>
          </div>
        </div>
      )}

      {toast && (
        <div role="status" className={`fixed top-4 left-1/2 -translate-x-1/2 z-[60] px-4 py-3 rounded-xl shadow-lg text-sm font-semibold text-white max-w-[90%] text-center ${toast.ok ? "bg-slate-900" : "bg-red-600"}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
