"use client";

/**
 * Lương PT → "Cập nhật công": drivers' requests to correct a day, and a
 * supervisor's own corrections. Approving one changes that day's pay: the
 * approved window replaces what the hours rule computed.
 *
 * Each request shows the day's EVIDENCE beside it — Lịch ca shift, the taps, the
 * first and last stop — because we keep no GPS trail; the stops are the record of
 * where the driver was and when. A requested window that reaches far outside the
 * day's stops is highlighted: that is the one worth a second look.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, AlertCircle, ExternalLink } from "lucide-react";
import { REASON_LABEL } from "@/lib/pay-corrections";

interface Correction {
  id: number;
  driver_id: string;
  driver_name: string;
  date: string;
  reason: "forgot_tap" | "system_error" | "supervisor";
  source: "driver" | "supervisor";
  status: "pending" | "approved" | "rejected";
  in_time: string;
  out_time: string;
  note: string;
  proof_urls: string[];
  decision_note: string;
  requested_mins: number;
  evidence: {
    shifts: { start: string; end: string }[];
    taps: { kind: "in" | "out"; at: string; place: string | null }[];
    trips: number;
    first_stop: string | null;
    last_stop: string | null;
    rule_mins: number;
    outside_mins: number | null;
  };
}

const fmtH = (m: number) => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
const fmtD = (d: string) => d.split("-").reverse().slice(0, 2).join("/");
/** Past this many minutes outside the day's stops, a request is flagged. */
const OUTSIDE_FLAG = 30;

