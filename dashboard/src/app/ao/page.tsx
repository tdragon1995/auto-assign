"use client";

import { useState, useEffect, useCallback } from "react";

const VENDORS = [
  { name: "Bệnh Viện Da Liễu", uuid: "1bc194a8-1f47-11f1-9378-fa163ee8d8ac", dropoff_label: "D001" },
  { name: "Bệnh Viện Chợ Rẫy", uuid: "5c8efb94-38ad-11ed-b146-506b8dbc8dfb", dropoff_label: "D001" },
  { name: "Trung tâm Pháp Y",  uuid: "9ae5f732-1cbb-11ef-967b-506b8d9879b5", dropoff_label: "D010" },
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
  dropoff_update_ts: string | null;
}

const COLOR_CLASS: Record<string, string> = {
  slate:  "bg-slate-200 text-slate-700",
  blue:   "bg-blue-100 text-blue-700",
  indigo: "bg-indigo-100 text-indigo-700",
  green:  "bg-green-100 text-green-700",
  red:    "bg-red-100 text-red-700",
};

export default function AoPage() {
  const [tab, setTab] = useState<"request" | "status">("request");

  const [selectedUuid, setSelectedUuid] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [highlightJobId, setHighlightJobId] = useState<number | null>(null);

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

  useEffect(() => {
    if (tab === "status") loadOrders();
  }, [tab, loadOrders]);

  const submit = async () => {
    if (!selectedUuid || loading) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/ao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor_uuid: selectedUuid }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult({ ok: false, msg: data.message ?? data.error ?? "Lỗi không xác định" });
      } else {
        setResult({ ok: true, msg: `Tạo thành công! Job #${data.job_id}` });
        setSelectedUuid("");
        setHighlightJobId(data.job_id ?? null);
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

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col items-center p-4 gap-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow border overflow-hidden">

        {/* Header */}
        <div className="px-6 pt-5 pb-4">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">Kết quả giấy</p>
          <h1 className="text-xl font-bold text-slate-800 mt-0.5">Lấy kết quả từ nhà cung cấp</h1>
          <p className="text-sm text-slate-500">Điểm nhận: D001 / D010 — Cao Thắng</p>
        </div>

        {/* Tab switcher */}
        <div className="grid grid-cols-2 border-t border-slate-100">
          <button
            onClick={() => setTab("request")}
            className={`py-2.5 text-sm font-semibold transition-colors ${
              tab === "request" ? "bg-blue-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
            }`}
          >
            Tạo yêu cầu
          </button>
          <button
            onClick={() => setTab("status")}
            className={`py-2.5 text-sm font-semibold transition-colors border-l border-slate-100 ${
              tab === "status" ? "bg-blue-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
            }`}
          >
            Xem trạng thái
          </button>
        </div>

        {/* Request tab */}
        {tab === "request" && (
          <div className="p-6 space-y-5">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                Nhà cung cấp kết quả
              </label>
              <div className="space-y-2">
                {VENDORS.map((v) => (
                  <button
                    key={v.uuid}
                    type="button"
                    onClick={() => setSelectedUuid(v.uuid)}
                    className={`w-full text-left rounded-xl border bg-white shadow-sm px-4 py-3 active:bg-slate-50 transition-colors ${
                      v.uuid === selectedUuid
                        ? "border-blue-500 ring-2 ring-blue-200"
                        : "border-slate-200"
                    }`}
                  >
                    <p className="text-base font-semibold text-slate-800">{v.name}</p>
                    <p className="text-sm text-slate-500 mt-0.5">Giao tới: {v.dropoff_label}</p>
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={submit}
              disabled={!selectedUuid || loading}
              className="w-full py-3.5 rounded-xl font-bold text-white text-base bg-blue-600 hover:bg-blue-700 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              {loading ? "Đang tạo..." : "Gửi yêu cầu"}
            </button>

            {result && (
              <div
                className={`rounded-xl p-3.5 text-sm font-medium text-center ${
                  result.ok
                    ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                    : "bg-red-50 border border-red-200 text-red-800"
                }`}
              >
                {result.msg}
              </div>
            )}
          </div>
        )}

        {/* Status tab */}
        {tab === "status" && (
          <div className="p-5 space-y-3">
            <div className="flex justify-end">
              <button onClick={loadOrders} className="text-xs text-blue-500 hover:underline">
                Làm mới
              </button>
            </div>
            {ordersLoading ? (
              <p className="text-xs text-slate-400 text-center py-4">Đang tải...</p>
            ) : orders.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-4">Chưa có yêu cầu nào hôm nay.</p>
            ) : (
              <div className="space-y-2">
                {orders.map((o) => (
                  <div
                    key={o.job_id}
                    className={`rounded-xl border px-3 py-2.5 space-y-1 transition-colors ${
                      o.job_id === highlightJobId
                        ? "border-blue-400 bg-blue-50 ring-2 ring-blue-300"
                        : "border-slate-100 bg-slate-50"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-800">{o.vendor_name}</span>
                      <span className="text-[11px] text-slate-400">#{o.job_id}</span>
                    </div>
                    <div className="flex items-center justify-between gap-1.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span
                          className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md ${
                            COLOR_CLASS[o.dropoff_color] ?? COLOR_CLASS.slate
                          }`}
                        >
                          {o.dropoff_name}: {o.dropoff_status}
                        </span>
                        {o.dropoff_update_ts && (
                          <span className="text-[10px] text-slate-400">
                            {o.dropoff_update_ts.slice(11, 16)}
                          </span>
                        )}
                      </div>
                      {o.pickup_status_id === 1 && (
                        <button
                          onClick={() => { setCancelTarget(o); setCancelError(""); }}
                          className="text-xs font-bold px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors whitespace-nowrap"
                        >
                          Huỷ
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Cancel confirm overlay */}
      {cancelTarget && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-5 space-y-4">
            <div className="space-y-1">
              <p className="text-sm font-bold text-slate-800">Huỷ yêu cầu?</p>
              <p className="text-xs text-slate-500 font-semibold">
                {cancelTarget.vendor_name} → {cancelTarget.dropoff_name}
              </p>
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
