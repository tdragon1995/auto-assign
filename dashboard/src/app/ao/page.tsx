"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Loader2, CheckCircle2, AlertCircle, Check, ChevronDown, Clock, Package, ArrowRight } from "lucide-react";
import { placeLabel } from "@/lib/place-label";
import { TripSteps, TRIP_STATE_STYLE, tripStateText, tripStateFromStops, type TripState } from "@/components/trip-steps";

const VENDORS = [
  { name: "Medic Karyotype",             uuid: "49642318-38ae-11ed-91d5-506b8dbc8dfb" },
  { name: "Bệnh Viện Nhiệt Đới",        uuid: "ce8fbd00-2439-11ee-8a2d-506b8d9879b5" },
  { name: "Trí Việt",                    uuid: "d81aa368-1210-11f1-9378-fa163ee8d8ac" },
  { name: "Trung tâm Pháp Y",           uuid: "9ae5f732-1cbb-11ef-967b-506b8d9879b5" },
  { name: "Bệnh Viện Da Liễu",          uuid: "1bc194a8-1f47-11f1-9378-fa163ee8d8ac" },
  { name: "Thu Hồi Mẫu Bệnh Viện Bưu Điện", uuid: "be7d54b2-4d09-11f1-9378-fa163ee8d8ac" },
  { name: "Thu Hồi Mẫu Đại Học Y Dược",     uuid: "51742f2e-1748-11ef-808b-506b8d9879b5" },
  { name: "Bệnh Viện Chợ Rẫy",          uuid: "5c8efb94-38ad-11ed-b146-506b8dbc8dfb" },
];

interface Order {
  job_id: number;
  job_status: string;
  vendor_name: string;
  pickup_stop_id: number | null;
  pickup_status_id: number | null;
  dropoff_name: string;
  dropoff_status: string;
  dropoff_color: string;
  dropoff_status_id: number | null;
  dropoff_update_ts: string | null;
  pickup_completed_ts: string | null;
  dropoff_started_ts: string | null;
  dropoff_completed_ts: string | null;
  create_ts: string | null;
}

const hm = (ts?: string | null) => (ts ? ts.slice(11, 16) : null);

function stateOf(o: Order): TripState {
  return tripStateFromStops(o.pickup_status_id, o.dropoff_status_id);
}

function stepTimes(o: Order) {
  return [hm(o.create_ts), hm(o.pickup_completed_ts), hm(o.dropoff_started_ts), hm(o.dropoff_completed_ts)];
}

function OrderCard({ order, onCancel }: { order: Order; onCancel: (o: Order) => void }) {
  const state = stateOf(order);
  // Cancellable only while the vendor pickup hasn't been started.
  const cancellable = order.pickup_status_id === 1;

  return (
    <div className="rounded-2xl bg-white shadow-sm border border-slate-100 p-4">
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <p className="text-base font-extrabold tracking-tight text-slate-800">
            {placeLabel(order.vendor_name)} <ArrowRight aria-hidden className="inline w-4 h-4 text-slate-500 mx-0.5 shrink-0" /> {placeLabel(order.dropoff_name)}
          </p>
          <p className="text-[11px] font-semibold text-slate-500 mt-0.5">
            Yêu cầu lúc {hm(order.create_ts) ?? "—"} · #{order.job_id}
          </p>
        </div>
        <span className={`flex-none text-[11px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${TRIP_STATE_STYLE[state]}`}>
          {tripStateText(state, placeLabel(order.dropoff_name))}
        </span>
      </div>

      <TripSteps times={stepTimes(order)} state={state} />

      {cancellable && (
        <button
          onClick={() => onCancel(order)}
          className="w-full mt-3 py-2.5 rounded-xl text-xs font-bold text-red-600 border border-red-200 active:bg-red-50"
        >
          Huỷ yêu cầu
        </button>
      )}
    </div>
  );
}

