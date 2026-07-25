"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useParams } from "next/navigation";
// PSC routes are a hard-coded constant ([[psc-routes-data]]); look up directly instead of
// fetching /api/psc-routes — no function invocation, no network round-trip, instant render.
import {
  Package, Check, ChevronDown, ChevronRight, Clock, Phone, Bike, CalendarDays,
  RefreshCw, ArrowUp, ArrowDown, ArrowRight, Loader2, Search, Camera, PenLine, Link2, StickyNote,
} from "lucide-react";
import { PSC_ROUTES } from "@/lib/psc-routes-data";

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
}

// A request this device created that hasn't surfaced on a driver's route yet.
// Cartrack's route feed only contains jobs already handed to a driver, so a job
// we created and can't find there is still waiting for dispatch.
interface PendingReq {
  job_id: number;
  reference: string;
  created_ts: string; // "HH:mm"
  date: string;       // YYYY-MM-DD it was created on
}

type Status = "idle" | "loading" | "success" | "error";

// Which todo types the branch cares about, and the icon each gets. Doubles as the filter:
// a type absent from here is not shown.
const TODO_ICON: Record<number, typeof Camera> = { 1: PenLine, 2: Camera, 3: Link2, 5: StickyNote };

const STEPS = ["Yêu cầu", "Lấy mẫu", "Đang giao", "Đã giao"] as const;

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

// Cartrack stores client rows as "{account code} - {old district} - {street abbrev} - {name}"
// ("46647677 - BTan - 54 - BV QUỐC ÁNH"). Only the trailing name means anything to branch
// staff, and the codes are what pushed real names off the edge of the row. Diag's own sites
// use the shorter "BRA - D010". Anything that matches neither shape is left alone rather
// than guessed at — a client name may legitimately contain " - ".
function placeLabel(name: string): string {
  const raw = (name ?? "").trim();
  const parts = raw.split(" - ");
  if (parts.length < 2) return raw;
  if (/^BRA$/i.test(parts[0])) return parts.slice(1).join(" - ");
  // The convention is exactly four segments, so four or more means a client row. Joining the
  // tail rather than taking parts[3] keeps names that contain " - " themselves intact, and
  // the leading code isn't always numeric ("SENDOUT2 - D10 - HHao - MEDIC").
  if (parts.length >= 4) return parts.slice(3).join(" - ");
  // Shorter rows still lead with the account code.
  if (/^\d+$/.test(parts[0])) return parts.slice(1).join(" - ");
  return raw;
}

// The 3PL handoff parks the job on a shared proxy driver account; its internal name
// ("Proxy 3PL Express (Grab) Driver") means nothing to a branch, so name the service.
const THREE_PL = "Grab/Be/XanhSM/Khác";

function isThreePl(name?: string | null): boolean {
  return /proxy|3pl/i.test((name ?? "").trim());
}

function driverLabel(name?: string | null): string {
  const raw = (name ?? "").trim();
  if (!raw) return "—";
  return isThreePl(raw) ? THREE_PL : raw;
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
// to the destination · 3 handed over.
function stateOf(j: Job): 0 | 1 | 2 | 3 {
  const p = pickupOf(j), d = dropoffOf(j);
  if (d?.activity_completed_ts || j.job_status_id === 5) return 3;
  if (p?.activity_completed_ts) return 2;
  return 1;
}

const STATE_STYLE: Record<number, string> = {
  0: "bg-amber-100 text-amber-700",
  1: "bg-blue-100 text-blue-700",
  2: "bg-blue-100 text-blue-700",
  3: "bg-green-100 text-green-700",
};

// "lab" only ever meant D001. Hub routes drop at D007/D009/D046 and inbound client legs
// drop at the branch itself, so the destination is named rather than assumed.
function stateText(state: 0 | 1 | 2 | 3, dest?: string): string {
  const to = dest ? ` đến ${dest}` : "";
  if (state === 0) return "Chờ điều phối";
  if (state === 1) return "Tài xế đang đến lấy";
  if (state === 2) return `Đang giao${to}`;
  return "Đã giao";
}

function initial(name?: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1][0].toUpperCase() : "?";
}

