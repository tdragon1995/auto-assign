"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
// PSC routes are a hard-coded constant ([[psc-routes-data]]); look up directly instead of
// fetching /api/psc-routes — no function invocation, no network round-trip, instant render.
import {
  TestTubes, Check, ChevronDown, ChevronRight, Clock, Phone, Bike, CalendarDays,
  ArrowRight, Loader2, Search, XCircle, ZoomIn, RotateCw,
} from "lucide-react";
import { PSC_ROUTES } from "@/lib/psc-routes-data";
import { placeLabel } from "@/lib/place-label";
import { Photos, Timeline, TodoNotes, TODO_ICON, type TlEvent } from "@/components/trip-sheet";
import type { StopNotes } from "@/lib/stop-notes";
import { proxyKind, driverLabel, THREE_PL_LABEL } from "@/lib/proxy-drivers";
import { driverDisplayName } from "@/lib/display-names";
import type { PickerDriver } from "@/lib/psc-driver-choices";
import { retirePending, type PendingReq } from "@/lib/pending-cards";
import { DeliveryBooking } from "./delivery-booking";

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
  delivery_driver_id?: string | null;
  driver?: { last_name?: string | null; phone_local?: string | null; phone_e164?: string | null } | null;
  stops: Stop[];
  // Set only on jobs from the unrouted pool (status 3).
  rejected_ts?: string | null;
  rejected_reason?: string | null;
}

// A request this device created that hasn't surfaced on a driver's route yet.
// Cartrack's route feed only contains jobs already handed to a driver, so a job
// we created and can't find there is still waiting for dispatch.

type Status = "idle" | "loading" | "success" | "error";

const STEPS = ["Lấy mẫu", "Đã giao"] as const;

// Shortest gap between two visibility refreshes. The day copy behind the list is
// republished every ~3 min, so a refresh sooner than this mostly returns what is on screen.
const MIN_REFRESH_MS = 60_000;

// Photo gallery: how far back "arrived recently" reaches. 40 minutes by default.
const GALLERY_WINDOWS = [
  { mins: 20, label: "20 phút" }, { mins: 40, label: "40 phút" },
  { mins: 60, label: "1 giờ" }, { mins: 120, label: "2 giờ" },
];


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

// Personal name only: never a staff code or the "F - C -" / "P - P -" prefix.
function driverText(name?: string | null): string {
  const label = driverLabel(name);
  return label ? driverDisplayName(label) : "—";
}

// What the driver list needs: the trip's route, when it was requested, and who holds it now.
type ChangeTarget = { job_id: number; reference: string; pickup: string; dropoff: string; at: string | null; current: string | null };

// The two driver actions on a trip card. Kept together so both cards read the same.
const CHANGE_CTA = "shrink-0 min-h-11 px-3 rounded-xl text-xs font-bold text-blue-700 border border-blue-200 active:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-600";
const PICK_CTA = "w-full min-h-12 inline-flex items-center justify-center gap-2 rounded-xl text-[13px] font-bold text-white bg-blue-700 active:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";