export function PayCorrectionsPanel({
  month, drivers, onChanged,
}: {
  month: string;
  drivers: { driver_id: string; driver_name: string }[];
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<Correction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | "new" | null>(null);
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [draft, setDraft] = useState({ driver_id: "", date: "", in_time: "", out_time: "", note: "" });

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/pay/corrections?month=${month}`);
      const j = await res.json();
      if (!res.ok || !j.ok) { setError(j.error ?? "Không tải được."); return; }
      setRows(j.corrections);
    } catch { setError("Không kết nối được máy chủ."); }
  }, [month]);
  useEffect(() => { load(); }, [load]);

  async function post(body: object, id: number | "new") {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch("/api/pay/corrections", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setError(j.error ?? "Không lưu được."); return false; }
      await load();
      onChanged();
      return true;
    } catch { setError("Không kết nối được máy chủ."); return false; }
    finally { setBusyId(null); }
  }

  const pending = rows?.filter((r) => r.status === "pending") ?? [];
  const done = rows?.filter((r) => r.status !== "pending") ?? [];
  const field = "border border-slate-300 rounded-lg px-2 text-xs min-h-11 bg-white";

  const card = (r: Correction) => {
    const e = r.evidence;
    const flagged = e.outside_mins != null && e.outside_mins > OUTSIDE_FLAG;
    return (
      <li key={r.id} className="px-3 py-3 space-y-2">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <p className="text-sm font-semibold text-slate-800">
            {r.driver_name} <span className="font-normal text-slate-600">· {fmtD(r.date)}</span>
          </p>
          <p className="text-xs text-slate-600">{REASON_LABEL[r.reason]}{r.source === "supervisor" ? "" : " · tài xế gửi"}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          <div className="rounded-lg bg-blue-50 border border-blue-200 px-2.5 py-2">
            <p className="text-slate-600">Đề nghị</p>
            <p className="font-semibold text-slate-900 tabular-nums">{r.in_time}–{r.out_time} · {fmtH(r.requested_mins)}</p>
            {r.note && <p className="text-slate-700 mt-0.5 break-words">“{r.note}”</p>}
          </div>
          <div className={`rounded-lg border px-2.5 py-2 ${flagged ? "bg-amber-50 border-amber-300" : "bg-slate-50 border-slate-200"}`}>
            <p className="text-slate-600">Dữ liệu ngày đó · hệ thống đang tính {fmtH(e.rule_mins)}</p>
            <p className="text-slate-800 tabular-nums">
              Ca: {e.shifts.length ? e.shifts.map((s) => `${s.start}–${s.end}`).join(", ") : "không có ca"}
            </p>
            <p className="text-slate-800 tabular-nums">
              Chuyến: {e.trips > 0 ? `${e.trips} chuyến, ${e.first_stop ?? "?"} → ${e.last_stop ?? "?"}` : "không có chuyến"}
            </p>
            <p className="text-slate-800 tabular-nums">
              Chấm công: {e.taps.length ? e.taps.map((t) => `${t.kind === "in" ? "vào" : "ra"} ${t.at}`).join(", ") : "không có"}
            </p>
            {flagged && (
              <p className="text-amber-900 font-semibold mt-0.5">
                Giờ đề nghị lệch {e.outside_mins} phút ngoài các điểm dừng của ngày đó.
              </p>
            )}
          </div>
        </div>

        {r.proof_urls.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            {r.proof_urls.map((u, i) => (
              <a key={u} href={u} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 border border-blue-200 rounded-lg px-2.5 min-h-11">
                <ExternalLink className="size-3.5" /> Ảnh {i + 1}
              </a>
            ))}
          </div>
        )}

        {r.status === "pending" ? (
          rejecting === r.id ? (
            <div className="flex gap-2 flex-wrap">
              <input autoFocus className={`${field} flex-1 min-w-[180px]`} placeholder="Lý do từ chối (tài xế sẽ thấy)"
                value={reason} onChange={(ev) => setReason(ev.target.value)} />
              <button className="text-xs font-semibold text-slate-700 border border-slate-300 rounded-lg px-3 min-h-11" onClick={() => setRejecting(null)}>Huỷ</button>
              <button disabled={busyId === r.id || !reason.trim()}
                className="text-xs font-semibold text-white bg-red-600 rounded-lg px-3 min-h-11 disabled:opacity-50"
                onClick={async () => { if (await post({ action: "reject", id: r.id, note: reason }, r.id)) { setRejecting(null); setReason(""); } }}>
                Từ chối
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button className="text-xs font-semibold text-red-700 border border-red-200 rounded-lg px-3 min-h-11"
                onClick={() => { setRejecting(r.id); setReason(""); }}>Từ chối</button>
              <button disabled={busyId === r.id}
                className="text-xs font-semibold text-white bg-green-700 rounded-lg px-3 min-h-11 inline-flex items-center gap-1.5 disabled:opacity-50"
                onClick={() => post({ action: "approve", id: r.id }, r.id)}>
                {busyId === r.id && <Loader2 className="size-3.5 animate-spin" />} Duyệt {r.in_time}–{r.out_time}
              </button>
            </div>
          )
        ) : (
          <p className={`text-xs font-semibold ${r.status === "approved" ? "text-green-800" : "text-red-800"}`}>
            {r.status === "approved" ? "Đã duyệt" : "Đã từ chối"}{r.decision_note ? ` — ${r.decision_note}` : ""}
          </p>
        )}
      </li>
    );
  };

  return (
    <div className="border-b border-slate-200 bg-slate-50/60">
      {error && (
        <div className="flex items-start gap-2 text-xs text-red-800 bg-red-50 border-b border-red-200 px-3 py-2">
          <AlertCircle className="size-3.5 mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {/* A supervisor's own correction — approved as soon as it is saved. */}
      <div className="px-3 py-2.5 flex gap-2 flex-wrap items-end border-b border-slate-200">
        <select className={`${field} min-w-[180px] flex-1`} value={draft.driver_id} aria-label="Tài xế"
          onChange={(e) => setDraft({ ...draft, driver_id: e.target.value })}>
          <option value="">— Tài xế —</option>
          {drivers.map((d) => <option key={d.driver_id} value={d.driver_id}>{d.driver_name}</option>)}
        </select>
        <input type="date" aria-label="Ngày" className={field} value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
        <input type="time" aria-label="Giờ vào" className={field} value={draft.in_time} onChange={(e) => setDraft({ ...draft, in_time: e.target.value })} />
        <input type="time" aria-label="Giờ ra" className={field} value={draft.out_time} onChange={(e) => setDraft({ ...draft, out_time: e.target.value })} />
        <input aria-label="Lý do" placeholder="Lý do điều chỉnh" className={`${field} flex-1 min-w-[160px]`} value={draft.note}
          onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
        <button disabled={busyId === "new"}
          className="text-xs font-semibold text-white bg-slate-800 rounded-lg px-3 min-h-11 disabled:opacity-50"
          onClick={async () => { if (await post({ action: "create", ...draft }, "new")) setDraft({ driver_id: "", date: "", in_time: "", out_time: "", note: "" }); }}>
          Lưu điều chỉnh
        </button>
      </div>

      {rows === null ? (
        <div className="flex justify-center py-6 text-slate-400"><Loader2 className="size-5 animate-spin" /></div>
      ) : (
        <>
          <p className="px-3 pt-2.5 text-xs font-semibold text-slate-700">
            {pending.length ? `${pending.length} yêu cầu chờ duyệt` : "Không có yêu cầu nào chờ duyệt."}
          </p>
          {pending.length > 0 && <ul className="divide-y divide-slate-200">{pending.map(card)}</ul>}
          {done.length > 0 && (
            <>
              <button className="px-3 py-2 text-xs font-semibold text-slate-600 underline underline-offset-2 min-h-11"
                onClick={() => setShowDone((v) => !v)}>
                {showDone ? "Ẩn" : "Xem"} {done.length} yêu cầu đã xử lý
              </button>
              {showDone && <ul className="divide-y divide-slate-200">{done.map(card)}</ul>}
            </>
          )}
        </>
      )}
    </div>
  );
}
