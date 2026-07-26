"use client";

import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw, Loader2, CheckCircle2, AlertCircle, Check, ChevronDown, ChevronRight,
  Clock, Package, ArrowRight, Phone, XCircle,
} from "lucide-react";
import { placeLabel } from "@/lib/place-label";
import { TripSteps, TRIP_STATE_STYLE, tripStateText, tripStateFromStops, type TripState } from "@/components/trip-steps";
import { Photos, Timeline, TODO_ICON, SheetShell, type TlEvent, type Todo } from "@/components/trip-sheet";
import { proxyKind, driverLabel } from "@/lib/proxy-drivers";
import { useParams } from "next/navigation";

interface TplOption {
  tpl_uuid: string;
  tpl_name: string;
  address: string;
}

interface Order {
  job_id: number;
  reference: string;
  job_status: string;
  pickup_stop_id: number | null;
  pickup_status_id: number | null;
  dropoff_status: string;
  dropoff_color: string;
  dropoff_update_ts: string | null;
  eta: string | null;
  pickup_name?: string;
  pickup_address?: string;
  dropoff_status_id?: number | null;
  pickup_completed_ts?: string | null;
  dropoff_started_ts?: string | null;
  dropoff_completed_ts?: string | null;
  create_ts?: string | null;
  driver_name?: string | null;
  job_status_id?: number | null;
  rejected_ts?: string | null;
  rejected_reason?: string | null;
}

const PSC_META: Record<string, { label: string; psc_code: string }> = {
  D021: { label: "BRA - D021 (Mỹ Tho)", psc_code: "D021" },
  D023: { label: "BRA - D023 (Vũng Tàu)", psc_code: "D023" },
  D030: { label: "BRA - D030", psc_code: "D030" },
  D036: { label: "BRA - D036 (Tân An)", psc_code: "D036" },
};

const hm = (ts?: string | null) => (ts ? ts.slice(11, 16) : null);

// A job parked on the queue proxy has no real driver yet: it is holding until its
// appointed pickup time, which is a different wait from "nobody has been assigned".
// Either way this makes the wait visible to every device instead of only the phone
// that created the request.
function isParkedOrder(o: Order): boolean {
  const kind = proxyKind(o.driver_name);
  return (kind === "queue" || kind === "reject") && !o.pickup_completed_ts;
}

function stateOf(o: Order): TripState {
  const parked = isParkedOrder(o);
  return tripStateFromStops(o.pickup_status_id, o.dropoff_status_id, !parked, o.job_status_id, parked);
}

// The first step falls back to the requested nhà-xe time when Cartrack gives no create_ts.
function stepTimes(o: Order) {
  return [hm(o.create_ts) ?? o.eta, hm(o.pickup_completed_ts), hm(o.dropoff_started_ts), hm(o.dropoff_completed_ts)];
}

// The reference is "BRA - D021 - Mẫu 4" — a running count of the day's requests from
// this location. "Mẫu N" is the part staff actually use to tell same-day requests
// apart, so it's pulled out as its own badge instead of living inside tiny gray text.
function mauLabel(reference: string): string {
  const m = /Mẫu\s*\d+/i.exec(reference ?? "");
  return m ? m[0] : reference ?? "";
}

function initial(name?: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1][0].toUpperCase() : "?";
}

// Full job detail fetched when a trip is opened — address, todos/POD photos and the
// driver's phone, none of which the orders list carries.
interface DetailStop {
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
  todos?: Todo[];
}

interface JobDetail {
  job_id: number;
  reference_number: string;
  job_status_id: number;
  driver?: { last_name?: string | null; phone_local?: string | null; phone_e164?: string | null } | null;
  item_tracking_numbers?: string[];
  stops: DetailStop[];
}

function windowLabel(stop?: Pick<DetailStop, "delivery_windows"> | null): string | null {
  const w = (stop?.delivery_windows ?? [])[0];
  if (!w) return null;
  const t = (x?: string | null) => (x ? x.slice(0, 5) : null);
  const from = t(w.time_from), to = t(w.time_to);
  if (from && to) return `${from}–${to}`;
  return from ?? to ?? null;
}

