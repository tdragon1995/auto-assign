"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";

interface TplOption {
  tpl_uuid: string;
  tpl_name: string;
  address: string;
}

// PSC metadata for display
const PSC_META: Record<string, { label: string; psc_code: string }> = {
  D021: { label: "BRA - D021 (Mỹ Tho)", psc_code: "D021" },
  D023: { label: "BRA - D023 (Vũng Tàu)", psc_code: "D023" },
  D030: { label: "BRA - D030", psc_code: "D030" },
  D036: { label: "BRA - D036 (Tân An)", psc_code: "D036" },
};

export default function PscTinhPage() {
  const params = useParams();
  const code = (params.code as string)?.toUpperCase();
  const meta = PSC_META[code];

  const [options, setOptions] = useState<TplOption[]>([]);
  const [loadError, setLoadError] = useState("");
  const [selectedUuid, setSelectedUuid] = useState("");
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
      // Auto-select if only one option
      if (opts.length === 1) setSelectedUuid(opts[0].tpl_uuid);
    } catch (e) {
      setLoadError(String(e));
    }
  }, [code]);

  useEffect(() => { loadOptions(); }, [loadOptions]);

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
        // Reset selection only if multiple options
        if (options.length > 1) setSelectedUuid("");
      }
    } catch (e) {
      setResult({ ok: false, msg: String(e) });
    } finally {
      setLoading(false);
    }
  };

  const canSubmit = selectedUuid && eta && !loading;

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
          {/* 3PL pickup location */}
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">
              Điểm lấy mẫu (3PL)
            </label>
            {options.length === 0 ? (
              <p className="text-sm text-slate-400">Đang tải...</p>
            ) : options.length === 1 ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                <p className="text-sm font-medium text-slate-800">{options[0].tpl_name}</p>
                {options[0].address && (
                  <p className="text-xs text-slate-500 mt-0.5">{options[0].address}</p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {options.map((o) => (
                  <button
                    key={o.tpl_uuid}
                    type="button"
                    onClick={() => setSelectedUuid(o.tpl_uuid)}
                    className={`w-full text-left rounded-xl border px-3 py-2.5 transition-all ${
                      selectedUuid === o.tpl_uuid
                        ? "border-blue-500 bg-blue-50 ring-1 ring-blue-400"
                        : "border-slate-200 bg-white hover:border-slate-300"
                    }`}
                  >
                    <p className="text-sm font-medium text-slate-800">{o.tpl_name}</p>
                    {o.address && (
                      <p className="text-xs text-slate-500 mt-0.5">{o.address}</p>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ETA */}
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">
              ETA — Giờ lấy mẫu dự kiến
            </label>
            <input
              type="time"
              value={eta}
              onChange={(e) => setEta(e.target.value)}
              className="w-full border rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
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
