"use client";

/**
 * "Kết quả bản cứng sắp nhận": the records AO printed to send back to this PSC, on the
 * page's day or the evening before (a sheet printed at night goes out the next morning),
 * so the PSC knows which results to expect. Read from AO's print history; loads with the
 * page and on the refresh button, no polling.
 *
 * The PSC ticks each one off when the paper arrives ("Đã nhận"): stored on the printed
 * row, so every device at the branch sees it, and undoable from the folded list. The
 * print itself is never removed.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, FileText, RefreshCw } from "lucide-react";
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

  const [busy, setBusy] = useState("");
  const [tickError, setTickError] = useState(false);
  // Optimistic: the row moves at once, and moves back if the save fails.
  const tick = async (printId: string, idx: number, received: boolean) => {
    const k = `${printId}|${idx}`;
    const set = (v: boolean) => setPrints((ps) => ps.map((p) => p.id !== printId ? p : {
      ...p, rows: p.rows.map((r) => r.idx === idx ? { ...r, received_at: v ? new Date().toISOString() : null } : r),
    }));
    setBusy(k); setTickError(false); set(received);
    try {
      const res = await fetch("/api/ao/prints", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ psc: pickup, print_id: printId, idx, received }),
      });
      if (!res.ok) throw new Error();
    } catch {
      set(!received); setTickError(true);
    } finally {
      setBusy("");
    }
  };

  const all = prints.reduce((n, p) => n + p.rows.length, 0);
  const count = prints.reduce((n, p) => n + p.rows.filter((r) => !r.received_at).length, 0);
  const received = prints.flatMap((p) => p.rows.filter((r) => r.received_at).map((r) => ({ p, r })));
  if (!all && !error) return null;
  return (
    <div className="bg-white rounded-2xl shadow-sm p-4 mb-5">
      <details open={count > 0 && count <= OPEN_UP_TO} className="group">
        <summary className="flex items-center justify-between gap-2 cursor-pointer list-none">
          <h2 className="text-[15px] font-bold text-slate-800 inline-flex items-center gap-2">
            <FileText aria-hidden className="w-4 h-4 text-slate-500" />{count ? `Kết quả bản cứng sắp nhận (${count})` : `Kết quả bản cứng: đã nhận đủ (${all})`}
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
        {tickError && <p role="alert" className="text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-xl p-3 my-2">Không lưu được, vui lòng thử lại.</p>}
        {prints.filter((p) => p.rows.some((r) => !r.received_at)).map((p) => (
          <div key={p.id} className="mt-3">
            <p className="text-xs font-semibold text-slate-600">In lúc {printedLabel(p.printedAt)} · {p.rows.filter((r) => !r.received_at).length} hồ sơ</p>
            <ul className="divide-y divide-slate-100">
              {p.rows.filter((r) => !r.received_at).map((r) => (
                <li key={r.idx} className="flex items-center gap-3 py-2.5">
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-slate-800 break-words"><span className="font-mono text-slate-700">{r.vid}</span> · <span className="font-semibold">{r.patient || "—"}</span></span>
                    <span className="block text-xs text-slate-600 break-words">{r.client}{r.billing ? ` — ${r.billing}` : ""}</span>
                  </span>
                  <button onClick={() => void tick(p.id, r.idx, true)} disabled={busy === `${p.id}|${r.idx}`}
                    aria-label={`Đã nhận ${r.vid}`}
                    className="shrink-0 min-h-10 inline-flex items-center gap-1 px-3 rounded-xl text-[13px] font-bold text-green-700 border border-green-300 bg-green-50 active:bg-green-100 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-600">
                    <Check aria-hidden className="w-4 h-4" />Đã nhận
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {received.length > 0 && (
          <details className="mt-3 group/rcv">
            <summary className="cursor-pointer list-none text-xs font-semibold text-green-700 inline-flex items-center gap-1">
              <Check aria-hidden className="w-3.5 h-3.5" />Đã nhận ({received.length})
              <span className="text-slate-500 font-medium group-open/rcv:hidden">· xem</span>
            </summary>
            <ul className="mt-1 divide-y divide-slate-100">
              {received.map(({ p, r }) => (
                <li key={`${p.id}|${r.idx}`} className="flex items-center gap-3 py-2">
                  <span className="flex-1 min-w-0 text-sm text-slate-500 line-through break-words"><span className="font-mono">{r.vid}</span> · {r.patient || "—"}</span>
                  <button onClick={() => void tick(p.id, r.idx, false)} disabled={busy === `${p.id}|${r.idx}`}
                    aria-label={`Hoàn tác đã nhận ${r.vid}`}
                    className="shrink-0 min-h-9 px-2.5 rounded-lg text-[12px] font-semibold text-slate-600 border border-slate-200 active:bg-slate-50 disabled:opacity-50">
                    Hoàn tác
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </details>
    </div>
  );
}
