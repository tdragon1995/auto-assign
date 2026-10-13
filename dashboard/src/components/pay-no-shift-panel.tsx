"use client";

/**
 * Lương PT → "Sửa nhanh": every day a PT driver worked with no shift, beside what
 * the day itself shows (check-in/out, first/last trip) and a suggested window.
 * One click approves it as a supervisor "cập nhật công" — the same correction the
 * Cập nhật công panel makes, so it pays the day outright and no shift sync can
 * undo it. A day with a driver's request already waiting is left to that panel.
 */
import { useState } from "react";
import { Loader2, Check } from "lucide-react";

export interface NoShiftDay {
  driver_id: string; driver_name: string; date: string;
  first_in: string | null; last_out: string | null; first_task: string | null; last_task: string | null;
  suggest_in: string | null; suggest_out: string | null; pending: boolean;
}

const WEEKDAY = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const fmtDay = (d: string) => `${WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${d.slice(8, 10)}/${d.slice(5, 7)}`;
const shortName = (full: string) => full.replace(/^[A-Z]{1,3}\s*-\s*[A-Z]{1,3}\s*-\s*/, "");
const span = (a: string | null, b: string | null) => (a || b ? `${a ?? "—"} – ${b ?? "—"}` : "—");
const keyOf = (d: NoShiftDay) => `${d.driver_id}|${d.date}`;
const NOTE = "Sửa nhanh: ngày làm không có ca — giờ theo chấm công và chuyến";
const timeCls = "h-8 w-[5.5rem] rounded-md border border-slate-300 bg-white px-2 text-xs tabular-nums focus-visible:outline-2 focus-visible:outline-indigo-600";

export function PayNoShiftPanel({ days, onChanged }: { days: NoShiftDay[]; onChanged: () => void }) {
  const [times, setTimes] = useState<Record<string, { in: string; out: string }>>(() =>
    Object.fromEntries(days.map((d) => [keyOf(d), { in: d.suggest_in ?? "", out: d.suggest_out ?? "" }])));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const open = days.filter((d) => !done.has(keyOf(d)));
  const ready = (d: NoShiftDay) => { const t = times[keyOf(d)]; return !d.pending && !!t?.in && !!t?.out && t.in < t.out; };
  const chosen = open.filter((d) => picked.has(keyOf(d)) && ready(d));

  async function approve(list: NoShiftDay[]) {
    setBusy(true); setError(null);
    const failed: string[] = [];
    for (const d of list) {
      const t = times[keyOf(d)];
      try {
        const res = await fetch("/api/pay/corrections", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "create", driver_id: d.driver_id, date: d.date, in_time: t.in, out_time: t.out, note: NOTE }),
        });
        const j = await res.json();
        if (!res.ok || !j.ok) throw new Error(j.error ?? "Không lưu được");
        setDone((s) => new Set(s).add(keyOf(d)));
      } catch (e) { failed.push(`${shortName(d.driver_name)} ${fmtDay(d.date)}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    setPicked(new Set()); setBusy(false);
    if (failed.length) setError(failed.join("\n"));
    onChanged();
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
        <p className="text-xs text-slate-600">
          {open.length} ngày làm không có ca. Giờ đề nghị lấy từ chấm công vào (không có thì chuyến đầu) đến chấm công
          ra hoặc chuyến cuối, lấy giờ trễ hơn — sửa nếu cần rồi bấm Duyệt.
        </p>
        <button
          type="button" disabled={busy || !chosen.length} onClick={() => void approve(chosen)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-slate-900 px-3 text-xs font-semibold text-white disabled:opacity-40"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          Duyệt {chosen.length} ngày đã chọn
        </button>
      </div>
      {error && <p role="alert" className="whitespace-pre-line border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>}
      <div className="min-h-0 flex-1 overflow-auto">
        {open.length === 0 ? (
          <p className="py-16 text-center text-sm text-slate-500">Không còn ngày nào làm không có ca.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-600">
              <tr>
                <th className="w-8 px-3 py-2">
                  <input
                    type="checkbox" aria-label="Chọn tất cả ngày có đủ giờ"
                    checked={open.filter(ready).length > 0 && open.filter(ready).every((d) => picked.has(keyOf(d)))}
                    onChange={(e) => setPicked(e.target.checked ? new Set(open.filter(ready).map(keyOf)) : new Set())}
                  />
                </th>
                <th className="px-2 py-2 text-left font-semibold">Tài xế</th>
                <th className="px-2 py-2 text-left font-semibold">Ngày</th>
                <th className="px-2 py-2 text-left font-semibold">Chấm công</th>
                <th className="px-2 py-2 text-left font-semibold">Chuyến</th>
                <th className="px-2 py-2 text-left font-semibold">Giờ duyệt</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {open.map((d) => {
                const k = keyOf(d), t = times[k];
                const set = (side: "in" | "out", v: string) => setTimes((s) => ({ ...s, [k]: { ...s[k], [side]: v } }));
                return (
                  <tr key={k} className="hover:bg-slate-50">
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox" aria-label={`Chọn ${shortName(d.driver_name)} ${fmtDay(d.date)}`} disabled={!ready(d)}
                        checked={picked.has(k)}
                        onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(k); else n.delete(k); return n; })}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-slate-800">{shortName(d.driver_name)}</td>
                    <td className="px-2 py-1.5 tabular-nums text-slate-600">{fmtDay(d.date)}</td>
                    <td className="px-2 py-1.5 tabular-nums text-slate-600">{span(d.first_in, d.last_out)}</td>
                    <td className="px-2 py-1.5 tabular-nums text-slate-600">{span(d.first_task, d.last_task)}</td>
                    <td className="px-2 py-1.5">
                      {d.pending ? (
                        <span className="text-xs text-amber-700">Tài xế đã gửi yêu cầu — xem ở Cập nhật công</span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <input type="time" aria-label="Giờ vào" className={timeCls} value={t?.in ?? ""} onChange={(e) => set("in", e.target.value)} />
                          <span className="text-slate-400">–</span>
                          <input type="time" aria-label="Giờ ra" className={timeCls} value={t?.out ?? ""} onChange={(e) => set("out", e.target.value)} />
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {!d.pending && (
                        <button
                          type="button" disabled={busy || !ready(d)} onClick={() => void approve([d])}
                          className="h-8 rounded-md border border-slate-300 px-3 text-xs font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-40"
                        >
                          Duyệt
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
