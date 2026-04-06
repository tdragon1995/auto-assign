"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "next/navigation";

interface TplOption {
  tpl_uuid: string;
  tpl_name: string;
  address: string;
}

const PSC_META: Record<string, { label: string; psc_code: string }> = {
  D021: { label: "BRA - D021 (Mỹ Tho)", psc_code: "D021" },
  D023: { label: "BRA - D023 (Vũng Tàu)", psc_code: "D023" },
  D030: { label: "BRA - D030", psc_code: "D030" },
  D036: { label: "BRA - D036 (Tân An)", psc_code: "D036" },
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

  const [options, setOptions] = useState<TplOption[]>([]);
  const [loadError, setLoadError] = useState("");

  // 3PL searchable input state
  const [tplQuery, setTplQuery] = useState("");
  const [selectedUuid, setSelectedUuid] = useState("");
  const [tplOpen, setTplOpen] = useState(false);
  const tplRef = useRef<HTMLDivElement>(null);

  const [eta, setEta] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

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

  // Close dropdown on outside click
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

  const canSubmit = selectedUuid && eta && !loading;
  const timeSlots = buildTimeSlots();

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow border p-6 space-y-5">
        {/* Header */}
        <div>
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">Yêu cầu lấy mẫu</p>
          <h1 className="text-2xl font-bold text-slate-800 mt-0.5">{meta.label}</h1>
          <p className="text-sm text-slate-500 mt-1">Điểm đến: D001 — Cao Thắng</p>
        </div>

        {loadError && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
            {loadError}
          </div>
        )}

        <div className="space-y-4">
          {/* 3PL searchable dropdown */}
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

          {/* ETA */}
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
        </div>

        {/* Submit */}
        <button
          onClick={submit}
          disabled={!canSubmit}
          className="w-full py-3.5 rounded-xl font-bold text-white text-base bg-blue-600 hover:bg-blue-700 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          {loading ? "Đang tạo..." : "Gửi yêu cầu"}
        </button>

        {/* Result */}
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
    </div>
  );
}
