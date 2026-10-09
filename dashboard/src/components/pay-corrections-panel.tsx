"use client";

/**
 * Lương PT → "Cập nhật công": drivers' requests to correct a day, and a
 * supervisor's own corrections. Approving one changes that day's pay: the
 * approved window replaces what the hours rule computed.
 *
 * THE DECISION IS VISUAL. The question a reviewer answers is "do the hours asked
 * for fit what the day shows?" — so each request is drawn as ONE timeline: the
 * Lịch ca shift, the trips (first → last stop), the check-in/out taps, the window
 * the system pays today, and the window asked for, on a shared hour axis. Four
 * lines of times made the reviewer do that arithmetic in their head; the bars do
 * it for them. There is no GPS trail anywhere — the stops ARE the record of where
 * the driver was and when — so a request reaching well outside them is flagged.
 *
 * The panel takes the table's place while open (see pay-team-panel), so it never
 * pushes the payroll off screen.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, AlertCircle, AlertTriangle, Check, X, Plus, ImageOff } from "lucide-react";
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
    rule_spans?: { from: string | null; to: string | null }[];
    outside_mins: number | null;
  };
}

const toMin = (t: string | null | undefined) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
const fmtH = (m: number) => `${Math.floor(Math.abs(m) / 60)}h${String(Math.abs(m) % 60).padStart(2, "0")}`;
const fmtD = (d: string) => d.split("-").reverse().slice(0, 2).join("/");
const WEEKDAY = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const weekday = (d: string) => WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()];
/** Past this many minutes outside the day's stops, a request is flagged. */
const OUTSIDE_FLAG = 30;
const shortName = (full: string) => full.replace(/^[A-Z]{1,3}\s*-\s*[A-Z]{1,3}\s*-\s*/, "");

/* ── Timeline ──────────────────────────────────────────────────────────────── */

type Lane = { label: string; value: string; render: (x: (m: number) => number) => React.ReactNode };

