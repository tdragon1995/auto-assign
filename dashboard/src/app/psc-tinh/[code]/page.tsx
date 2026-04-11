"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
}

const PSC_META: Record<string, { label: string; psc_code: string }> = {
  D021: { label: "BRA - D021 (Mỹ Tho)", psc_code: "D021" },
  D023: { label: "BRA - D023 (Vũng Tàu)", psc_code: "D023" },
  D030: { label: "BRA - D030", psc_code: "D030" },
  D036: { label: "BRA - D036 (Tân An)", psc_code: "D036" },
};

const COLOR_CLASS: Record<string, string> = {
  slate:  "bg-slate-200 text-slate-700",
  blue:   "bg-blue-100 text-blue-700",
  indigo: "bg-indigo-100 text-indigo-700",
  green:  "bg-green-100 text-green-700",
  red:    "bg-red-100 text-red-700",
};

function buildTimeSlots(): string[] {
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const currentMins = now.getUTCHours() * 60 + now.getUTCMinutes();
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

  const [tab, setTab] = useState<"request" | "status">("request");

  const [options, setOptions] = useState<TplOption[]>([]);
  const [loadError, setLoadError] = useState("");
  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [editTarget, setEditTarget] = useState<Order | null>(null);
  const [editEta, setEditEta] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState("");

  const [tplQuery, setTplQuery] = useState("");
  const [selectedUuid, setSelectedUuid] = useState("");
  const [tplOpen, setTplOpen] = useState(false);
  const tplRef = useRef<HTMLDivElement>(null);

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
        setTplQuery(opts[0].tpl_name);
      }
    } catch (e) {
      setLoadError(String(e));
    }
  }, [code]);

  useEffect(() => { loadOptions(); }, [loadOptions]);

  useEffect(() => {
    if (tab === "status") loadOrders();
  }, [tab, loadOrders]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (tplRef.current && !tplRef.current.contains(e.target as Node)) {
        setTplOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

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
  const filtered = options.filter(
    (o) =>
      o.tpl_name.toLowerCase().includes(tplQuery.toLowerCase()) ||
      o.address.toLowerCase().includes(tplQuery.toLowerCase())
  );

  const selectTpl = (o: TplOption) => {
    setSelectedUuid(o.tpl_uuid);
    setTplQuery(o.tpl_name);
    setTplOpen(false);
  };

  const clearTpl = () => {
    setSelectedUuid("");
    setTplQuery("");
    setTplOpen(false);
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

  const handleEditEta = async () => {
    if (!editTarget || !editEta) return;
    setEditLoading(true);
    setEditError("");
    try {
      const res = await fetch("/api/psc-tinh", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: editTarget.job_id, stop_id: editTarget.pickup_stop_id, eta: editEta }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setEditError(data.error ?? "Cập nhật thất bại");
        return;
      }
      setEditTarget(null);
      setEditEta("");
      await loadOrders();
    } catch {
      setEditError("Không thể kết nối. Vui lòng thử lại.");
    } finally {
      setEditLoading(false);
    }
  };

  const canSubmit = selectedUuid && eta && !loading;
  const timeSlots = buildTimeSlots();

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col items-center p-4 gap-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow border overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-5 pb-4">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">Vận chuyển mẫu tỉnh</p>
          <h1 className="text-xl font-bold text-slate-800 mt-0.5">{meta.label}</h1>
          <p className="text-sm text-slate-500">Điểm đến: D001 — Cao Thắng</p>
        </div>

        {/* Tab switcher */}
        <div className="grid grid-cols-2 border-t border-slate-100">
          <button
            onClick={() => setTab("request")}
            className={`py-2.5 text-sm font-semibold transition-colors ${
              tab === "request"
                ? "bg-blue-600 text-white"
                : "bg-white text-slate-500 hover:bg-slate-50"
            }`}
          >
            Tạo yêu cầu
          </button>
          <button
            onClick={() => setTab("status")}
            className={`py-2.5 text-sm font-semibold transition-colors border-l border-slate-100 ${
              tab === "status"
                ? "bg-blue-600 text-white"
                : "bg-white text-slate-500 hover:bg-slate-50"
            }`}
          >
            Xem trạng thái
          </button>
        </div>

        {/* Request tab */}
        {tab === "request" && (
          <div className="p-6 space-y-5">
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
                <div className="relative" ref={tplRef}>
                  <input
                    type="text"
                    value={tplQuery}
                    onChange={(e) => { setTplQuery(e.target.value); setSelectedUuid(""); setTplOpen(true); }}
                    onFocus={() => setTplOpen(true)}
                    placeholder="Tìm điểm lấy mẫu..."
                    className="w-full border rounded-xl px-3 py-2.5 pr-8 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
                  />
                  {tplQuery && (
                    <button
                      type="button"
                      onClick={clearTpl}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-lg leading-none"
                    >
                      ×
                    </button>
                  )}
                  {tplOpen && filtered.length > 0 && (
                    <ul className="absolute z-10 w-full mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-52 overflow-y-auto">
                      {filtered.map((o) => (
                        <li
                          key={o.tpl_uuid}
                          onMouseDown={() => selectTpl(o)}
                          className="px-3 py-2.5 cursor-pointer hover:bg-slate-50"
                        >
                          <p className="text-sm font-medium text-slate-800">{o.tpl_name}</p>
                          {o.address && <p className="text-xs text-slate-500 mt-0.5">{o.address}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                  ETA — Giờ lấy mẫu dự kiến
                </label>
                <select
                  value={eta}
                  onChange={(e) => setEta(e.target.value)}
                  className="w-full border rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
                >
                  <option value="">-- Chọn giờ --</option>
                  {timeSlots.map((slot) => (
                    <option key={slot} value={slot}>{slot}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                  Ghi chú
                </label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  placeholder="VD: 1 thùng, 2 thùng, 3 thùng, mẫu khẩn, cutoff 11h..."
                  className="w-full border rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-400 resize-none"
                />
              </div>
            </div>

            <button
              onClick={submit}
              disabled={!canSubmit}
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
              <button onClick={loadOrders} className="text-xs text-blue-500 hover:underline">Làm mới</button>
            </div>
            {ordersLoading ? (
              <p className="text-xs text-slate-400 text-center py-4">Đang tải...</p>
            ) : orders.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-4">Chưa có yêu cầu nào hôm nay.</p>
            ) : (
              <div className="space-y-2">
                {orders.map((o) => (
                  <div key={o.job_id} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2.5 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-800">{o.reference}</span>
                      {o.eta && <span className="text-xs text-slate-400">ETA {o.eta}</span>}
                    </div>
                    {o.pickup_address && (
                      <p className="text-[11px] text-slate-500">{o.pickup_address}</p>
                    )}
                    <div className="flex items-center justify-between gap-1.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md ${COLOR_CLASS[o.dropoff_color]}`}>
                          Giao D001: {o.dropoff_status}
                        </span>
                        {o.dropoff_update_ts && (
                          <span className="text-[10px] text-slate-400">
                            {o.dropoff_update_ts.slice(11, 16)}
                          </span>
                        )}
                      </div>
                      {o.pickup_status_id === 1 && (
                        <button
                          onClick={() => { setEditTarget(o); setEditEta(o.eta ?? ""); setEditError(""); }}
                          className="text-[10px] font-medium text-blue-500 hover:text-blue-700 whitespace-nowrap"
                        >
                          Sửa ETA
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

      {/* Edit ETA overlay */}
      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-5 space-y-4">
            <div className="space-y-1">
              <p className="text-sm font-bold text-slate-800">Sửa giờ lấy mẫu (ETA)</p>
              <p className="text-xs text-slate-500 font-semibold">{editTarget.reference}</p>
            </div>
            <select
              value={editEta}
              onChange={(e) => setEditEta(e.target.value)}
              className="w-full border rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              <option value="">-- Chọn giờ mới --</option>
              {buildTimeSlots().map((slot) => (
                <option key={slot} value={slot}>{slot}</option>
              ))}
            </select>
            {editError && (
              <p className="text-xs text-red-600 font-medium">{editError}</p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => { setEditTarget(null); setEditEta(""); setEditError(""); }}
                disabled={editLoading}
                className="py-2.5 rounded-xl text-sm font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 transition-colors"
              >
                Huỷ
              </button>
              <button
                onClick={handleEditEta}
                disabled={editLoading || !editEta}
                className="py-2.5 rounded-xl text-sm font-bold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 transition-colors"
              >
                {editLoading ? "Đang lưu..." : "Xác nhận"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
