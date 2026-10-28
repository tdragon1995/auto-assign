"use client";

/**
 * "Kết quả bản cứng sắp nhận": the records AO printed to send back to this PSC, on the
 * page's day or the evening before (a sheet printed at night goes out the next morning),
 * so the PSC knows which results to expect. Read from AO's print history; loads with the
 * page and on the refresh button, no polling.
 */
import { useCallback, useEffect, useState } from "react";
import { FileText, RefreshCw } from "lucide-react";
import type { PscPrint } from "@/lib/ao-print-draft";

const OPEN_UP_TO = 8; // a longer list starts folded

const printedLabel = (iso: string) => {
  const d = new Date(iso);
  const opts = { timeZone: "Asia/Ho_Chi_Minh" } as const;
  return `${d.toLocaleTimeString("en-GB", { ...opts, hour: "2-digit", minute: "2-digit" })} ${d.toLocaleDateString("en-GB", { ...opts, day: "2-digit", month: "2-digit" })}`;
};

export function ExpectedResults({ pickup, date }: { pickup: string; date: string }) {
  const [prints, setPrints] = useState<PscPrint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ao/prints?psc=${encodeURIComponent(pickup)}&date=${date}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setPrints(data.prints ?? []);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [pickup, date]);
  useEffect(() => { void load(); }, [load]);

  const count = prints.reduce((n, p) => n + p.rows.length, 0);
  if (!count && !error) return null;
  return (
    <div className="bg-white rounded-2xl shadow-sm p-4 mb-5">
      <details open={count <= OPEN_UP_TO} className="group">
        <summary className="flex items-center justify-between gap-2 cursor-pointer list-none">
          <h2 className="text-[15px] font-bold text-slate-800 inline-flex items-center gap-2">
            <FileText aria-hidden className="w-4 h-4 text-slate-500" />Kết quả bản cứng sắp nhận ({count})
          </h2>
          <span className="text-xs font-semibold text-blue-700 group-open:hidden">Xem</span>
        </summary>
        <div className="flex items-start justify-between gap-2 mt-1">
          <p className="text-xs text-slate-500">Hồ sơ đã in để gửi về chi nhánh (hôm nay và tối hôm trước).</p>
          <button aria-label="Tải lại" onClick={() => void load()} disabled={loading} className="p-2 -m-2 text-slate-500 disabled:opacity-50">
            <RefreshCw aria-hidden className={`w-4 h-4 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`} />
          </button>
        </div>
        {error && <p role="alert" className="text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-xl p-3 my-2">Không tải được danh sách kết quả bản cứng.</p>}
        {prints.map((p) => (
          <div key={p.id} className="mt-3">
            <p className="text-xs font-semibold text-slate-600">In lúc {printedLabel(p.printedAt)} · {p.rows.length} hồ sơ</p>
            <ul className="divide-y divide-slate-100">
              {p.rows.map((r) => (
                <li key={`${r.vid}|${r.billing}`} className="py-2">
                  <p className="text-sm text-slate-800 break-words"><span className="font-mono text-slate-700">{r.vid}</span> · <span className="font-semibold">{r.patient || "—"}</span></p>
                  <p className="text-xs text-slate-600 break-words">{r.client}{r.billing ? ` — ${r.billing}` : ""}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </details>
    </div>
  );
}