const addr = (s?: DetailStop | null) =>
  s?.address_line_1 ? <p className="text-xs text-slate-500 mt-0.5 leading-snug">{s.address_line_1}</p> : undefined;

function PscJobSheet({ order, onClose }: { order: Order; onClose: () => void }) {
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch(`/api/psc-tinh?job_id=${order.job_id}`)
      .then((r) => r.json())
      .then((d) => { if (alive && d.job) setDetail(d.job); })
      .catch(() => {})
      .finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [order.job_id]);

  const p = detail?.stops.find((s) => s.stop_type_id === 1);
  const d = detail?.stops.find((s) => s.stop_type_id !== 1);
  const state = stateOf(order);
  const win = windowLabel(p) ?? order.eta;
  // A proxy account is not a person: show no name and, crucially, no phone — its number
  // belongs to Diag's parking account and a branch calling it reaches nobody.
  const driverName = driverLabel(detail?.driver?.last_name);
  const phone = driverName ? detail?.driver?.phone_local : null;
  const phoneE164 = detail?.driver?.phone_e164;
  const pickupName = placeLabel(p?.customer_name ?? order.pickup_name ?? "3PL");

  const pTodos = (p?.todos ?? []).filter((t) => TODO_ICON[t.todo_type_id]);
  const dTodos = (d?.todos ?? []).filter((t) => TODO_ICON[t.todo_type_id]);

  const events: TlEvent[] = [
    {
      tone: "done",
      time: hm(order.create_ts) ?? order.eta,
      label: "Yêu cầu được tạo",
      body: (
        <>
          <p className="text-xs text-slate-500 mt-0.5">Từ {pickupName}</p>
          {win && <p className="text-xs font-semibold text-amber-700 mt-0.5">Hẹn tới nhà xe: {win}</p>}
        </>
      ),
    },
  ];

  if (p?.activity_started_ts) events.push({ tone: "done", time: hm(p.activity_started_ts), label: "Tài xế bắt đầu đi lấy mẫu" });
  else if (state === 5) events.push({ tone: "now", label: "Chờ tới giờ hẹn lấy mẫu…" });
  else events.push({ tone: state === 0 ? "now" : "future", label: state === 0 ? "Đang chờ điều phối tài xế…" : "Tài xế đi lấy mẫu" });

  if (p?.activity_arrived_ts) events.push({ tone: "done", time: hm(p.activity_arrived_ts), label: "Đến điểm lấy mẫu", body: addr(p) });
  else if (state === 1) events.push({ tone: "now", label: "Đang đến điểm lấy mẫu", body: addr(p) });

  if (p?.activity_completed_ts) events.push({ tone: "done", time: hm(p.activity_completed_ts), label: "Lấy mẫu xong", body: pTodos.length ? <Photos todos={pTodos} /> : undefined });
  else events.push({ tone: "future", label: "Lấy mẫu" });

  if (d?.activity_started_ts) events.push({ tone: "done", time: hm(d.activity_started_ts), label: "Bắt đầu giao đến D001" });
  else events.push({ tone: "future", label: "Giao đến D001" });

  if (d?.activity_arrived_ts) events.push({ tone: "done", time: hm(d.activity_arrived_ts), label: "Đến D001", body: addr(d) });
  else if (state === 2) events.push({ tone: "now", label: "Đang trên đường đến D001", body: addr(d) });

  if (d?.activity_completed_ts) events.push({ tone: "done", time: hm(d.activity_completed_ts), label: "Bàn giao hoàn tất", body: dTodos.length ? <Photos todos={dTodos} /> : undefined });
  else events.push({ tone: "future", label: "Bàn giao tại D001" });

  return (
    <SheetShell onClose={onClose}>
      <div className="flex items-center justify-between gap-2.5">
        <p className="text-lg font-extrabold tracking-tight text-slate-800">
          {pickupName} <ArrowRight aria-hidden className="inline w-4 h-4 text-slate-500 mx-0.5 shrink-0" /> D001
        </p>
        <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${TRIP_STATE_STYLE[state]}`}>
          {tripStateText(state, "D001")}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 mt-1">
        <span className="text-xs font-bold px-2 py-0.5 rounded-md bg-blue-50 text-blue-700">{mauLabel(order.reference)}</span>
        <span className="text-[11px] text-slate-500">{order.reference}</span>
      </div>

      <div className="flex items-center gap-2.5 mt-3.5 p-3 bg-slate-100 rounded-2xl">
        <span aria-hidden className="w-9 h-9 flex-none rounded-full bg-blue-100 text-blue-700 font-extrabold text-sm flex items-center justify-center">
          {driverName ? initial(driverName) : <Clock aria-hidden className="w-4 h-4" />}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-slate-800">{driverName || "Chưa có tài xế"}</p>
          {phone ? (
            <div className="flex items-center gap-3 mt-0.5">
              <a href={`tel:${phoneE164}`} className="inline-flex items-center gap-1.5 text-sm font-bold text-green-700 active:opacity-70">
                <Phone aria-hidden className="w-3.5 h-3.5" />{phone}
              </a>
              <a href={`https://zalo.me/${phoneE164?.replace("+", "")}`} target="_blank" rel="noopener noreferrer"
                className="text-xs font-extrabold text-[#0068ff] bg-blue-50 rounded-lg px-2 py-0.5">Zalo</a>
            </div>
          ) : (
            <p className="text-[11px] text-slate-500">
              {driverName ? "Tài xế Diag" : state === 5 ? "Đơn đã đặt lịch, chờ tới giờ hẹn" : "Đơn hàng đang chờ được phân công"}
            </p>
          )}
        </div>
      </div>

      <Timeline events={events} />

      {detailLoading && !detail && (
        <p className="text-[11px] text-slate-500 text-center mt-3">Đang tải ảnh giao nhận và số điện thoại tài xế…</p>
      )}
    </SheetShell>
  );
}

