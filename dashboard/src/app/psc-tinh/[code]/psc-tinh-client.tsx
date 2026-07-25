"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Loader2, CheckCircle2, AlertCircle, Check, ChevronDown, Clock, Package, ArrowRight } from "lucide-react";
import { placeLabel } from "@/lib/place-label";
import { TripSteps, TRIP_STATE_STYLE, tripStateText, tripStateFromStops, type TripState } from "@/components/trip-steps";
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
}

const PSC_META: Record<string, { label: string; psc_code: string }> = {
  D021: { label: "BRA - D021 (Mỹ Tho)", psc_code: "D021" },
  D023: { label: "BRA - D023 (Vũng Tàu)", psc_code: "D023" },
  D030: { label: "BRA - D030", psc_code: "D030" },
  D036: { label: "BRA - D036 (Tân An)", psc_code: "D036" },
};

const hm = (ts?: string | null) => (ts ? ts.slice(11, 16) : null);

function stateOf(o: Order): TripState {
  return tripStateFromStops(o.pickup_status_id, o.dropoff_status_id);
}

// The first step falls back to the requested nhà-xe time when Cartrack gives no create_ts.
function stepTimes(o: Order) {
  return [hm(o.create_ts) ?? o.eta, hm(o.pickup_completed_ts), hm(o.dropoff_started_ts), hm(o.dropoff_completed_ts)];
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
            const cancellable = o.pickup_status_id === 1;
            return (
              <div key={o.job_id} className="rounded-2xl bg-white shadow-sm border border-slate-100 p-4">
                <div className="flex items-start justify-between gap-2.5">
                  <div className="min-w-0">
                    <p className="text-base font-extrabold tracking-tight text-slate-800">
                      {placeLabel(o.pickup_name ?? "3PL")} <ArrowRight aria-hidden className="inline w-4 h-4 text-slate-500 mx-0.5 shrink-0" /> D001
                    </p>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
                      <span className="text-[11px] font-semibold text-slate-500">{o.reference}</span>
                      {o.eta && <span className="text-[11px] font-semibold text-amber-700">Tới nhà xe {o.eta}</span>}
                    </div>
                  </div>
                  <span className={`flex-none text-[11px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${TRIP_STATE_STYLE[state]}`}>
                    {tripStateText(state, "D001")}
                  </span>
                </div>

                <TripSteps times={stepTimes(o)} state={state} />

                {o.pickup_address && (
                  <p className="text-[11px] text-slate-500 mt-2 leading-snug">{o.pickup_address}</p>
                )}

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
                <div key={o.job_id} className="px-4 py-3 border-t border-slate-100 first:border-t-0">
                  <span className="flex items-start gap-2.5">
                    <Check aria-hidden className="w-4 h-4 text-green-600 shrink-0 mt-0.5" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-semibold text-slate-800">
                        {placeLabel(o.pickup_name ?? "3PL")} <ArrowRight aria-hidden className="inline w-3.5 h-3.5 text-slate-500 mx-0.5 shrink-0" /> D001
                      </span>
                      <span className="block text-[11px] text-slate-500 mt-0.5">{o.reference}</span>
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