export default function AoPage() {
  const [selectedUuid, setSelectedUuid] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [doneOpen, setDoneOpen] = useState(true);

  const [cancelTarget, setCancelTarget] = useState<Order | null>(null);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState("");

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    try {
      const res = await fetch("/api/ao?mode=orders");
      const data = await res.json();
      setOrders(data.orders ?? []);
    } catch {
      setOrders([]);
    } finally {
      setOrdersLoading(false);
    }
  }, []);

  // One feed, so the list loads with the page instead of waiting for a tab switch.
  useEffect(() => { loadOrders(); }, [loadOrders]);

  const submit = async () => {
    if (!selectedUuid || loading) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/ao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor_uuid: selectedUuid, note: note.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult({ ok: false, msg: data.message ?? data.error ?? "Lỗi không xác định" });
      } else {
        const vendorName = VENDORS.find((v) => v.uuid === selectedUuid)?.name ?? "";
        setResult({ ok: true, msg: `Đã gửi yêu cầu — ${vendorName}` });
        setSelectedUuid("");
        setNote("");
        loadOrders();
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
      const res = await fetch(`/api/ao?job_id=${cancelTarget.job_id}`, { method: "DELETE" });
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

  return (
    <div className="min-h-screen bg-slate-100 flex justify-center">
      <div className="w-full max-w-[430px] px-4 pb-12">

        <header className="pt-5 pb-3.5 px-1">
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">Lấy kết quả giấy</h1>
          <p className="text-sm text-slate-500 mt-0.5">Từ nhà cung cấp về Diag</p>
        </header>

        <div className="flex items-center justify-end mb-3">
          <button
            onClick={loadOrders}
            disabled={ordersLoading}
            className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-semibold text-blue-700 bg-white shadow-sm active:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw aria-hidden className={`w-4 h-4 ${ordersLoading ? "animate-spin" : ""}`} />
            Làm mới
          </button>
        </div>

        {/* Request form */}
        <div className="bg-white rounded-2xl shadow-sm p-4 mb-5 space-y-4">
          <div className="space-y-2">
            {VENDORS.map((v) => (
              <button
                key={v.uuid}
                type="button"
                onClick={() => setSelectedUuid(v.uuid)}
                aria-pressed={v.uuid === selectedUuid}
                className={`w-full text-left rounded-xl border px-4 py-3 transition-colors ${
                  v.uuid === selectedUuid
                    ? "border-blue-500 bg-blue-50 ring-2 ring-blue-200"
                    : "border-slate-200 bg-white active:bg-slate-50"
                }`}
              >
                <span className="flex items-center gap-2">
                  {v.uuid === selectedUuid && <Check aria-hidden className="w-4 h-4 text-blue-600 shrink-0" />}
                  <span className="text-base font-semibold text-slate-800">{v.name}</span>
                </span>
              </button>
            ))}
          </div>

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Ghi chú (tuỳ chọn)"
            rows={2}
            aria-label="Ghi chú"
            className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-700 placeholder-slate-500 resize-none focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400"
          />

          <button
            onClick={submit}
            disabled={!selectedUuid || loading}
            className="w-full rounded-2xl py-4 text-white text-lg font-extrabold flex items-center justify-center gap-2.5 bg-blue-700 active:scale-[.97] transition disabled:opacity-40"
          >
            {loading
              ? <><Loader2 aria-hidden className="w-5 h-5 animate-spin" />Đang gửi…</>
              : <><Package aria-hidden className="w-5 h-5" />Gửi yêu cầu</>}
          </button>

          {result && (
            <p
              role="alert"
              className={`flex items-start gap-2 rounded-xl p-3 text-sm font-medium ${
                result.ok
                  ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                  : "bg-red-50 border border-red-200 text-red-800"
              }`}
            >
              {result.ok ? <CheckCircle2 aria-hidden className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertCircle aria-hidden className="w-4 h-4 shrink-0 mt-0.5" />}
              {result.msg}
            </p>
          )}
        </div>

        {/* Live requests */}
        <div className="space-y-3">
          {active.map((o) => (
            <OrderCard key={o.job_id} order={o} onCancel={(t) => { setCancelTarget(t); setCancelError(""); }} />
          ))}
          {ordersLoading && !orders.length && (
            <p className="flex items-center justify-center gap-2 text-sm text-slate-500 py-7">
              <Loader2 aria-hidden className="w-4 h-4 animate-spin" />Đang tải…
            </p>
          )}
          {!ordersLoading && !active.length && (
            <p className="flex items-center justify-center gap-2 text-center text-sm text-slate-500 py-7">
              <Clock aria-hidden className="w-4 h-4" />Chưa có yêu cầu nào đang chạy.
            </p>
          )}
        </div>

        {/* Completed today — open by default; it's the record staff come here to check */}
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
                <p className="text-center text-sm text-slate-500 py-6">Chưa có yêu cầu nào hoàn thành.</p>
              ) : done.map((o) => (
                <div key={o.job_id} className="px-4 py-3 border-t border-slate-100 first:border-t-0">
                  <span className="flex items-start gap-2.5">
                    <Check aria-hidden className="w-4 h-4 text-green-600 shrink-0 mt-0.5" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-semibold text-slate-800">
                        {placeLabel(o.vendor_name)} <ArrowRight aria-hidden className="inline w-3.5 h-3.5 text-slate-500 mx-0.5 shrink-0" /> {placeLabel(o.dropoff_name)}
                      </span>
                      <span className="block text-[11px] text-slate-500 mt-0.5">#{o.job_id}</span>
                    </span>
                  </span>
                  <TripSteps times={stepTimes(o)} state={3} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Cancel confirm overlay */}
      {cancelTarget && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-4"
          onClick={() => { if (!cancelLoading) { setCancelTarget(null); setCancelError(""); } }}>
          <div role="dialog" aria-modal="true" className="w-full max-w-sm bg-white rounded-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="space-y-1">
              <p className="text-base font-bold text-slate-800">Huỷ yêu cầu?</p>
              <p className="text-xs text-slate-500 font-semibold">
                {cancelTarget.vendor_name} → {cancelTarget.dropoff_name}
              </p>
              <p className="text-xs text-slate-500">Hành động này không thể hoàn tác.</p>
            </div>
            {cancelError && <p role="alert" className="text-xs text-red-600 font-medium">{cancelError}</p>}
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => { setCancelTarget(null); setCancelError(""); }}
                disabled={cancelLoading}
                className="py-3 rounded-xl text-sm font-semibold border border-slate-200 text-slate-600 disabled:opacity-40"
              >
                Quay lại
              </button>
              <button
                onClick={handleCancel}
                disabled={cancelLoading}
                className="py-3 rounded-xl text-sm font-bold bg-red-600 text-white disabled:opacity-40"
              >
                {cancelLoading ? "Đang huỷ…" : "Xác nhận huỷ"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