function buildTimeSlots(): string[] {
  const vnParts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Ho_Chi_Minh", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
  const currentMins = parseInt(vnParts.find(p => p.type === "hour")?.value ?? "0") * 60 + parseInt(vnParts.find(p => p.type === "minute")?.value ?? "0");
  const slots: string[] = [];
  for (let m = 0; m < 24 * 60; m += 5) {
    if (m <= currentMins) continue;
    const h = String(Math.floor(m / 60)).padStart(2, "0");
    const min = String(m % 60).padStart(2, "0");
    slots.push(`${h}:${min}`);
  }
  return slots;
}

export default function PscTinhPage() {
  const params = useParams();
  const code = (params.code as string)?.toUpperCase();
  const meta = PSC_META[code];

  // Completed trips open by default: it's the record staff come here to check.
  const [doneOpen, setDoneOpen] = useState(true);
  const [sheetOrder, setSheetOrder] = useState<Order | null>(null);

  const [options, setOptions] = useState<TplOption[]>([]);
  const [loadError, setLoadError] = useState("");
  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<Order | null>(null);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState("");

  const [selectedUuid, setSelectedUuid] = useState("");

  const [eta, setEta] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const loadOrders = useCallback(async () => {
    if (!code) return;
    setOrdersLoading(true);
    try {
      const res = await fetch(`/api/psc-tinh?psc=${code}&mode=orders`);
      const data = await res.json();
      setOrders(data.orders ?? []);
    } catch {
      setOrders([]);
    } finally {
      setOrdersLoading(false);
    }
  }, [code]);

  const loadOptions = useCallback(async () => {
    if (!code) return;
    try {
      const res = await fetch(`/api/psc-tinh?psc=${code}`);
      const data = await res.json();
      if (!res.ok) { setLoadError(data.error ?? "Lỗi tải dữ liệu"); return; }
      const opts: TplOption[] = data.options ?? [];
      setOptions(opts);
      if (opts.length === 1) {
        setSelectedUuid(opts[0].tpl_uuid);
      }
    } catch (e) {
      setLoadError(String(e));
    }
  }, [code]);

  useEffect(() => { loadOptions(); }, [loadOptions]);

  // One feed, so the list loads with the page instead of waiting for a tab switch.
  useEffect(() => { loadOrders(); }, [loadOrders]);

  if (!meta) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow border p-6 text-center space-y-2">
          <p className="text-red-600 font-semibold">PSC không hợp lệ</p>
          <p className="text-slate-500 text-sm">Code: {code}</p>
        </div>
      </div>
    );
  }

  const selectedOption = options.find((o) => o.tpl_uuid === selectedUuid);

  const selectTpl = (o: TplOption) => {
    setSelectedUuid(o.tpl_uuid);
  };

  const clearTpl = () => {
    setSelectedUuid("");
  };

  const submit = async () => {
    if (!selectedUuid || !eta) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/psc-tinh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          psc_code: meta.psc_code,
          psc_label: meta.label,
          tpl_uuid: selectedUuid,
          tpl_name: selectedOption?.tpl_name ?? "",
          eta,
          note,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult({ ok: false, msg: data.error ?? "Lỗi không xác định" });
      } else {
        setResult({ ok: true, msg: `Tạo thành công! ${data.reference} (Job #${data.job_id})` });
        setEta("");
        if (options.length > 1) clearTpl();
      }
    } catch (e) {
      setResult({ ok: false, msg: String(e) });
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!cancelTarget) return;
    setCancelLoading(true);
    setCancelError("");
    try {
      const res = await fetch(`/api/psc-tinh?job_id=${cancelTarget.job_id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setCancelError(data.error ?? "Huỷ thất bại");
        return;
      }
      setCancelTarget(null);
      await loadOrders();
    } catch {
      setCancelError("Không thể kết nối. Vui lòng thử lại.");
    } finally {
      setCancelLoading(false);
    }
  };

  const active = orders.filter((o) => stateOf(o) !== 3);
  const done = orders.filter((o) => stateOf(o) === 3);
  const canSubmit = selectedUuid && eta && !loading;
  const timeSlots = buildTimeSlots();

  return (
    <div className="min-h-screen bg-slate-100 flex justify-center">
      <div className="w-full max-w-[430px] px-4 pb-12">

        <header className="pt-5 pb-3.5 px-1">
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">{meta.label}</h1>
          <p className="text-sm text-slate-500 mt-0.5">Điểm đến: D001 — Cao Thắng</p>
        </header>

        <div className="flex items-center justify-end mb-3">
          <button onClick={loadOrders} disabled={ordersLoading}
            className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-semibold text-blue-700 bg-white shadow-sm active:bg-slate-50 disabled:opacity-50">
            <RefreshCw aria-hidden className={`w-4 h-4 ${ordersLoading ? "animate-spin" : ""}`} />
            Làm mới
          </button>
        </div>

        {/* Request form */}
        <div className="bg-white rounded-2xl shadow-sm p-4 mb-5">
          <div className="space-y-5">
            {loadError && (
              <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
                {loadError}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                  Điểm lấy mẫu (3PL)
                </label>
                <div className="space-y-2">
                  {options.length === 0 ? (
                    <p className="text-sm text-slate-500">Đang tải...</p>
                  ) : (
                    options.map((o) => (
                      <button
                        key={o.tpl_uuid}
                        type="button"
                        onClick={() => selectTpl(o)}
                        className={`w-full text-left rounded-xl border bg-white shadow-sm px-4 py-3 active:bg-slate-50 transition-colors ${
                          o.tpl_uuid === selectedUuid
                            ? "border-blue-500 ring-2 ring-blue-200"
                            : "border-slate-200"
                        }`}
                      >
                        <p className="text-base font-semibold text-slate-800">{o.tpl_name}</p>
                        {o.address && <p className="text-sm text-slate-500 mt-1 leading-snug">{o.address}</p>}
                      </button>
                    ))
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                  Thời gian tới nhà xe
                </label>
                <select
                  value={eta}
                  onChange={(e) => setEta(e.target.value)}
                  className="w-full border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
                >
                  <option value="">-- Chọn giờ --</option>
                  {timeSlots.map((slot) => (
                    <option key={slot} value={slot}>{slot}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                  Ghi chú đặc biệt
                </label>
                <p className="text-xs text-slate-500 mb-1.5">
                  Từ 2 thùng trở lên, mẫu khẩn, có mẫu cutoff lúc xx giờ....
                </p>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  className="w-full border rounded-xl px-3 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-slate-400 resize-none"
                />
              </div>
            </div>

            <button
              onClick={submit}
              disabled={!canSubmit}
              className="w-full rounded-2xl py-4 text-white text-lg font-extrabold flex items-center justify-center gap-2.5 bg-blue-700 active:scale-[.97] transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading
                ? <><Loader2 aria-hidden className="w-5 h-5 animate-spin" />Đang gửi…</>
                : <><Package aria-hidden className="w-5 h-5" />Gửi yêu cầu</>}
            </button>

            {result && (
              <div
                className={`rounded-xl p-3.5 text-sm font-medium text-center ${
                  result.ok
                    ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                    : "bg-red-50 border border-red-200 text-red-800"
                }`}
              >
                <span className="inline-flex items-center justify-center gap-1.5">
                  {result.ok ? <CheckCircle2 aria-hidden className="w-4 h-4 shrink-0" /> : <AlertCircle aria-hidden className="w-4 h-4 shrink-0" />}
                  {result.msg}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Live requests */}
        <div className="space-y-3">
          {active.map((o) => {
            const state = stateOf(o);
            const cancellable = state !== 4 && o.pickup_status_id === 1;
            return (
              <div key={o.job_id} className="rounded-2xl bg-white shadow-sm border border-slate-100 p-4">
                <button
                  onClick={() => setSheetOrder(o)}
                  aria-label={`Xem chi tiết ${mauLabel(o.reference)}`}
                  className="w-full text-left active:opacity-70"
                >
                  <div className="flex items-start justify-between gap-2.5">
                    <div className="min-w-0">
                      <p className="text-base font-extrabold tracking-tight text-slate-800">
                        {placeLabel(o.pickup_name ?? "3PL")} <ArrowRight aria-hidden className="inline w-4 h-4 text-slate-500 mx-0.5 shrink-0" /> D001
                      </p>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
                        <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-700">{mauLabel(o.reference)}</span>
                        {o.eta && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700">
                            <Clock aria-hidden className="w-3 h-3" />Hẹn {o.eta}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className={`flex-none text-[11px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${TRIP_STATE_STYLE[state]}`}>
                      {tripStateText(state, "D001")}
                    </span>
                  </div>

                  {state === 4 ? (
                    // A rejected trip never progressed, so the four-step bar would be a
                    // lie. The reason the driver gave is the only thing worth showing.
                    <div className="mt-2.5 rounded-xl bg-red-50 border border-red-200 p-3">
                      <p className="flex items-start gap-1.5 text-[13px] font-semibold text-red-700">
                        <XCircle aria-hidden className="w-4 h-4 shrink-0 mt-px" />
                        <span>
                          Đã từ chối{hm(o.rejected_ts) ? ` lúc ${hm(o.rejected_ts)}` : ""}
                          {o.rejected_reason ? ` — ${o.rejected_reason}` : ""}
                        </span>
                      </p>
                    </div>
                  ) : (
                    <TripSteps times={stepTimes(o)} state={state} />
                  )}

                  <div className="flex items-end justify-between gap-2 mt-2">
                    {o.pickup_address
                      ? <p className="text-[11px] text-slate-500 leading-snug flex-1 min-w-0">{o.pickup_address}</p>
                      : <span className="flex-1" />}
                    <ChevronRight aria-hidden className="w-4 h-4 text-slate-400 shrink-0" />
                  </div>
                </button>

                {cancellable && (
                  <button
                    onClick={() => { setCancelTarget(o); setCancelError(""); }}
                    className="w-full mt-3 py-2.5 rounded-xl text-xs font-bold text-red-600 border border-red-200 active:bg-red-50"
                  >
                    Huỷ yêu cầu
                  </button>
                )}
              </div>
            );
          })}
          {ordersLoading && !orders.length && (
            <p className="flex items-center justify-center gap-2 text-sm text-slate-500 py-7">
              <Loader2 aria-hidden className="w-4 h-4 animate-spin" />Đang tải…
            </p>
          )}
          {!ordersLoading && !active.length && (
            <p className="flex items-center justify-center gap-2 text-sm text-slate-500 py-7">
              <Clock aria-hidden className="w-4 h-4" />Chưa có yêu cầu nào đang chạy.
            </p>
          )}
        </div>

        {/* Completed today — open by default */}
        <div className="bg-white rounded-2xl shadow-sm mt-3 overflow-hidden">
          <button onClick={() => setDoneOpen((v) => !v)} aria-expanded={doneOpen}
            className="w-full flex items-center justify-between px-4 py-3.5 text-[15px] font-bold text-slate-800">
            <span className="flex items-center gap-2">
              <Check aria-hidden className="w-4 h-4 text-green-600" />
              Xong hôm nay <span className="text-green-600">({done.length})</span>
            </span>
            <ChevronDown aria-hidden className={`w-5 h-5 text-slate-500 transition-transform ${doneOpen ? "rotate-180" : ""}`} />
          </button>
          {doneOpen && (
            <div className="border-t border-slate-100">
              {done.length === 0 ? (
                <p className="text-center text-sm text-slate-500 py-6">Chưa có chuyến nào hoàn thành.</p>
              ) : done.map((o) => (
                <button
                  key={o.job_id}
                  onClick={() => setSheetOrder(o)}
                  aria-label={`Xem chi tiết ${mauLabel(o.reference)}`}
                  className="group w-full block px-4 py-3 border-t border-slate-100 first:border-t-0 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors"
                >
                  <span className="flex items-start gap-2.5">
                    <Check aria-hidden className="w-4 h-4 text-green-600 shrink-0 mt-0.5" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-semibold text-slate-800">
                        {placeLabel(o.pickup_name ?? "3PL")} <ArrowRight aria-hidden className="inline w-3.5 h-3.5 text-slate-500 mx-0.5 shrink-0" /> D001
                      </span>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-700">{mauLabel(o.reference)}</span>
                        {o.eta && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700">
                            <Clock aria-hidden className="w-3 h-3" />Hẹn {o.eta}
                          </span>
                        )}
                      </span>
                    </span>
                    <ChevronRight aria-hidden className="w-4 h-4 text-slate-400 shrink-0 mt-0.5 group-hover:text-slate-600 transition-colors" />
                  </span>
                  <TripSteps times={stepTimes(o)} state={3} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {sheetOrder && <PscJobSheet order={sheetOrder} onClose={() => setSheetOrder(null)} />}

      {/* Cancel confirm overlay */}
      {cancelTarget && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-5 space-y-4">
            <div className="space-y-1">
              <p className="text-sm font-bold text-slate-800">Huỷ yêu cầu?</p>
              <p className="text-xs text-slate-500 font-semibold">{cancelTarget.reference}</p>
              {cancelTarget.eta && (
                <p className="text-xs text-slate-500">Thời gian tới nhà xe: <span className="font-semibold text-slate-700">{cancelTarget.eta}</span></p>
              )}
              <p className="text-xs text-slate-500">Hành động này không thể hoàn tác.</p>
            </div>
            {cancelError && (
              <p className="text-xs text-red-600 font-medium">{cancelError}</p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => { setCancelTarget(null); setCancelError(""); }}
                disabled={cancelLoading}
                className="py-2.5 rounded-xl text-sm font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 transition-colors"
              >
                Quay lại
              </button>
              <button
                onClick={handleCancel}
                disabled={cancelLoading}
                className="py-2.5 rounded-xl text-sm font-bold bg-red-600 hover:bg-red-700 text-white disabled:opacity-40 transition-colors"
              >
                {cancelLoading ? "Đang huỷ..." : "Xác nhận huỷ"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