// Whose work a trip is: samples leaving this branch, or a client's samples coming in.
// Both directions share the feed and are otherwise indistinguishable at a glance.
// Styles live in a lookup rather than an inline ternary so each pairing is one complete
// unit — slate-700/slate-200 is 8.4:1, violet-700/violet-100 is 6.0:1.
const DIRECTION_STYLE = {
  out: "bg-slate-200 text-slate-700",
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

function Stepper({ job, state }: { job: Job; state: 0 | 1 | 2 | 3 }) {
  const p = pickupOf(job), d = dropoffOf(job);
  const times = [requestedAt(job), fmtTs(p?.activity_completed_ts), fmtTs(d?.activity_started_ts), fmtTs(d?.activity_completed_ts)];
  // Steps completed so far; the "current" step pulses.
  const doneUpto = state === 0 ? 0 : state === 1 ? 0 : state === 2 ? 1 : 3;
  const nowIdx = state === 3 ? -1 : state === 0 ? 0 : state === 1 ? 1 : 2;

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

// Cartrack's own todo descriptions lead with an emoji ("📦 Chụp thấy rõ mẫu…"). That's their
// data, but rendering it would put colour back into a page that is otherwise line icons, so
// the leading pictograph is stripped and the todo type supplies a matching icon instead.
const LEADING_EMOJI = /^\p{Extended_Pictographic}️?\s*/u;

function Photos({ todos }: { todos: NonNullable<Stop["todos"]> }) {
  const shots = todos.flatMap((t) => {
    const Icon = TODO_ICON[t.todo_type_id] ?? Camera;
    const caption = (t.description || t.note || "").replace(LEADING_EMOJI, "").trim();
    return (t.images ?? []).filter((i) => !i.is_deleted).map((img) => ({ img, caption, Icon }));
  });
  if (!shots.length) return null;
  return (
    <div className="flex gap-2.5 mt-2.5 overflow-x-auto pb-1">
      {shots.map(({ img, caption, Icon }) => (
        <figure key={img.image_id} className="flex-none w-[88px]">
          <a href={img.image_url} target="_blank" rel="noopener noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img.image_url} alt={caption || "Ảnh giao nhận"} className="w-[88px] h-[88px] rounded-xl object-cover border border-slate-200" />
          </a>
          <figcaption className="flex items-start gap-1 text-[10px] text-slate-500 mt-1 leading-tight">
            <Icon aria-hidden className="w-3 h-3 shrink-0 mt-px" />
            <span>{caption}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

type Tone = "done" | "now" | "future";
interface TlEvent { tone: Tone; time?: string | null; label: string; body?: React.ReactNode }

// The rail is drawn per event, so the trailing connector below the final event has to be
// suppressed explicitly — `last:` would match every event's own line.
function Timeline({ events }: { events: TlEvent[] }) {
  return (
    <div className="mt-5">
      {events.map(({ tone, time, label, body }, i) => (
        <div key={`${label}-${i}`} className="flex">
          <div className={`w-12 flex-none text-right pr-3 text-xs font-bold tabular-nums leading-tight ${tone === "future" ? "text-slate-500" : "text-slate-700"}`}>
            {time ?? ""}
          </div>
          <div className="w-6 flex-none flex flex-col items-center">
            <span aria-hidden className={`w-3 h-3 rounded-full border-[3px] mt-0.5 z-10 ${
              tone === "done" ? "bg-green-600 border-green-600"
                : tone === "now" ? "bg-white border-blue-600 animate-pulse"
                : "bg-white border-slate-200"
            }`} />
            {i < events.length - 1 && (
              <span aria-hidden className={`w-[3px] flex-1 my-0.5 ${tone === "done" ? "bg-green-600" : "bg-slate-200"}`} />
            )}
          </div>
          <div className={`flex-1 min-w-0 pl-3 ${i < events.length - 1 ? "pb-5" : "pb-1"}`}>
            <p className={`text-sm font-bold leading-tight ${tone === "future" ? "text-slate-500 font-semibold" : tone === "now" ? "text-blue-700" : "text-slate-800"}`}>
              {label}
            </p>
            {body}
          </div>
        </div>
      ))}
    </div>
  );
}

// Chain of custody, oldest first. Each leg contributes a completed event when it has a
// timestamp, the live event when it's the stop in progress, and a greyed placeholder
// otherwise — so the branch always sees the full shape of the trip.
function buildEvents(
  job: Job, state: 0 | 1 | 2 | 3,
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
      label: `Đã gửi qua ${THREE_PL}`,
      body: (
        <p className="text-xs text-slate-500 mt-0.5">
          Mẫu bàn giao cho đơn vị giao ngoài để chuyển đến {destName}.
        </p>
      ),
    });
    return ev;
  }

  if (p?.activity_started_ts) ev.push({ tone: "done", time: fmtTs(p.activity_started_ts), label: "Tài xế bắt đầu đi lấy mẫu" });
  else ev.push({ tone: state === 0 ? "now" : "future", label: state === 0 ? "Đang chờ điều phối tài xế…" : "Tài xế đi lấy mẫu" });

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
  const phone = detail?.driver?.phone_local;
  const phoneE164 = detail?.driver?.phone_e164;
  const threePl = isThreePl(shown.driver?.last_name);
  const driver = driverLabel(shown.driver?.last_name);

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
            {threePl ? <Bike aria-hidden className="w-4 h-4" /> : initial(driver)}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-slate-800">{shown.driver?.last_name ? driver : "Chưa có tài xế"}</p>
            {phone ? (
              <div className="flex items-center gap-3 mt-0.5">
                <a href={`tel:${phoneE164}`} className="inline-flex items-center gap-1.5 text-sm font-bold text-green-700 active:opacity-70"><Phone aria-hidden className="w-3.5 h-3.5" />{phone}</a>
                <a href={`https://zalo.me/${phoneE164?.replace("+", "")}`} target="_blank" rel="noopener noreferrer"
                   className="text-xs font-extrabold text-[#0068ff] bg-blue-50 rounded-lg px-2 py-0.5">Zalo</a>
              </div>
            ) : (
              <p className="text-[11px] text-slate-500">{threePl ? "Đơn vị giao ngoài" : "Tài xế Diag"}</p>
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
          <p className="text-[11px] text-slate-500 text-center">Đang tải ảnh giao nhận và số điện thoại tài xế…</p>
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

function TripCard({ job, code, onOpen, onCancel, onSendVia3pl }: {
  job: Job;
  code: string;
  onOpen: () => void;
  onCancel: (t: { job_id: number; reference: string }) => void;
  onSendVia3pl: (t: { job_id: number; reference: string }) => void;
}) {
  const state = stateOf(job);
  const p = pickupOf(job), d = dropoffOf(job);
  const destName = placeLabel(d?.customer_name ?? "");
  const threePl = isThreePl(job.driver?.last_name);
  const driver = driverLabel(job.driver?.last_name);
  const win = windowLabel(p);
  // Whose work this is: samples leaving this branch, or a client's samples coming in.
  // Both directions sit in the same feed and used to look identical.
  const outbound = p?.customer_id === code;

  // Cancellable only while this location's own pickup is untouched.
  const cancellable = !!p && p.customer_id === code && p.stop_status_id === 1 &&
    !p.activity_started_ts && !p.activity_arrived_ts && !p.activity_completed_ts;
  // 3PL handoff stays open until the sample is actually collected.
  const via3plEligible = !!p && p.customer_id === code && !p.activity_completed_ts && p.stop_status_id !== 5;

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
              {win && <span className="text-[11px] font-semibold text-amber-700">Hẹn {win}</span>}
            </div>
          </div>
          <span className={`flex-none text-[11px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${STATE_STYLE[state]}`}>
            {threePl ? "Đã gửi qua đối tác" : stateText(state, destName)}
          </span>
        </div>

        {threePl ? (
          <p className="flex items-center gap-1.5 mt-2.5 text-[13px] font-semibold text-teal-700">
            <Bike aria-hidden className="w-4 h-4 shrink-0" />Đã gửi qua {THREE_PL} lúc {fmtTs(d?.activity_completed_ts ?? p?.activity_completed_ts) ?? "—"}
          </p>
        ) : (
          <Stepper job={job} state={state} />
        )}

        {state === 0 ? (
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-100 text-[13px] font-semibold text-amber-700">
            <Clock aria-hidden className="w-4 h-4 shrink-0" />Đang chờ điều phối tài xế
          </div>
        ) : !threePl && (
          <div className="flex items-center gap-2.5 mt-3 pt-3 border-t border-slate-100">
            <span aria-hidden className="w-8 h-8 flex-none rounded-full bg-blue-100 text-blue-700 font-extrabold text-xs flex items-center justify-center">
              {initial(driver)}
            </span>
            <span className="flex-1 min-w-0 text-sm font-bold text-slate-800">{driver}</span>
            <ChevronRight aria-hidden className="w-4 h-4 text-slate-400 shrink-0" />
          </div>
        )}
      </button>

      {(via3plEligible || cancellable) && (
        <div className="space-y-1.5 mt-3">
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
      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-100 text-[13px] font-semibold text-amber-700">
        <Clock aria-hidden className="w-4 h-4 shrink-0" />Đã gửi lúc {req.created_ts} — đang chờ điều phối tài xế
      </div>
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
  const [pending, setPending] = useState<PendingReq[]>([]);

  const [sheetJob, setSheetJob] = useState<Job | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [doneQuery, setDoneQuery] = useState("");
  const [datePanel, setDatePanel] = useState(false);

  const [cancelTarget, setCancelTarget] = useState<{ job_id: number; reference: string } | null>(null);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState("");

  const [via3plTarget, setVia3plTarget] = useState<{ job_id: number; reference: string } | null>(null);
  const [via3plLoading, setVia3plLoading] = useState(false);
  const [via3plError, setVia3plError] = useState("");
  const [batchInput, setBatchInput] = useState("");

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

  const loadJobs = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/location-jobs?date=${date}&status=all&code=${encodeURIComponent(code)}${fresh ? "&fresh=1" : ""}`);
      const data = await res.json();
      const list: Job[] = (data.jobs ?? [])
        .filter((j: Job) => (j.stops ?? []).length > 1)
        // Plan slots regenerate daily; the unfinished ones are noise, not real trips.
        .filter((j: Job) => j.last_assigned_plan_id == null || j.job_status_id === 5);
      list.sort((a, b) => {
        const t = (j: Job) => j.stops.map((s) => s.activity_completed_ts ?? s.activity_arrived_ts ?? s.activity_started_ts).filter(Boolean).sort().at(-1) ?? "";
        return t(b).localeCompare(t(a));
      });
      setJobs(list);
    } catch {
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, [date, code]);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  // The feed shows trips in motion, so a branch that leaves it open should see progress
  // without tapping Làm mới. Only today can change, and only a visible tab is worth
  // polling — a phone in a pocket shouldn't keep hitting the API. The server's own 90s
  // day-cache absorbs this: most polls are served from Redis, not Cartrack.
  useEffect(() => {
    if (date !== todayVN()) return;
    const tick = () => { if (document.visibilityState === "visible") loadJobs(); };
    const id = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", tick); };
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
        }
        showToast("Đã gửi yêu cầu lấy mẫu", true);
        setTimeout(() => setAssignStatus("idle"), 3500);
        loadJobs(true);
      } else if (res.status === 409) {
        setAssignStatus("error");
        setAssignError(
          data.job_id
            ? "Đơn liền trước chưa nhận mẫu, vui lòng chờ thêm hoặc liên hệ đội điều phối. Xin cám ơn!"
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
      persistPending(pending.filter((p) => p.job_id !== cancelTarget.job_id));
      setCancelTarget(null);
      showToast("Đã huỷ chuyến thành công.", true);
      loadJobs(true);
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
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setVia3plError(data.error ?? "Gửi thất bại");
        return;
      }
      persistPending(pending.filter((p) => p.job_id !== via3plTarget.job_id));
      setVia3plTarget(null);
      setBatchInput("");
      showToast("Đã gửi mẫu qua Grab/Be/XanhSM/Ahamove thành công.", true);
      loadJobs(true);
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

        <div className="space-y-3">
          {pending.map((p) => (
            <PendingCard key={p.job_id} req={p} onCancel={(t) => { setCancelTarget(t); setCancelError(""); }} onSendVia3pl={openVia3pl} />
          ))}
          {active.map((j) => (
            <TripCard key={j.job_id} job={j} code={code} onOpen={() => setSheetJob(j)}
              onCancel={(t) => { setCancelTarget(t); setCancelError(""); }} onSendVia3pl={openVia3pl} />
          ))}
          {!loading && !pending.length && !active.length && (
            <p className="text-center text-sm text-slate-500 py-7">
              {isToday ? <>Chưa có chuyến nào đang chạy.{!route.no_request && <><br />Bấm nút phía trên để gọi tài xế.</>}</> : "Không có chuyến đang chạy."}
            </p>
          )}
          {loading && <p className="text-center text-sm text-slate-500 py-7">Đang tải…</p>}
        </div>

        <div className="bg-white rounded-2xl shadow-sm mt-3 overflow-hidden">
          <button onClick={() => setDoneOpen((v) => !v)} aria-expanded={doneOpen}
            className="w-full flex items-center justify-between px-4 py-3.5 text-[15px] font-bold text-slate-800">
            <span className="flex items-center gap-2"><Check aria-hidden className="w-4 h-4 text-green-600" />Xong {isToday ? "hôm nay" : ""} <span className="text-green-600">({done.length})</span></span>
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
                  placeholder="Tìm địa điểm, tài xế, mã batch…"
                  aria-label="Tìm trong chuyến đã xong"
                  className="w-full bg-slate-100 rounded-xl pl-9 pr-3 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-300"
                />
                </div>
              </div>
              {doneShown.length === 0 ? (
                <p className="text-center text-sm text-slate-500 py-5">
                  {doneQuery ? `Không tìm thấy chuyến nào khớp “${doneQuery}”` : "Chưa có chuyến nào hoàn thành."}
                </p>
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
                          <span className="text-[11px] text-slate-500">{driverLabel(j.driver?.last_name)}</span>
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
                        Gửi qua {THREE_PL} · {fmtTs(d?.activity_completed_ts ?? p?.activity_completed_ts) ?? "—"}
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

        {datePanel && (
          <div className="bg-white rounded-2xl shadow-sm p-4 mt-3">
            <input
              type="date"
              value={date}
              max={todayVN()}
              onChange={(e) => setDate(e.target.value)}
              aria-label="Chọn ngày"
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-base"
            />
          </div>
        )}
        <div className="flex items-center justify-center gap-4 mt-1">
          <button onClick={() => setDatePanel((v) => !v)} className="inline-flex items-center gap-1.5 py-3.5 text-sm font-semibold text-slate-500">
            <CalendarDays aria-hidden className="w-4 h-4" />{isToday ? "Xem ngày khác" : date}
          </button>
          <button onClick={() => loadJobs(true)} className="inline-flex items-center gap-1.5 py-3.5 text-sm font-semibold text-blue-600">
            <RefreshCw aria-hidden className="w-4 h-4" />Làm mới
          </button>
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
              <p className="text-xs text-slate-500">Chỉ huỷ được khi tài xế chưa bắt đầu lấy mẫu. Hành động này không thể hoàn tác.</p>
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
              <p className="text-xs text-slate-500">Chuyến sẽ được gán cho tài xế giao nhận và đánh dấu hoàn thành. Hành động này không thể hoàn tác.</p>
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

      {toast && (
        <div role="status" className={`fixed top-4 left-1/2 -translate-x-1/2 z-[60] px-4 py-3 rounded-xl shadow-lg text-sm font-semibold text-white max-w-[90%] text-center ${toast.ok ? "bg-slate-900" : "bg-red-600"}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