function DayTimeline({ r }: { r: Correction }) {
  const e = r.evidence;
  const reqIn = toMin(r.in_time)!, reqOut = toMin(r.out_time)!;
  const first = toMin(e.first_stop), last = toMin(e.last_stop);
  const shifts = e.shifts.map((s) => [toMin(s.start)!, toMin(s.end)!] as const);
  const taps = e.taps.map((t) => ({ ...t, m: toMin(t.at)! }));
  const rule = (e.rule_spans ?? []).map((s) => [toMin(s.from), toMin(s.to)] as const).filter((s): s is [number, number] => s[0] != null && s[1] != null);

  // Axis: every time on the row, padded to whole hours.
  const all = [reqIn, reqOut, ...shifts.flat(), ...taps.map((t) => t.m), ...rule.flat(), first, last].filter((v): v is number => v != null);
  const lo = Math.max(0, Math.floor((Math.min(...all) - 20) / 60) * 60);
  const hi = Math.min(24 * 60, Math.ceil((Math.max(...all) + 20) / 60) * 60);
  const x = (m: number) => ((m - lo) / (hi - lo)) * 100;
  const step = hi - lo > 10 * 60 ? 120 : 60;
  const ticks: number[] = [];
  for (let t = lo; t <= hi; t += step) ticks.push(t);

  const bar = (a: number, b: number, cls: string, title: string, key?: string | number) => (
    <span key={key} title={title} className={`absolute top-1/2 -translate-y-1/2 rounded-sm ${cls}`}
      style={{ left: `${x(a)}%`, width: `${Math.max(0.6, x(b) - x(a))}%` }} />
  );

  const lanes: Lane[] = [
    { label: "Ca", value: e.shifts.map((s) => `${s.start}–${s.end}`).join(", ") || "—", render: () => shifts.length
        ? shifts.map(([a, b], i) => bar(a, b, "h-3 bg-slate-300 border border-slate-400", `Ca ${e.shifts[i].start}–${e.shifts[i].end}`, i))
        : <span className="absolute inset-y-0 left-0 flex items-center text-[11px] text-slate-500">không có ca</span> },
    { label: "Chuyến", value: first != null ? `${e.first_stop}–${e.last_stop}` : "—", render: () => first != null && last != null
        ? bar(first, Math.max(last, first + 1), "h-2 bg-slate-600", `${e.trips} chuyến, ${e.first_stop} → ${e.last_stop}`)
        : <span className="absolute inset-y-0 left-0 flex items-center text-[11px] text-slate-500">không có chuyến</span> },
    { label: "Chấm công", value: e.taps.map((t) => `${t.kind === "in" ? "V" : "R"} ${t.at}`).join(" · ") || "—", render: () => taps.length
        ? taps.map((t, i) => (
            <span key={i} title={`${t.kind === "in" ? "Vào" : "Ra"} ${t.at}${t.place ? ` · ${t.place}` : ""}`}
              className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 h-4 w-1 rounded-full ${t.kind === "in" ? "bg-emerald-600" : "bg-rose-600"}`}
              style={{ left: `${x(t.m)}%` }} />
          ))
        : <span className="absolute inset-y-0 left-0 flex items-center text-[11px] text-slate-500">không chấm công</span> },
    { label: "Đang tính", value: rule.length ? `${fmtH(e.rule_mins)}` : "0h00", render: () => rule.length
        ? rule.map(([a, b], i) => bar(a, b, "h-2.5 border-2 border-dashed border-slate-500 bg-transparent", `Hệ thống đang tính ${fmtH(b - a)}`, i))
        : <span className="absolute inset-y-0 left-0 flex items-center text-[11px] text-slate-500">0 giờ</span> },
    { label: "Đề nghị", value: `${r.in_time}–${r.out_time}`, render: () => bar(reqIn, reqOut, "h-3.5 bg-blue-600", `Đề nghị ${r.in_time}–${r.out_time}`) },
  ];

  return (
    <figure className="min-w-0" aria-label={`Ngày ${fmtD(r.date)}: ca ${e.shifts.map((s) => `${s.start}–${s.end}`).join(", ") || "không có"}; chuyến ${e.first_stop ?? "—"} đến ${e.last_stop ?? "—"}; chấm công ${e.taps.map((t) => `${t.kind === "in" ? "vào" : "ra"} ${t.at}`).join(", ") || "không có"}; đề nghị ${r.in_time}–${r.out_time}`}>
      <div className="grid grid-cols-[72px_1fr_minmax(96px,auto)] gap-x-3">
        {lanes.map((l) => (
          <div key={l.label} className="contents">
            <span className={`text-[11px] leading-6 ${l.label === "Đề nghị" ? "font-semibold text-blue-700" : "text-slate-600"}`}>{l.label}</span>
            <div className="relative h-6">
              {/* hour gridlines */}
              {ticks.map((t) => <span key={t} className="absolute inset-y-0 w-px bg-slate-100" style={{ left: `${x(t)}%` }} />)}
              {l.render(x)}
            </div>
            <span className={`text-[11px] leading-6 tabular-nums whitespace-nowrap ${l.label === "Đề nghị" ? "font-semibold text-blue-700" : "text-slate-700"}`}>{l.value}</span>
          </div>
        ))}
        <span />
        <div className="relative h-4 tabular-nums mx-2">
          {ticks.map((t) => (
            <span key={t} className="absolute -translate-x-1/2 text-[11px] text-slate-500" style={{ left: `${x(t)}%` }}>
              {String(t / 60).padStart(2, "0")}h
            </span>
          ))}
        </div>
        <span />
      </div>
    </figure>
  );
}

/* ── One request ───────────────────────────────────────────────────────────── */

function Proof({ url, n }: { url: string; n: number }) {
  const [broken, setBroken] = useState(false);
  return (
    <a href={url} target="_blank" rel="noreferrer" title={`Mở ảnh ${n} (tab mới)`}
      className="block size-16 shrink-0 rounded-lg border border-slate-300 overflow-hidden bg-slate-50 hover:border-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">
      {broken
        ? <span className="size-full grid place-items-center text-slate-500 text-[11px] text-center leading-tight"><ImageOff className="size-4 mb-0.5" />Ảnh {n}</span>
        // eslint-disable-next-line @next/next/no-img-element
        : <img src={url} alt={`Ảnh minh chứng ${n}`} loading="lazy" className="size-full object-cover" onError={() => setBroken(true)} />}
    </a>
  );
}

function RequestRow({ r, busy, onDecide }: {
  r: Correction; busy: boolean;
  onDecide: (action: "approve" | "reject", note?: string) => Promise<boolean>;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [why, setWhy] = useState("");
  const e = r.evidence;
  const delta = r.requested_mins - e.rule_mins;
  const first = toMin(e.first_stop), last = toMin(e.last_stop);
  const early = first != null ? first - toMin(r.in_time)! : 0;
  const late = last != null ? toMin(r.out_time)! - last : 0;
  const flags = [
    early > OUTSIDE_FLAG && `Vào trước chuyến đầu ${early} phút`,
    late > OUTSIDE_FLAG && `Ra sau chuyến cuối ${late} phút`,
    e.trips === 0 && e.taps.length === 0 && "Ngày này không có chuyến và không chấm công",
  ].filter(Boolean) as string[];

  return (
    <li className="px-4 py-4 grid gap-x-6 gap-y-3 lg:grid-cols-[minmax(200px,240px)_1fr_auto] items-start">
      {/* Who, when, why */}
      <div className="min-w-0 space-y-1.5">
        <p className="text-sm font-semibold text-slate-900 leading-snug break-words">{shortName(r.driver_name)}</p>
        <p className="text-xs text-slate-600 tabular-nums">{weekday(r.date)}, {fmtD(r.date)}</p>
        <p className="inline-flex text-[11px] font-semibold rounded px-1.5 py-0.5 bg-slate-100 text-slate-700">
          {REASON_LABEL[r.reason]}
        </p>
        {r.note && <p className="text-xs text-slate-700 break-words">“{r.note}”</p>}
      </div>

      {/* The day, drawn */}
      <div className="min-w-0 space-y-2">
        <DayTimeline r={r} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
          <span className="text-slate-700">Đề nghị <b className="text-blue-700">{r.in_time}–{r.out_time} · {fmtH(r.requested_mins)}</b></span>
          <span className="text-slate-700">Đang tính <b className="text-slate-900">{fmtH(e.rule_mins)}</b></span>
          {delta !== 0 && (
            <span className={`font-semibold ${delta > 0 ? "text-amber-800" : "text-slate-700"}`}>
              {delta > 0 ? "+" : "−"}{fmtH(delta)} nếu duyệt
            </span>
          )}
        </div>
        {flags.length > 0 && (
          <p className="flex items-start gap-1.5 text-xs font-medium text-amber-900">
            <AlertTriangle className="size-3.5 mt-px shrink-0" /> {flags.join(" · ")}
          </p>
        )}
      </div>

      {/* Proof + decision */}
      <div className="flex lg:flex-col items-start lg:items-end gap-3">
        {r.proof_urls.length > 0 && (
          <div className="flex gap-2">{r.proof_urls.map((u, i) => <Proof key={u} url={u} n={i + 1} />)}</div>
        )}
        {r.status !== "pending" ? (
          <p className={`text-xs font-semibold ${r.status === "approved" ? "text-emerald-800" : "text-rose-800"}`}>
            {r.status === "approved" ? "Đã duyệt" : "Đã từ chối"}{r.decision_note ? ` — ${r.decision_note}` : ""}
          </p>
        ) : rejecting ? (
          <form className="flex flex-col gap-2 w-full lg:w-64"
            onSubmit={async (ev) => { ev.preventDefault(); if (await onDecide("reject", why)) setRejecting(false); }}>
            <label className="text-xs text-slate-700">
              Lý do từ chối <span className="text-slate-500">(tài xế sẽ thấy)</span>
              <input autoFocus required value={why} onChange={(ev) => setWhy(ev.target.value)}
                className="mt-1 w-full border border-slate-300 rounded-lg px-2.5 min-h-11 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-rose-300" />
            </label>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setRejecting(false)} className="text-xs font-semibold text-slate-700 rounded-lg px-3 min-h-11 hover:bg-slate-100">Huỷ</button>
              <button type="submit" disabled={busy || !why.trim()} className="text-xs font-semibold text-white bg-rose-700 hover:bg-rose-800 rounded-lg px-4 min-h-11 disabled:opacity-50">Từ chối</button>
            </div>
          </form>
        ) : (
          <div className="flex gap-2">
            <button onClick={() => { setRejecting(true); setWhy(""); }}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-800 border border-rose-200 hover:bg-rose-50 rounded-lg px-3 min-h-11">
              <X className="size-3.5" /> Từ chối
            </button>
            <button onClick={() => onDecide("approve")} disabled={busy}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg px-4 min-h-11 disabled:opacity-50">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Duyệt
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

/* ── Panel ─────────────────────────────────────────────────────────────────── */

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
  const [view, setView] = useState<"pending" | "done">("pending");
  const [adding, setAdding] = useState(false);
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

  const pending = useMemo(() => rows?.filter((r) => r.status === "pending") ?? [], [rows]);
  const done = useMemo(() => rows?.filter((r) => r.status !== "pending") ?? [], [rows]);
  const shown = view === "pending" ? pending : done;
  const field = "border border-slate-300 rounded-lg px-2.5 min-h-11 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-slate-300";
  const tab = (v: typeof view, label: string, n: number) => (
    <button role="tab" aria-selected={view === v} onClick={() => setView(v)}
      className={`min-h-11 px-3 text-xs font-semibold rounded-lg ${view === v ? "bg-slate-800 text-white" : "text-slate-700 hover:bg-slate-100"}`}>
      {label} <span className="tabular-nums">{n}</span>
    </button>
  );

  return (
    <section aria-label="Cập nhật công" className="h-full flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-slate-200 shrink-0">
        <div role="tablist" className="flex gap-1">
          {tab("pending", "Chờ duyệt", pending.length)}
          {tab("done", "Đã xử lý", done.length)}
        </div>
        {/* What each lane's mark means — once, beside the tabs, not under the list. */}
        <p className="hidden xl:flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-600 mr-auto ml-4">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm bg-slate-300 border border-slate-400" />Ca</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-slate-600" />Chuyến đầu → cuối</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-3 w-1 rounded-full bg-emerald-600" />Vào</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-3 w-1 rounded-full bg-rose-600" />Ra</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm border-2 border-dashed border-slate-500" />Đang tính</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-3 w-4 rounded-sm bg-blue-600" />Đề nghị</span>
        </p>
        <button onClick={() => setAdding((v) => !v)} aria-expanded={adding}
          className="inline-flex items-center gap-1.5 min-h-11 px-3 text-xs font-semibold text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50">
          <Plus className="size-3.5" /> Điều chỉnh trực tiếp
        </button>
      </div>

      {/* A supervisor's own correction — approved as soon as it is saved. */}
      {adding && (
        <form className="px-4 py-3 border-b border-slate-200 bg-slate-50 grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(220px,1.4fr)_auto_auto_auto_minmax(200px,1fr)_auto] items-end shrink-0"
          onSubmit={async (ev) => {
            ev.preventDefault();
            if (await post({ action: "create", ...draft }, "new")) { setDraft({ driver_id: "", date: "", in_time: "", out_time: "", note: "" }); setAdding(false); }
          }}>
          <label className="text-xs text-slate-700">Tài xế
            <select required className={`${field} mt-1 w-full`} value={draft.driver_id} onChange={(e) => setDraft({ ...draft, driver_id: e.target.value })}>
              <option value="">Chọn tài xế</option>
              {drivers.map((d) => <option key={d.driver_id} value={d.driver_id}>{shortName(d.driver_name)}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-700">Ngày
            <input required type="date" className={`${field} mt-1 w-full`} value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
          </label>
          <label className="text-xs text-slate-700">Giờ vào
            <input required type="time" className={`${field} mt-1 w-full`} value={draft.in_time} onChange={(e) => setDraft({ ...draft, in_time: e.target.value })} />
          </label>
          <label className="text-xs text-slate-700">Giờ ra
            <input required type="time" className={`${field} mt-1 w-full`} value={draft.out_time} onChange={(e) => setDraft({ ...draft, out_time: e.target.value })} />
          </label>
          <label className="text-xs text-slate-700">Lý do
            <input required className={`${field} mt-1 w-full`} placeholder="Ví dụ: tài xế báo quên chấm công vào" value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={() => setAdding(false)} className="text-xs font-semibold text-slate-700 rounded-lg px-3 min-h-11 hover:bg-slate-200">Huỷ</button>
            <button type="submit" disabled={busyId === "new"} className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-900 rounded-lg px-4 min-h-11 disabled:opacity-50">
              {busyId === "new" && <Loader2 className="size-3.5 animate-spin" />} Lưu
            </button>
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-2 text-xs text-red-800 bg-red-50 border-b border-red-200 px-4 py-2 shrink-0">
          <AlertCircle className="size-3.5 mt-0.5 shrink-0" /> {error}
        </p>
      )}

      <div className="flex-1 overflow-auto">
        {rows === null ? (
          <ul aria-busy="true" className="divide-y divide-slate-100">
            {[0, 1].map((i) => (
              <li key={i} className="px-4 py-4 grid gap-6 lg:grid-cols-[240px_1fr_160px]">
                <div className="space-y-2"><div className="h-4 w-40 rounded bg-slate-100" /><div className="h-3 w-20 rounded bg-slate-100" /></div>
                <div className="h-28 rounded bg-slate-100" />
                <div className="h-11 rounded bg-slate-100" />
              </li>
            ))}
          </ul>
        ) : shown.length === 0 ? (
          <div className="px-4 py-12 text-center space-y-1">
            <p className="text-sm font-semibold text-slate-800">
              {view === "pending" ? "Không có yêu cầu nào chờ duyệt." : "Chưa xử lý yêu cầu nào trong kỳ này."}
            </p>
            <p className="text-xs text-slate-600">
              Tài xế gửi yêu cầu từ tab Thu Nhập. Bạn cũng có thể sửa công một ngày bằng “Điều chỉnh trực tiếp”.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-200">
            {shown.map((r) => (
              <RequestRow key={r.id} r={r} busy={busyId === r.id}
                onDecide={(action, note) => post({ action, id: r.id, note }, r.id)} />
            ))}
          </ul>
        )}
      </div>

    </section>
  );
}