function DriverRow({ name, onOpen, onChange }: { name: string; onOpen?: () => void; onChange?: () => void }) {
  const who = (
    <>
      <span aria-hidden className="w-8 h-8 flex-none rounded-full bg-blue-100 text-blue-700 font-extrabold text-xs flex items-center justify-center">
        {initial(name)}
      </span>
      <span className="flex-1 min-w-0 text-sm font-bold text-slate-800 break-words">{name}</span>
    </>
  );
  return (
    <div className="flex items-center gap-2.5 mt-3 pt-3 border-t border-slate-100">
      {onOpen
        ? <button onClick={onOpen} className="flex-1 min-w-0 flex items-center gap-2.5 text-left active:opacity-70">{who}</button>
        : <span className="flex-1 min-w-0 flex items-center gap-2.5">{who}</span>}
      {onChange
        ? <button onClick={onChange} className={CHANGE_CTA}>Đổi giao nhận mẫu</button>
        : onOpen && <ChevronRight aria-hidden className="w-4 h-4 text-slate-400 shrink-0" />}
    </div>
  );
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

/**
 * The driver's handover note: who handed the samples over, and who received them.
 *
 * TWO ROWS, NOT ONE LINE. This started as a single "Lấy: … · Giao: …" run-on, on the
 * reasoning that two short phrases did not need structure around them. Measured against
 * a real day that was wrong twice over: a third of the notes wrapped to two or three
 * lines anyway, so the "·" separator landed mid-wrap where it separated nothing, and the
 * labels repeated the words "Lấy" and "Giao" that the STEPPER prints ten pixels above —
 * two different meanings for one word, adjacent.
 *
 * The labels are the DRIVER'S two actions, in the order they happened: they took the
 * samples at the clinic ("Nhận") and handed them over at the lab ("Giao"). Read that way
 * the second row is the person who received at D001, which is what the reader wants and
 * what the old flat "Giao: Hân" line already said — the fault there was never the word,
 * it was that both words sat inline in one sentence with nothing saying which end each
 * belonged to. The rows say it. The value also carries more weight than its label: it is
 * the only thing on the card that says what physically arrived.
 */
function NoteRow({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex gap-2 text-[12px] leading-snug">
      <span className="w-[44px] shrink-0 font-semibold text-slate-500">{label}</span>
      <span className="flex-1 min-w-0 text-slate-700">{value}</span>
    </span>
  );
}

function NoteBlock({ notes }: { notes?: StopNotes }) {
  if (!notes?.p && !notes?.d) return null;
  return (
    <span className="block mt-2.5 pt-2.5 border-t border-slate-100 space-y-1 text-left">
      {notes.p && <NoteRow label="Nhận" value={notes.p} />}
      {notes.d && <NoteRow label="Giao" value={notes.d} />}
    </span>
  );
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

// The route is printed right beside every tag, so a tag never repeats the destination —
// on a long client name it also pushed the tag off the card.
function stateText(state: TripState): string {
  if (state === 0) return "Chờ điều phối";
  if (state === 5) return "Chờ tới giờ hẹn";
  if (state === 1) return "Giao Nhận Mẫu đang đến lấy";
  if (state === 2) return "Đang giao";
  if (state === 4) return "Đã từ chối";
  return "Đã giao";
}

function initial(name?: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1][0].toUpperCase() : "?";
}

/* ─────────────────────────── progress stepper ─────────────────────────── */

/**
 * Two steps: collected, and handed over. There were four — "Yêu cầu" and "Đang giao"
 * as well — but the request time is already printed on the card's own header, and the
 * moment a driver sets off towards the destination is not a question anyone reading this
 * page asks. Two steps also give each label the width of two.
 */
function Stepper({ job, state }: { job: Job; state: TripState }) {
  const p = pickupOf(job), d = dropoffOf(job);
  const times = [fmtTs(p?.activity_completed_ts), fmtTs(d?.activity_completed_ts)];
  // Steps completed so far; the "current" step pulses.
  const doneUpto = state === 3 ? 1 : state === 2 ? 0 : -1;
  const nowIdx = state === 3 ? -1 : state === 2 ? 1 : 0;

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
  brief = false, photos: string[] = [],
): TlEvent[] {
  const destName = placeLabel(d?.customer_name ?? "");

  // D001's photo gallery: the nurse matches the photo against what arrived, so two facts
  // and the photo large — not the whole journey.
  if (brief) {
    // Every photo on the trip, pickup first. The gallery already has them all, so they
    // show at once; the trip's details only add any it did not carry.
    const urls = [...new Set([...photos, ...[...pTodos, ...dTodos].flatMap((t) => t.images ?? [])
      .filter((i) => !i.is_deleted).map((i) => i.image_url)].filter((u): u is string => !!u))];
    return [
      {
        tone: p?.activity_completed_ts ? "done" : "future", time: fmtTs(p?.activity_completed_ts),
        label: `Lấy mẫu tại ${placeLabel(p?.customer_name ?? "")}`,
        body: (
          <>
            <TodoNotes todos={pTodos} />
            <BriefPhotos urls={urls} />
          </>
        ),
      },
      d?.activity_completed_ts
        ? { tone: "done", time: fmtTs(d.activity_completed_ts), label: `Bàn giao tại ${destName}` }
        : { tone: d?.activity_arrived_ts ? "now" : "future", time: fmtTs(d?.activity_arrived_ts), label: `Đến ${destName}` },
    ];
  }
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

  if (p?.activity_completed_ts) ev.push({ tone: "done", time: fmtTs(p.activity_completed_ts), label: "Lấy mẫu xong", body: pTodos.length ? <><TodoNotes todos={pTodos} /><Photos todos={pTodos} /></> : undefined });
  else ev.push({ tone: "future", label: "Lấy mẫu" });

  if (d?.activity_started_ts) ev.push({ tone: "done", time: fmtTs(d.activity_started_ts), label: `Bắt đầu giao đến ${destName}` });
  else ev.push({ tone: "future", label: `Giao đến ${destName}` });

  if (d?.activity_arrived_ts) ev.push({ tone: "done", time: fmtTs(d.activity_arrived_ts), label: `Đến ${destName}`, body: addr(d) });
  else if (state === 2) ev.push({ tone: "now", label: `Đang trên đường đến ${destName}`, body: addr(d) });

  if (d?.activity_completed_ts) ev.push({ tone: "done", time: fmtTs(d.activity_completed_ts), label: "Bàn giao hoàn tất", body: dTodos.length ? <><TodoNotes todos={dTodos} /><Photos todos={dTodos} /></> : undefined });
  else ev.push({ tone: "future", label: `Bàn giao tại ${destName}` });

  return ev;
}

/** One big photo and every photo of the trip small beneath it; tapping a small one
 *  makes it the big one, tapping the big one opens it full size. */
function BriefPhotos({ urls }: { urls: string[] }) {
  const [i, setI] = useState(0);
  if (!urls.length) return null;
  const big = urls[Math.min(i, urls.length - 1)];
  return (
    <div className="mt-2">
      <a href={big} target="_blank" rel="noopener noreferrer" className="block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={big} alt="Ảnh giao nhận" className="w-full max-h-[55vh] lg:max-h-[46vh] rounded-xl object-contain bg-slate-100 border border-slate-200" />
      </a>
      {urls.length > 1 && (
        <div className="flex gap-2 mt-2 overflow-x-auto pb-1">
          {urls.map((u, k) => (
            <button key={u} onClick={() => setI(k)} aria-label={`Ảnh ${k + 1}`} aria-pressed={k === i}
              className={`flex-none w-16 h-16 rounded-lg overflow-hidden border-2 ${k === i ? "border-blue-600" : "border-transparent"}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt="" loading="lazy" className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function JobSheet({ job, onClose, brief = false, photos }: { job: Job; onClose: () => void; brief?: boolean; photos?: string[] }) {
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
        className={`w-full bg-white rounded-t-[20px] max-h-[86vh] overflow-y-auto px-5 pt-2.5 pb-6 ${brief ? "max-w-sm lg:max-w-2xl lg:rounded-[20px] lg:mb-6" : "max-w-sm"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div aria-hidden className="w-10 h-1 rounded-full bg-slate-200 mx-auto mt-1 mb-3.5" />

        <div className="flex items-center justify-between gap-2.5">
          <p className="text-lg font-extrabold tracking-tight text-slate-800">
            {placeLabel(p?.customer_name ?? "")} <ArrowRight aria-hidden className="inline w-4 h-4 text-slate-500 mx-0.5 shrink-0" /> {placeLabel(d?.customer_name ?? "")}
          </p>
          <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${STATE_STYLE[state]}`}>
            {stateText(state)}
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

        <Timeline events={buildEvents(shown, state, p, d, pTodos, dTodos, threePl, brief, photos)} />

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

/** A finished trip: one tappable row with its timestamps. */
function DoneRow({ job: j, notes, onOpen }: { job: Job; notes?: StopNotes; onOpen: () => void }) {
    const p = pickupOf(j), d = dropoffOf(j);
    const threePl = isThreePl(j.driver?.last_name);

    // No aria-label on the button below: on a button it REPLACES the whole
    // accessible name, so it hid the note, the driver and all four timestamps
    // from a screen reader — while the active cards, which carry none,
    // announced every one of them.
    return (
      <button onClick={onOpen}
        className="group w-full block px-4 py-3 border-t border-slate-100 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors">
        <span className="flex items-start gap-2.5">
          <Check aria-hidden className="w-4 h-4 text-green-600 shrink-0 mt-0.5" />
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-semibold text-slate-800">
              {placeLabel(p?.customer_name ?? "")} <ArrowRight aria-hidden className="inline w-3.5 h-3.5 text-slate-500 mx-0.5 shrink-0" /> {placeLabel(d?.customer_name ?? "")}
            </span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
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
        <NoteBlock notes={notes} />
      </button>
    );
}

/* ─────────────────────────── coming in from other branches ─────────────────────────── */

const vnClock = (ms: number) =>
  new Date(ms).toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" });

/** Expected arrival: pickup finished + that route's 30-day p80. Null before the pickup —
 *  the start time isn't known yet, so the row shows its status alone. */
function etaOf(j: Job, etaMins: Record<string, number>): number | null {
  const p = pickupOf(j);
  const mins = p ? etaMins[p.customer_id] : undefined;
  if (!mins || !p?.activity_completed_ts) return null;
  const done = Date.parse(`${p.activity_completed_ts.replace(" ", "T").slice(0, 19)}+07:00`);
  return Number.isNaN(done) ? null : done + mins * 60_000;
}

// The table's status column is narrow, so it says the state in two or three words.
const SHORT_STATE: Record<number, string> = {
  0: "Chờ điều phối", 1: "Đang đến lấy", 2: "Đang giao", 5: "Chờ giờ hẹn",
};

/** Other branches' runs on their way here, as a table — from, driver, status, ETA. A row
 *  opens the trip. */
function IncomingBlock({ jobs, etaMins, now, onOpen }: { jobs: Job[]; etaMins: Record<string, number>; now: number; onOpen: (j: Job) => void }) {
  const rows = jobs
    .map((j) => ({ j, eta: etaOf(j, etaMins), state: stateOf(j) }))
    .sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity));
  return (
    <section aria-labelledby="qr-incoming" className="bg-white rounded-2xl shadow-sm mb-4 overflow-hidden">
      <h3 id="qr-incoming" className="px-4 pt-3 pb-2 text-[13px] font-semibold text-slate-700">Đang đến từ PSC khác ({jobs.length})</h3>
      <table className="w-full table-fixed text-[13px]">
        <thead>
          <tr className="border-y border-slate-100 bg-slate-50 text-left text-[11px] font-semibold text-slate-500">
            <th scope="col" className="w-[24%] py-1.5 pl-4 pr-1 font-semibold">Từ</th>
            <th scope="col" className="py-1.5 px-1 font-semibold">Giao nhận mẫu</th>
            <th scope="col" className="w-[26%] py-1.5 px-1 font-semibold">Trạng thái</th>
            <th scope="col" className="w-[18%] py-1.5 pl-1 pr-4 text-right font-semibold">Dự kiến</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ j, eta, state }) => {
            const late = eta != null && now > eta;
            return (
              <tr key={j.job_id} onClick={() => onOpen(j)}
                className="cursor-pointer border-t border-slate-100 first:border-t-0 hover:bg-slate-50 active:bg-slate-100">
                <td className="py-2.5 pl-4 pr-1 font-semibold text-slate-800">
                  {/* The row is clickable for the mouse; this button is the keyboard's way in. */}
                  <button onClick={(e) => { e.stopPropagation(); onOpen(j); }}
                    className="text-left rounded outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
                    {placeLabel(pickupOf(j)?.customer_name ?? "")}
                  </button>
                </td>
                <td className="py-2.5 px-1 truncate text-slate-600">{driverText(j.driver?.last_name)}</td>
                <td className="py-2.5 px-1">
                  <span className={`inline-block px-1.5 py-0.5 rounded-md text-[11px] font-semibold ${STATE_STYLE[state]}`}>{SHORT_STATE[state] ?? stateText(state)}</span>
                </td>
                <td className={`py-2.5 pl-1 pr-4 text-right tabular-nums ${late ? "text-amber-700" : "text-slate-900"}`}>
                  {eta == null ? <span className="text-slate-400">—</span> : (
                    <>
                      <span className="block font-bold">{vnClock(eta)}</span>
                      {late && <span className="block text-[10px] font-semibold">Quá giờ</span>}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// Who receives samples at D001 — the recipient a branch types into the Grab/Be app when
// it sends a trip to the lab. Hand-kept: change here when the people or their days change.
// days: 0 = Sunday … 6 = Saturday; hours in VN time, end exclusive.
const D001_RECEIVERS = [
  { name: "Anh Tú", phone: "0703977160", hours: ["T2 → T7: 6:00–15:00"], slots: [{ days: [1, 2, 3, 4, 5, 6], from: 6, to: 15 }] },
  { name: "Chị Hoa", phone: "0908066033", hours: ["T2, T4, T6: 15:00–21:00"], slots: [{ days: [1, 3, 5], from: 15, to: 21 }] },
  { name: "Anh Phát", phone: "0908064890", hours: ["T3, T5, T7: 15:00–21:00", "CN: 7:00–15:00"],
    slots: [{ days: [2, 4, 6], from: 15, to: 21 }, { days: [0], from: 7, to: 15 }] },
];
const fmtPhone = (p: string) => p.replace(/^(\d{4})(\d{3})(\d{3})$/, "$1 $2 $3");

/** The D001 receivers, whoever is on now first and marked: call, or copy the number
 *  into the Grab app. */
function D001Receivers() {
  // Read once when shown: who is on duty does not need to tick while the sheet is open.
  const [now] = useState(() => {
    const vn = new Date(Date.now() + 7 * 3_600_000);
    return { day: vn.getUTCDay(), hour: vn.getUTCHours() + vn.getUTCMinutes() / 60 };
  });
  const [copied, setCopied] = useState("");
  const copy = async (phone: string) => {
    try { await navigator.clipboard.writeText(phone); setCopied(phone); setTimeout(() => setCopied(""), 2000); } catch {}
  };
  const onDuty = (r: (typeof D001_RECEIVERS)[number]) =>
    r.slots.some((x) => x.days.includes(now.day) && now.hour >= x.from && now.hour < x.to);
  const list = [...D001_RECEIVERS].sort((a, b) => Number(onDuty(b)) - Number(onDuty(a)));
  return (
    <div>
      <p className="mb-1 text-[12px] font-semibold text-slate-600">Người nhận mẫu tại D001 — điền vào app Grab:</p>
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
        {list.map((r) => {
          const on = onDuty(r);
          return (
            <li key={r.phone} className={`flex items-center gap-3 px-3 py-2.5 ${on ? "bg-blue-50" : ""}`}>
              <span className="flex-1 min-w-0">
                <span className="flex flex-wrap items-center gap-x-1.5 text-sm font-bold text-slate-800">
                  {r.name} <span className="font-semibold text-blue-700 tabular-nums">{fmtPhone(r.phone)}</span>
                  {on && <span className="px-1.5 py-0.5 rounded-md bg-blue-700 text-[10px] font-bold text-white">Đang trực</span>}
                </span>
                {r.hours.map((h) => <span key={h} className="block text-[11px] text-slate-500">{h}</span>)}
              </span>
              <span className="shrink-0 flex flex-col gap-1.5">
                <a href={`tel:${r.phone}`} aria-label={`Gọi ${r.name}`}
                  className="min-h-9 inline-flex items-center justify-center gap-1.5 px-3 rounded-lg text-[12px] font-bold text-blue-700 border border-blue-200 active:bg-blue-50">
                  <Phone aria-hidden className="w-3.5 h-3.5" />Gọi
                </a>
                <button onClick={() => copy(r.phone)} aria-label={`Sao chép số của ${r.name}`}
                  className="min-h-9 px-3 rounded-lg text-[12px] font-bold text-blue-700 border border-blue-200 active:bg-blue-50">
                  {copied === r.phone ? "Đã chép" : "Sao chép"}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** In place of "Chỉ định GNM" when every driver rostered for the route is on leave:
 *  Grab/Be, and — for a trip to the lab — who to name as the receiver there. */
function NoDriverBlock({ onGrab, toLab }: { onGrab: () => void; toLab: boolean }) {
  return (
    <div className="mt-3 pt-3 border-t border-slate-100 space-y-3">
      <p className="text-[13px] font-semibold text-amber-700">Giao Nhận Mẫu của chi nhánh đang nghỉ lúc này.</p>
      <button onClick={onGrab} className={PICK_CTA}>
        <Bike aria-hidden className="w-4 h-4" />Gửi mẫu qua Grab
      </button>
      {toLab && <D001Receivers />}
    </div>
  );
}

function TripCard({ job, code, notes, noDriver = false, onOpen, onCancel, onSendVia3pl, onChangeDriver }: {
  job: Job;
  code: string;
  notes?: StopNotes;
  /** Every driver rostered for this route is on leave right now. */
  noDriver?: boolean;
  onOpen: () => void;
  onCancel: (t: { job_id: number; reference: string }) => void;
  onSendVia3pl: (t: { job_id: number; reference: string }) => void;
  onChangeDriver: (t: ChangeTarget) => void;
}) {
  const state = stateOf(job);
  const p = pickupOf(job), d = dropoffOf(job);
  const destName = placeLabel(d?.customer_name ?? "");
  const threePl = isThreePl(job.driver?.last_name);
  const driver = driverText(job.driver?.last_name);
  const win = windowLabel(p);

  // A rejected trip is already closed — there is nothing left to cancel or hand off.
  const rejected = state === 4;
  // Cancellable only while this location's own pickup is untouched.
  const cancellable = !rejected && !!p && p.customer_id === code && p.stop_status_id === 1 &&
    !p.activity_started_ts && !p.activity_arrived_ts && !p.activity_completed_ts;
  // 3PL handoff stays open until the sample is actually collected.
  const via3plEligible = !rejected && !!p && p.customer_id === code && !p.activity_completed_ts && p.stop_status_id !== 5;
  // Picking or changing the driver stays open until the samples are collected — the moment
  // a branch usually discovers the assigned driver is not coming. Not on a trip parked for
  // its appointment time: nobody should be sent before then.
  const changeDriverEligible = via3plEligible && state !== 5;

  const target = { job_id: job.job_id, reference: job.reference_number };
  const change: ChangeTarget = {
    ...target, pickup: p?.customer_id ?? "", dropoff: d?.customer_id ?? "",
    at: requestedAt(job), current: state === 0 ? null : driver,
  };

  return (
    <div className="rounded-2xl bg-white shadow-sm border border-slate-100 p-4">
      <button onClick={onOpen} className="w-full text-left active:opacity-70">
        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0">
            <p className="text-base font-extrabold tracking-tight text-slate-800">
              {placeLabel(p?.customer_name ?? "")} <ArrowRight aria-hidden className="inline w-4 h-4 text-slate-500 mx-0.5 shrink-0" /> {destName}
            </p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
              <span className="text-[11px] font-semibold text-slate-500">Yêu cầu lúc {requestedAt(job) ?? "—"}</span>
              {win && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700">
                  <Clock aria-hidden className="w-3 h-3" />Hẹn {win}
                </span>
              )}
            </div>
          </div>
          <span className={`flex-none text-[11px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${STATE_STYLE[state]}`}>
            {threePl ? "Đã gửi qua đối tác" : stateText(state)}
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

        <NoteBlock notes={notes} />
      </button>

      {/* Outside the card's open-button: a button inside a button is invalid, and the
          driver action must not also open the trip sheet. */}
      {state === 0 && changeDriverEligible && noDriver ? (
        <NoDriverBlock onGrab={() => onSendVia3pl(target)} toLab={/\bD001$/.test(d?.customer_name ?? "")} />
      ) : state === 0 && changeDriverEligible ? (
        <div className="mt-3 pt-3 border-t border-slate-100">
          <button onClick={() => onChangeDriver(change)} className={PICK_CTA}>Chỉ định GNM</button>
        </div>
      ) : isWaiting(state) ? (
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-100 text-[13px] font-semibold text-amber-700">
          <Clock aria-hidden className="w-4 h-4 shrink-0" />
          {state === 5 ? "Đã đặt lịch, chờ tới giờ hẹn lấy mẫu" : "Đang chờ điều phối Giao Nhận Mẫu"}
        </div>
      ) : state === 4 ? null : !threePl && (
        <DriverRow name={driver} onOpen={onOpen}
          onChange={changeDriverEligible ? () => onChangeDriver(change) : undefined} />
      )}

      {((via3plEligible && !(state === 0 && noDriver)) || cancellable) && (
        <div className="space-y-1.5 mt-3">
          {via3plEligible && !(state === 0 && noDriver) && (
            <button onClick={() => onSendVia3pl(target)}
              className="w-full py-2.5 rounded-xl text-xs font-bold text-white bg-teal-600 active:bg-teal-800">
              Gửi mẫu qua Grab
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

function PendingCard({ req, pickup, dropoff, noDriver = false, onCancel, onSendVia3pl, onChangeDriver }: {
  req: PendingReq;
  noDriver?: boolean;
  pickup: string;
  dropoff: string;
  onCancel: (t: { job_id: number; reference: string }) => void;
  onSendVia3pl: (t: { job_id: number; reference: string }) => void;
  onChangeDriver: (t: ChangeTarget) => void;
}) {
  const target = { job_id: req.job_id, reference: req.reference };
  const change: ChangeTarget = {
    ...target, pickup, dropoff, at: req.created_ts, current: req.driver_name ? driverText(req.driver_name) : null,
  };
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
        {/* A trip created with its driver already on it has been dispatched — saying
            "chờ điều phối" next to that driver's name contradicts itself. */}
        <span className={`flex-none text-[11px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${STATE_STYLE[req.driver_name ? 1 : 0]}`}>
          {stateText(req.driver_name ? 1 : 0)}
        </span>
      </div>
      {req.driver_name ? (
        <DriverRow name={driverText(req.driver_name)} onChange={() => onChangeDriver(change)} />
      ) : noDriver ? (
        <NoDriverBlock onGrab={() => onSendVia3pl(target)} toLab={to === "D001"} />
      ) : (
        <div className="mt-3 pt-3 border-t border-slate-100">
          <button onClick={() => onChangeDriver(change)} className={PICK_CTA}>Chỉ định GNM</button>
        </div>
      )}
      <div className="space-y-1.5 mt-3">
        {!(noDriver && !req.driver_name) && (
          <button onClick={() => onSendVia3pl(target)}
            className="w-full py-2.5 rounded-xl text-xs font-bold text-white bg-teal-600 active:bg-teal-800">
            Gửi mẫu qua Grab
          </button>
        )}
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
  // Whether anything has been fetched yet — counts and "none" lines wait for it.
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<PendingReq[]>([]);
  const [seen, setSeen] = useState<Set<number>>(new Set());
  // Every branch sees every trip touching it (the D001 view, since 2026-10-18). Only the
  // lab gets the driver chips and the wide PC layout; a branch's list is short.
  // Routes ("pickup|dropoff") whose every rostered driver is on leave right now — their
  // waiting cards show Grab/Be and the back-office contacts instead of "Chỉ định GNM".
  const [noDriverRoutes, setNoDriverRoutes] = useState<Set<string>>(new Set());
  const isLab = (route?.psc_pickup ?? "").replace(/^BRA\s*-\s*/i, "") === "D001";
  // Narrow the list to one driver. A filter over trips already loaded — no request of its own.
  const [driverId, setDriverId] = useState("");
  // Gallery window. Staff pick it; this device remembers the pick.
  const [galleryMins, setGalleryMins] = useState(40);
  useEffect(() => {
    try { const m = Number(localStorage.getItem("qr-gallery-mins")); if (GALLERY_WINDOWS.some((w) => w.mins === m)) setGalleryMins(m); } catch {}
  }, []);
  const pickGalleryMins = (m: number) => {
    setGalleryMins(m);
    try { localStorage.setItem("qr-gallery-mins", String(m)); } catch {}
  };

  // The driver's typed notes, keyed by job. Its own request because nothing the feed is
  // built from carries a todo. Asked for by the ids this feed is showing, so the answer
  // is only ever about trips on screen.
  const [notes, setNotes] = useState<Record<number, StopNotes>>({});
  // Whether the notes request failed. A note that never arrives looks exactly like a
  // driver who typed nothing, so a broken endpoint would empty every card at once and
  // the page would read as a quiet day — the same silence footgun 3 warns about for the
  // config sheet. One line says it, not thirty-eight.
  const [notesFailed, setNotesFailed] = useState(false);
  // Minutes from pickup to here, per pickup branch (30-day p80, server-side), for the
  // "coming in" block. Empty for D001 and past days.
  const [etaMins, setEtaMins] = useState<Record<string, number>>({});
  // When the list last arrived — "late" is judged against it, and the page refreshes
  // whenever staff come back to the tab.
  const [loadedAt, setLoadedAt] = useState(0);

  const [sheetJob, setSheetJob] = useState<Job | null>(null);
  // Set when the sheet is opened from D001's gallery: brief view, led by this photo.
  const [briefPhotos, setBriefPhotos] = useState<string[] | null>(null);
  const [doneQuery, setDoneQuery] = useState("");
  const dateRef = useRef<HTMLInputElement>(null);
  const openDatePicker = () => {
    const el = dateRef.current;
    if (!el) return;
    try { el.showPicker(); } catch { el.focus(); el.click(); }
  };

  const [cancelTarget, setCancelTarget] = useState<{ job_id: number; reference: string } | null>(null);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState("");

  const [via3plTarget, setVia3plTarget] = useState<{ job_id: number; reference: string } | null>(null);
  const [via3plLoading, setVia3plLoading] = useState(false);
  const [via3plError, setVia3plError] = useState("");
  const [batchInput, setBatchInput] = useState("");

  // Pick / change driver: the roster for the trip's route at the time it was requested
  // (±10 min). Fetched fresh every time it opens — leave and shifts move during the day.
  const [changeTarget, setChangeTarget] = useState<ChangeTarget | null>(null);
  const [changeList, setChangeList] = useState<PickerDriver[]>([]);
  const [changeReason, setChangeReason] = useState<string | null>(null);
  const [changeLoading, setChangeLoading] = useState(false);
  const [changeBusyId, setChangeBusyId] = useState("");
  const [changeError, setChangeError] = useState("");

  // The trip a blocked duplicate booking points at: scrolled to and ringed for a moment.
  const [focusId, setFocusId] = useState(0);
  useEffect(() => {
    if (!focusId) return;
    const t0 = setTimeout(() => document.getElementById(`trip-${focusId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    const t1 = setTimeout(() => setFocusId(0), 4000);
    return () => { clearTimeout(t0); clearTimeout(t1); };
  }, [focusId]);
  const ring = (id: number) => `rounded-2xl transition-shadow ${focusId === id ? "ring-2 ring-blue-600 ring-offset-2 ring-offset-slate-100" : ""}`;

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
  // The branch's own bookings, by id: they stay on this device for the day, so a trip it
  // booked keeps showing its progress whichever driver has it.
  const ownIds = pending.filter((p) => p.date === date).map((p) => p.job_id).join(",");

  const loadJobs = useCallback(async () => {
    lastLoadRef.current = Date.now();
    setLoading(true);
    try {
      const res = await fetch(`/api/location-jobs?date=${date}&code=${encodeURIComponent(code)}&all=1${ownIds ? `&ids=${ownIds}` : ""}`);
      const data = await res.json();
      setEtaMins(data.eta ?? {});
      setLoadedAt(Date.now());
      const raw: Job[] = data.jobs ?? [];
      // A waiting card hides once the server has its trip at all — even one the filters
      // below then drop — and goes for good once Cartrack no longer has it (cancelled or
      // deleted), after 10 minutes' grace for a booking Cartrack has not indexed yet.
      setSeen(new Set(raw.map((j) => Number(j.job_id))));
      const gone = new Set<number>((data.missing ?? []).map(Number));
      if (gone.size) {
        const mins = (hm: string) => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
        setPending((prev) => {
          const next = prev.filter((p) => !(gone.has(Number(p.job_id)) && mins(nowHm()) - mins(p.created_ts) > 10));
          if (next.length !== prev.length) try { localStorage.setItem(pendingKey, JSON.stringify(next)); } catch {}
          return next;
        });
      }
      const list: Job[] = raw
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
      // Saved notes come with the list. Only trips whose notes are missing or stale are
      // asked for after — never blocking the list, which must not wait on Cartrack. (A
      // reply without `notes` is the REST fallback: ask for every trip, as before.)
      const shown = new Set(list.map((j) => j.job_id));
      setNotes(data.notes ?? {});
      const ask = data.notes ? (data.notesMissing ?? []).filter((id: number) => shown.has(id)) : [...shown];
      if (ask.length) {
        fetch(`/api/location-notes?date=${date}&ids=${ask.join(",")}`)
          .then((r) => r.json())
          .then((d) => { setNotes((prev) => ({ ...prev, ...(d.notes ?? {}) })); setNotesFailed(false); })
          .catch(() => setNotesFailed(true));
      } else setNotesFailed(false);
    } catch {
      setJobs([]);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [date, code, ownIds, pendingKey]);

  // Only trips waiting for a driver need the answer, so only their routes are asked — the
  // picker's own lookup, once per route per list load. None waiting, no request.
  const waitingRoutes = [...new Set([
    ...jobs.filter((j) => stateOf(j) === 0 && pickupOf(j)?.customer_id === code)
      .map((j) => `${pickupOf(j)?.customer_id}|${dropoffOf(j)?.customer_id}`),
    ...pending.filter((x) => x.date === date && !x.driver_name && !seen.has(Number(x.job_id)) && route)
      .map(() => `${route!.pickup}|${route!.dropoff}`),
  ])].sort().join(",");
  useEffect(() => {
    if (!waitingRoutes || date !== todayVN()) { setNoDriverRoutes(new Set()); return; }
    let alive = true;
    Promise.all(waitingRoutes.split(",").map(async (k) => {
      const [pickup, dropoff] = k.split("|");
      const r = await fetch(`/api/psc-assign/reassign?${new URLSearchParams({ pickup, dropoff })}`, { cache: "no-store" })
        .then((x) => x.json()).catch(() => null);
      return r?.reason === "all_on_leave" ? k : null;
    })).then((ks) => { if (alive) setNoDriverRoutes(new Set(ks.filter((k): k is string => !!k))); });
    return () => { alive = false; };
  }, [waitingRoutes, loadedAt, date]);
  const noDriverFor = (pickup?: string, dropoff?: string) => noDriverRoutes.has(`${pickup}|${dropoff}`);

  // On open, and whenever the date or the branch's bookings change.
  useEffect(() => { loadJobs(); }, [loadJobs]);

  // Refresh when the branch comes BACK to the tab, not on a timer — staff flip between
  // Zalo and this page constantly, and a timer kept every open tab polling all day.
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
            // driver_name rides in on the booking response — the trip was created with its
            // driver already on it, so there is nothing to wait for and nothing to poll.
            { job_id: Number(data.job_id), reference: data.reference, created_ts: nowHm(), date: todayVN(), driver_name: data.driver_name ?? undefined },
            ...pending,
          ]);
        }
        if (data.job_id) showToast("Đã gửi yêu cầu lấy mẫu", true);
        else { showToast("Đã gửi yêu cầu. Vui lòng kiểm tra danh sách chuyến.", true); loadJobs(); }
        setTimeout(() => setAssignStatus("idle"), 3500);
        // No reload. The response already carries job_id and reference, and the pending
        // placeholder above renders the new trip immediately — re-reading the whole
        // network's day would only fetch back what we just put on screen, and Cartrack
        // often has not indexed the job yet anyway, so it could come back WITHOUT it.
        // The placeholder retires itself once the job appears on a driver's route.
      } else if (res.status === 409) {
        // Not an error: the branch already has this trip. Take them to it instead.
        setAssignStatus("idle");
        const id = Number(data.job_id) || 0;
        const hhmm = /(\d{2}:\d{2})/.exec(data.reference_number ?? "")?.[1];
        showToast(hhmm ? `Đã có chuyến gọi lúc ${hhmm} — xem bên dưới` : "Chuyến vừa được gọi — xem bên dưới", true);
        if (!id) { loadJobs(); return; } // a twin tap still being created: it lands on the list
        // A trip the list does not carry yet (just booked from another phone) gets a card
        // the same way this device's own bookings do.
        if (!jobs.some((j) => j.job_id === id) && !pending.some((x) => Number(x.job_id) === id)) {
          persistPending([{ job_id: id, reference: data.reference_number ?? "", created_ts: hhmm ?? nowHm(), date: todayVN() }, ...pending]);
        }
        setDriverId("");
        setFocusId(id);
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
      persistPending(retirePending(pending, [cancelledId]));
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

  const openChangeDriver = async (t: ChangeTarget) => {
    setChangeTarget(t);
    setChangeList([]);
    setChangeReason(null);
    setChangeError("");
    setChangeLoading(true);
    try {
      const q = new URLSearchParams({ pickup: t.pickup, dropoff: t.dropoff, at: t.at ?? "" });
      const res = await fetch(`/api/psc-assign/reassign?${q}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setChangeError(data.error ?? "Không tải được danh sách"); return; }
      // The driver already on the trip is not a choice. Matched by name: the feed carries
      // no driver id, and the list is already one line per name.
      setChangeList(((data.drivers ?? []) as PickerDriver[]).filter((d) => d.name !== t.current));
      setChangeReason(data.reason ?? null);
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
      // A just-booked trip is on screen from this device, not from the feed, so the feed
      // reload below cannot correct it. Patch it here or the branch sees the old name.
      const jobId = changeTarget.job_id;
      const newName = data.driver_name ?? name;
      setPending((ps) => ps.map((x) => (x.job_id === jobId ? { ...x, driver_name: newName } : x)));
      showToast("Đã giao chuyến cho " + newName + ".", true);
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
      // The response carries the trip as it now stands — 3PL driver attached, completed,
      // with the real completion time the "Đã gửi qua…" line prints. Patch it in rather
      // than rebuilding the day to learn about one job. If the server's read-back failed
      // (`job` null) leave the row alone; the next feed load corrects it, and claiming the
      // handoff failed would be worse than showing it a few minutes late.
      if (data.job) {
        setJobs((js) => js.some((j) => j.job_id === handedId)
          ? js.map((j) => (j.job_id === handedId ? { ...j, ...data.job } : j))
          : [...js, data.job]);
      }
      setVia3plTarget(null);
      setBatchInput("");
      showToast("Đã gửi mẫu qua Grab thành công.", true);
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

  const pendingShown = pending.filter((p) => !seen.has(Number(p.job_id)));
  // Another branch's run still on its way here: the compact "coming in" block, kept out
  // of the main list. (The server drops it once delivered.)
  const isIncoming = (j: Job) => {
    const p = pickupOf(j);
    return /^\s*BRA\b/i.test(p?.customer_name ?? "") && p?.customer_id !== code
      && dropoffOf(j)?.customer_id === code && stateOf(j) !== 3;
  };
  const incoming = jobs.filter(isIncoming);
  const listJobs = jobs.filter((j) => !isIncoming(j));
  // The drivers on today's list, busiest first. (NĐTP drop-offs never reach D001's list:
  // the server leaves them out.) A trip going elsewhere is named "pickup → drop-off".
  const driverChips = !isLab ? [] : [...listJobs.reduce((m, j) => {
        if (!j.delivery_driver_id) return m;
        const c = m.get(j.delivery_driver_id) ?? { name: driverText(j.driver?.last_name), n: 0, dests: new Set<string>() };
        const d = dropoffOf(j);
        if (d && d.customer_id !== code) c.dests.add(`${placeLabel(pickupOf(j)?.customer_name ?? "")} → ${placeLabel(d.customer_name ?? "")}`);
        return m.set(j.delivery_driver_id, { ...c, n: c.n + 1 });
      }, new Map<string, { name: string; n: number; dests: Set<string> }>())].sort((a, b) => b[1].n - a[1].n);
  const inScope = (j: Job) => !driverId || j.delivery_driver_id === driverId;
  // The photo gallery, newest first. A picked driver: every photo of theirs that day,
  // any date. No driver: today's trips that reached this branch inside the time window.
  const vnMs = (ts?: string | null) => (ts ? Date.parse(`${ts.replace(" ", "T").slice(0, 19)}+07:00`) : NaN);
  const driverName = driverChips.find(([id]) => id === driverId)?.[1].name ?? "";
  const windowed = !driverId;
  const showGallery = !!driverId || date === todayVN();
  const gallery = showGallery
    ? listJobs.filter(inScope).flatMap((j) => {
        const d = j.stops.find((st) => st.stop_type_id === 2 && st.customer_id === code);
        const arrived = vnMs(d?.activity_arrived_ts ?? d?.activity_completed_ts);
        const at = Number.isNaN(arrived) ? vnMs(pickupOf(j)?.activity_completed_ts) : arrived;
        const imgs = notes[j.job_id]?.imgs ?? [];
        if (!imgs.length) return [];
        if (windowed && !(Date.now() - arrived <= galleryMins * 60_000)) return [];
        return [{ j, imgs, at }];
      }).sort((a, b) => (b.at || 0) - (a.at || 0))
    : [];
  const running = listJobs.filter((j) => stateOf(j) !== 3 && inScope(j));
  // A branch's own requests are the answer to the button it just pressed, so they sit
  // right under it, above the branch's list. (The lab books nothing.)
  const ownRequests = isLab ? [] : running.filter((j) => pickupOf(j)?.customer_id === code);
  const active = isLab ? running : running.filter((j) => pickupOf(j)?.customer_id !== code);
  const tripCard = (j: Job) => (
    <div key={j.job_id} id={`trip-${j.job_id}`} className={ring(j.job_id)}>
      <TripCard job={j} code={code} notes={notes[j.job_id]} noDriver={noDriverFor(pickupOf(j)?.customer_id, dropoffOf(j)?.customer_id)} onOpen={() => setSheetJob(j)}
        onCancel={(t) => { setCancelTarget(t); setCancelError(""); }} onSendVia3pl={openVia3pl}
        onChangeDriver={openChangeDriver} />
    </div>
  );
  const done = listJobs.filter((j) => stateOf(j) === 3 && inScope(j));
  const q = norm(doneQuery);
  const doneShown = q
    ? done.filter((j) => norm(`${j.stops.map((s) => s.customer_name).join(" ")} ${j.driver?.last_name ?? ""} ${(j.item_tracking_numbers ?? []).join(" ")}`).includes(q))
    : done;

  const isToday = date === todayVN();

  return (
    <div className="min-h-screen bg-slate-100 flex justify-center">
      <div className={`w-full px-4 pb-12 ${isLab ? "max-w-[1280px] lg:px-6" : "max-w-[430px]"}`}>

        <header className="pt-5 pb-3.5 px-1">
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">{route.psc_pickup.replace(/^BRA\s*-\s*/i, "PSC ")}</h1>
          <p className="text-sm text-slate-500 mt-0.5">Điểm đến: {route.dropoff_location.replace(/^BRA\s*-\s*/i, "PSC ")}</p>
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
                : <><TestTubes aria-hidden className="w-5 h-5" />Đề Nghị Giao Mẫu</>}
            </button>
            {assignStatus === "error" && (
              <p role="alert" className="mt-3 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">{assignError}</p>
            )}
          </div>
        )}

        <DeliveryBooking pickup={route.pickup} />

        {notesFailed && (
          <p role="alert" className="mb-3 px-3 py-2 rounded-xl text-[12px] font-semibold text-amber-700 bg-amber-50 border border-amber-200">
            Không tải được ghi chú giao nhận. Mở từng chuyến để xem.
          </p>
        )}

        {!isLab && ((isToday && pendingShown.length > 0) || ownRequests.length > 0) && (
          <div className="space-y-3 mb-5">
            {isToday && pendingShown.map((p) => (
              <div key={p.job_id} id={`trip-${p.job_id}`} className={ring(Number(p.job_id))}>
                <PendingCard req={p} pickup={route.pickup} dropoff={route.dropoff} noDriver={noDriverFor(route.pickup, route.dropoff)} onCancel={(t) => { setCancelTarget(t); setCancelError(""); }}
                  onSendVia3pl={openVia3pl} onChangeDriver={openChangeDriver} />
              </div>
            ))}
            {ownRequests.map(tripCard)}
          </div>
        )}

        {/* On a PC: drivers in a side column, the gallery first on the right — picking a
            driver shows their photos without scrolling. A phone stacks the same pieces. */}
        <div className={driverChips.length > 1 ? "lg:grid lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-6 lg:items-start" : ""}>
        {driverChips.length > 1 && (
          <aside className="mb-3 lg:mb-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:pr-1">
          <h2 className="hidden lg:block text-[13px] font-semibold text-slate-600 mb-2 px-1">Giao Nhận Mẫu</h2>
          <div className="flex flex-wrap gap-2 lg:flex-col lg:flex-nowrap" role="group" aria-label="Lọc theo Giao Nhận Mẫu">
            <button aria-pressed={!driverId} onClick={() => { setDriverId(""); setDoneQuery(""); }}
              className={`px-3.5 py-2 text-left rounded-full lg:rounded-xl text-sm font-semibold transition-colors ${!driverId ? "bg-blue-700 text-white" : "bg-white text-slate-700 shadow-sm hover:bg-slate-50 active:bg-slate-50"}`}>
              Tất cả <span className={!driverId ? "text-blue-100" : "text-slate-500"}>{listJobs.length}</span>
            </button>
            {driverChips.map(([id, d]) => {
              const on = id === driverId;
              return (
                <button key={id} aria-pressed={on} onClick={() => { setDriverId(on ? "" : id); setDoneQuery(""); }}
                  className={`px-3.5 py-2 text-left transition-colors lg:w-full lg:rounded-xl ${d.dests.size ? "rounded-2xl" : "rounded-full"} ${on ? "bg-blue-700 text-white" : "bg-white text-slate-700 shadow-sm hover:bg-slate-50 active:bg-slate-50"}`}>
                  <span className="block text-sm font-semibold">{d.name} <span className={on ? "text-blue-100" : "text-slate-500"}>{d.n}</span></span>
                  {/* Drivers who also go somewhere other than the lab say where, small. */}
                  {d.dests.size > 0 && (
                    <span className={`block max-w-[15rem] lg:max-w-none mt-0.5 text-[11px] font-medium leading-snug ${on ? "text-blue-100" : "text-slate-500"}`}>
                      {[...d.dests].map((x) => <span key={x} className="block truncate">{x}</span>)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          </aside>
        )}
        <div className="min-w-0">
        <div className="flex items-center justify-between gap-2 mb-2">
          <h2 className="text-[15px] font-bold text-slate-800">Chuyến của chi nhánh</h2>
            <span className="flex items-center gap-2">
            {/* Reloads from the shared day copy (republished every ~3 min) — it never forces a
                rebuild of the day, which is what made the old "Làm mới" expensive. */}
            <button onClick={() => loadJobs()} disabled={loading} aria-label="Tải lại danh sách" title="Tải lại"
              className="grid h-9 w-9 place-items-center rounded-xl bg-white text-slate-700 shadow-sm hover:bg-slate-50 active:bg-slate-50 disabled:opacity-60">
              <RotateCw aria-hidden className={`h-4 w-4 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`} />
            </button>
            <span className="relative">
              <button
                onClick={openDatePicker}
                aria-label={`Chọn ngày (đang xem ${isToday ? "hôm nay" : date})`}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-slate-700 bg-white shadow-sm hover:bg-slate-50 active:bg-slate-50"
              >
                <CalendarDays aria-hidden className="w-4 h-4" />
                {isToday ? "Hôm nay" : date.split("-").reverse().join("/")}
                <ChevronDown aria-hidden className="w-4 h-4 text-slate-500" />
              </button>
              {/* The browser's own calendar, opened by the button and anchored under it. */}
              <input ref={dateRef} type="date" value={date} max={todayVN()} tabIndex={-1} aria-hidden
                onChange={(e) => { if (e.target.value) setDate(e.target.value); }}
                className="absolute inset-0 w-full h-full opacity-0 pointer-events-none" />
            </span>
            </span>
        </div>

        {incoming.length > 0 && (
          <IncomingBlock jobs={incoming} etaMins={etaMins} now={loadedAt} onOpen={setSheetJob} />
        )}



        {showGallery && (
          <section className="mb-4" aria-labelledby="qr-gallery">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <h3 id="qr-gallery" className="text-[13px] font-semibold text-slate-600">{windowed ? "Mẫu đã giao" : `Mẫu đã giao · ${driverName}`} ({gallery.length})</h3>
              {windowed && <div role="group" aria-label="Trong khoảng" className="inline-flex rounded-lg bg-slate-200/70 p-0.5">
                {GALLERY_WINDOWS.map((w) => (
                  <button key={w.mins} aria-pressed={galleryMins === w.mins} onClick={() => pickGalleryMins(w.mins)}
                    className={`px-2.5 py-1.5 rounded-md text-[12px] font-semibold transition-colors ${galleryMins === w.mins ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}`}>
                    {w.label}
                  </button>
                ))}
              </div>}
            </div>
            {/* Only for a picked driver (D001): an empty time window says nothing worth a line. */}
            {loaded && !loading && gallery.length === 0 && !windowed && (
              <p className="text-sm text-slate-600 py-2">{driverName} chưa có ảnh mẫu{isToday ? " hôm nay" : " ngày này"}.</p>
            )}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {gallery.map(({ j, imgs, at }) => {
                const from = placeLabel(j.stops.find((st) => st.stop_type_id === 1)?.customer_name ?? "");
                const [big, ...rest] = imgs;
                return (
                  <button key={j.job_id} onClick={() => { setBriefPhotos(imgs); setSheetJob(j); }}
                    aria-label={`Xem chuyến từ ${from}`}
                    className="group flex flex-col overflow-hidden rounded-xl bg-white shadow-sm text-left outline-none hover:shadow-md transition-shadow focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
                    <span className="relative block aspect-[4/3] overflow-hidden bg-slate-200">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={big} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105 motion-reduce:transition-none" />
                      <span aria-hidden className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-white/90 text-slate-700 shadow">
                        <ZoomIn className="h-3.5 w-3.5" />
                      </span>
                    </span>
                    {rest.length > 0 && (
                      <span aria-hidden className="flex gap-1 px-1.5 pt-1.5">
                        {rest.slice(0, 4).map((u, k) => (
                          <span key={u} className="relative h-9 w-9 shrink-0 overflow-hidden rounded-md bg-slate-200">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={u} alt="" loading="lazy" className="h-full w-full object-cover" />
                            {k === 3 && rest.length > 4 && (
                              <span className="absolute inset-0 grid place-items-center bg-black/55 text-[11px] font-bold text-white">+{rest.length - 4}</span>
                            )}
                          </span>
                        ))}
                      </span>
                    )}
                    <span aria-hidden className="block px-2 pt-1 pb-1.5">
                      <span className="block truncate text-[12px] font-semibold leading-tight text-slate-800">{from}</span>
                      <span className="text-[11px] text-slate-500">{Number.isNaN(at) ? "" : new Date(at).toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" })}{imgs.length > 1 ? ` · ${imgs.length} ảnh` : ""}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <div className="space-y-3">
          <div className={`space-y-3 ${isLab ? "lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-3" : ""}`}>
            {active.map(tripCard)}
          </div>
          {loading && !jobs.length && <p className="text-sm text-slate-600 py-2">Đang tải…</p>}
          {done.length > 0 && (
            <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
              <p className="px-4 pt-3 pb-1 text-[12px] font-semibold text-slate-600">Đã xong ({done.length})</p>
              {done.length > 5 && (
                <div className="px-4 pb-2">
                  <div className="relative">
                    <Search aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
                    <input type="search" value={doneQuery} onChange={(e) => setDoneQuery(e.target.value)}
                      placeholder="Tìm điểm, GNM, mã batch…" aria-label="Tìm trong chuyến đã xong"
                      className="w-full bg-slate-100 rounded-xl pl-9 pr-3 py-2.5 text-sm placeholder:text-slate-600 outline-none focus:ring-2 focus:ring-blue-300" />
                  </div>
                </div>
              )}
              {doneShown.map((j) => <DoneRow key={j.job_id} job={j} notes={notes[j.job_id]} onOpen={() => setSheetJob(j)} />)}
              {doneQuery && doneShown.length === 0 && (
                <p className="px-4 py-4 text-sm text-slate-600">Không tìm thấy chuyến nào khớp “{doneQuery}”.</p>
              )}
            </div>
          )}
        </div>
        </div>
        </div>
      </div>

      {sheetJob && <JobSheet job={sheetJob} brief={briefPhotos !== null} photos={briefPhotos ?? undefined} onClose={() => { setSheetJob(null); setBriefPhotos(null); }} />}

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
              <p className="text-base font-bold text-slate-800">Gửi mẫu qua Grab?</p>
              <p className="text-xs text-slate-500 font-semibold break-all">{via3plTarget.reference}</p>
              <p className="text-xs text-slate-500">Chuyến sẽ được gán cho Giao Nhận Mẫu và đánh dấu hoàn thành. Hành động này không thể hoàn tác.</p>
            </div>
            {/→D001(_|$)/.test(via3plTarget.reference) && <D001Receivers />}
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
              <p className="text-base font-bold text-slate-800">Chọn giao nhận mẫu</p>
              <p className="text-xs text-slate-500 font-semibold break-all">{changeTarget.reference}</p>
            </div>

            {changeLoading ? (
              <p role="status" className="py-6 text-center text-sm font-semibold text-slate-500">Đang tải…</p>
            ) : changeList.length === 0 ? (
              changeError ? null : (
                <p role="status" className="py-6 text-center text-sm font-semibold text-slate-500">
                  {changeReason === "roster_unavailable" || changeReason === "leave_unavailable" || changeReason === "drivers_unavailable"
                    ? "Chưa tải được danh sách, vui lòng thử lại."
                    : changeReason === "all_on_leave"
                      ? "Giao Nhận Mẫu của chi nhánh đang nghỉ lúc này. Vui lòng gửi qua Grab."
                      : "Không có Giao Nhận Mẫu khác trong lịch lúc này."}
                </p>
              )
            ) : (
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {changeList.map((d) => (
                  <button key={d.driver_id} onClick={() => handleChangeDriver(d.driver_id, d.name)}
                    disabled={!!changeBusyId}
                    className="w-full min-h-12 flex items-center gap-2.5 p-3 rounded-xl border border-slate-200 text-left active:bg-slate-50 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-blue-600">
                    <span aria-hidden className="w-8 h-8 flex-none rounded-full bg-blue-100 text-blue-700 font-extrabold text-xs flex items-center justify-center">
                      {initial(d.name)}
                    </span>
                    <span className="flex-1 min-w-0 text-sm font-bold text-slate-800 break-words">{d.name}</span>
                    {changeBusyId === d.driver_id && <span className="text-[11px] font-bold text-blue-700">Đang giao…</span>}
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
