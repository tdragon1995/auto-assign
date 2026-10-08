"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Loader2, CheckCircle2, AlertCircle, Check, ChevronDown, Clock, Package, ArrowRight } from "lucide-react";
import { placeLabel } from "@/lib/place-label";
import { HardCopyHandover } from "@/components/hard-copy-handover";
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
      <div className="flex flex-wrap items-start justify-between gap-2.5">
        <div className="min-w-[12rem] flex-1">
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

function VendorRequests() {
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
    <div className="mx-auto max-w-5xl px-4 pb-12">
        <header className="pt-5 pb-5">
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">Lấy kết quả giấy</h1>
          <p className="text-sm text-slate-500 mt-0.5">Từ nhà cung cấp về Diag</p>
        </header>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-start">
        <section className="min-w-0 rounded-2xl bg-white p-4 shadow-sm sm:p-5">
          <h2 className="text-base font-bold text-slate-900">Tạo yêu cầu</h2>
          <fieldset className="mt-4">
            <legend className="mb-2 text-sm font-semibold text-slate-700">Nhà cung cấp</legend>
            <div className="grid gap-1 sm:grid-cols-2">
            {VENDORS.map((v) => (
              <button
                key={v.uuid}
                type="button"
                onClick={() => setSelectedUuid(v.uuid)}
                aria-pressed={v.uuid === selectedUuid}
                className={`flex min-h-14 w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 ${
                  v.uuid === selectedUuid
                    ? "bg-blue-50 text-blue-900 ring-1 ring-inset ring-blue-500"
                    : "text-slate-800 hover:bg-slate-50 active:bg-slate-100"
                }`}
              >
                <span>{v.name}</span>
                <span aria-hidden className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${v.uuid === selectedUuid ? "border-blue-700 bg-blue-700 text-white" : "border-slate-300"}`}>
                  {v.uuid === selectedUuid && <Check className="h-3 w-3" />}
                </span>
              </button>
            ))}
            </div>
          </fieldset>

          <label htmlFor="ao-request-note" className="mt-5 block text-sm font-semibold text-slate-700">Ghi chú <span className="font-normal text-slate-500">(tuỳ chọn)</span></label>
          <textarea
            id="ao-request-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-700 resize-none focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400"
          />

          <button
            onClick={submit}
            disabled={!selectedUuid || loading}
            className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-blue-700 px-4 py-3 text-sm font-bold text-white transition active:scale-[.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:opacity-40"
          >
            {loading
              ? <><Loader2 aria-hidden className="w-4 h-4 animate-spin" />Đang gửi…</>
              : <><Package aria-hidden className="w-4 h-4" />Gửi yêu cầu</>}
          </button>

          {result && (
            <p
              role="alert"
              className={`mt-4 flex items-start gap-2 rounded-xl p-3 text-sm font-medium ${
                result.ok
                  ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                  : "bg-red-50 border border-red-200 text-red-800"
              }`}
            >
              {result.ok ? <CheckCircle2 aria-hidden className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertCircle aria-hidden className="w-4 h-4 shrink-0 mt-0.5" />}
              {result.msg}
            </p>
          )}
        </section>

        <section className="min-w-0 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-bold text-slate-900">Đang thực hiện <span className="text-slate-500">({active.length})</span></h2>
          <button
            onClick={loadOrders}
            disabled={ordersLoading}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:opacity-50"
          >
            <RefreshCw aria-hidden className={`w-4 h-4 ${ordersLoading ? "animate-spin" : ""}`} />
            Làm mới
          </button>
        </div>
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
            <p className="flex items-center justify-center gap-2 rounded-2xl bg-white py-7 text-center text-sm text-slate-500 shadow-sm">
              <Clock aria-hidden className="w-4 h-4" />Chưa có yêu cầu nào đang chạy.
            </p>
          )}
        </div>

        {/* Completed today — open by default; it's the record staff come here to check */}
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm">
          <button onClick={() => setDoneOpen((v) => !v)} aria-expanded={doneOpen}
            className="flex min-h-12 w-full items-center justify-between px-4 py-3.5 text-[15px] font-bold text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700">
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
        </section>
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

const TABS = [
  { id: "hardcopy", label: "Kết Quả Bản Cứng" },
  { id: "requests", label: "Lấy kết quả giấy" },
] as const;

export default function AoPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("hardcopy");
  // The trip feed is fetched only once its tab is first opened.
  const [requestsOpened, setRequestsOpened] = useState(false);
  return (
    <div className="min-h-screen bg-slate-100">
      <nav role="tablist" className="mx-auto flex max-w-5xl gap-1 px-4 pt-5">
        <div className="inline-flex rounded-xl bg-white shadow-sm p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => { setTab(t.id); if (t.id === "requests") setRequestsOpened(true); }}
              className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
                tab === t.id ? "bg-blue-700 text-white" : "text-slate-600 active:bg-slate-100"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>
      {/* Once opened, both stay mounted so switching tabs keeps pasted VIDs and doesn't refetch the trip feed. */}
      <div hidden={tab !== "requests"}>{requestsOpened && <VendorRequests />}</div>
      <div hidden={tab !== "hardcopy"} className="max-w-5xl mx-auto px-4 pt-5 pb-12"><HardCopyHandover /></div>
    </div>
  );
}
