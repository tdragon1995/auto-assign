"use client";
/**
 * Bảng ca — one pay period, every driver, every day: the planned shift on top,
 * what actually happened below, a coloured mark for the verdict. Read without
 * clicking (MISA's Bảng chấm công is the model).
 *
 * Fixes are BULK, not per cell: a status chip filters the grid, and with "Không
 * ca" on, one button approves every listed PT day from its actual check-in/out
 * (a supervisor "cập nhật công"). A PT driver's weekly shift is set from their own
 * row — saved once, its days are written and run until a newer weekly shift.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Pencil, RefreshCw, Search, Check, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { PatternTimeSelect } from "./pattern-time-select";
import { STATUS_LABEL, periodMonthOf, type CellStatus } from "@/lib/shift-grid";
import { vnDate } from "@/lib/time";
import { foldName } from "@/lib/driver-cell";

type Cell = { p?: string; a?: string; s: CellStatus; t?: string[]; sug?: [string, string] };
type Row = { driver_id: string; name: string; code: string; type: "PT" | "FT"; active: boolean;
  week: { from: string | null; days: ({ start: string; end: string } | null)[] } | null; cells: Record<string, Cell> };
type Grid = { month: string; from: string; to: string; today: string; days: string[]; rows: Row[] };
type Status = Exclude<CellStatus, "">;
type Day = { start: string; end: string } | null;

const WD = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const shiftMonth = (m: string, n: number) => { const d = new Date(`${m}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const ORDER: Status[] = ["noshift", "absent", "short", "ok", "approved", "leave", "off"];
/** One mark per verdict — colour AND label (legend), never colour alone. */
const MARK: Record<Status, string> = {
  ok: "bg-emerald-600", short: "bg-amber-500", noshift: "bg-orange-600", absent: "bg-red-600",
  approved: "bg-indigo-600", leave: "bg-slate-400", off: "bg-slate-300",
};
const field = "h-9 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60";
/** "T2–T7 15:00–21:00 · CN 07:00–15:00": days grouped by identical hours. */
const weekText = (w: Row["week"]) => {
  if (!w) return null;
  const groups = new Map<string, number[]>();
  for (const d of [1, 2, 3, 4, 5, 6, 0]) { const x = w.days[d]; if (x) { const k = `${x.start}–${x.end}`; groups.set(k, [...(groups.get(k) ?? []), d]); } }
  const span = (ds: number[]) => ds.length > 2 && ds.every((d, i) => i === 0 || d === ds[i - 1] + 1) ? `${WD[ds[0]]}–${WD[ds.at(-1)!]}` : ds.map((d) => WD[d]).join(", ");
  return [...groups].map(([h, ds]) => `${span(ds)} ${h}`).join(" · ") || null;
};
/** A first weekly shift guessed from what the driver actually worked this period:
 *  the weekdays they worked at least twice, the usual start rounded DOWN and the
 *  usual end rounded UP to the half hour. Only a starting point — it is confirmed. */
function guessWeek(r: Row): { days: number[]; start: string; end: string } | null {
  const worked = Object.entries(r.cells).filter(([, c]) => c.a && /^\d\d:\d\d–\d\d:\d\d$/.test(c.a));
  if (worked.length < 2) return null;
  const mode = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0][0];
  const half = (t: string, up: boolean) => { let m = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); m = (up ? Math.ceil(m / 30) : Math.floor(m / 30)) * 30; m = Math.min(m, 23 * 60 + 30); return `${String(Math.floor(m / 60)).padStart(2, "0")}:${m % 60 ? "30" : "00"}`; };
  const perDay = new Map<number, number>();
  for (const [d] of worked) perDay.set(dow(d), (perDay.get(dow(d)) ?? 0) + 1);
  return {
    days: [...perDay].filter(([, n]) => n >= 2).map(([d]) => d),
    start: half(mode(worked.map(([, c]) => c.a!.slice(0, 5))), false),
    end: half(mode(worked.map(([, c]) => c.a!.slice(6, 11))), true),
  };
}

export function ShiftGrid() {
  const [month, setMonth] = useState(() => periodMonthOf(vnDate()));
  const [grid, setGrid] = useState<Grid | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [type, setType] = useState<"all" | "PT" | "FT">("all");
  const [only, setOnly] = useState<Status | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const res = await fetch(`/api/shift-grid?month=${month}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không tải được bảng ca");
      setGrid(data);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [month]);
  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(ORDER.map((s) => [s, 0])) as Record<Status, number>;
    for (const r of grid?.rows ?? []) for (const cell of Object.values(r.cells)) if (cell.s) c[cell.s as Status]++;
    return c;
  }, [grid]);
  const rows = useMemo(() => (grid?.rows ?? []).filter((r) =>
    (type === "all" || r.type === type)
    && (!q || foldName(`${r.name} ${r.code}`).includes(foldName(q.trim())))
    && (!only || Object.values(r.cells).some((c) => c.s === only))), [grid, type, q, only]);
  /** PT days without a shift that the day itself can settle: check-in and check-out both known. */
  const fixable = useMemo(() => rows.filter((r) => r.type === "PT").flatMap((r) =>
    Object.entries(r.cells).filter(([, c]) => c.s === "noshift" && c.sug).map(([date, c]) => ({ r, date, sug: c.sug! }))), [rows]);

  async function approveAll() {
    if (!fixable.length || !confirm(`Duyệt ${fixable.length} ngày làm không có ca, theo giờ chấm công / chuyến của từng ngày?`)) return;
    setBusy(true);
    let ok = 0; const failed: string[] = [];
    for (const f of fixable) {
      try {
        const res = await fetch("/api/pay/corrections", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "create", driver_id: f.r.driver_id, date: f.date, in_time: f.sug[0], out_time: f.sug[1],
            note: "Bảng ca: ngày làm không có ca — duyệt theo chấm công và chuyến" }) });
        const j = await res.json();
        if (!res.ok || !j.ok) throw new Error(j.error || "lỗi"); ok++;
      } catch (e) { failed.push(`${f.r.name} ${dm(f.date)}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    setBusy(false);
    if (failed.length) toast.error(`Đã duyệt ${ok}/${fixable.length}. Lỗi:\n${failed.slice(0, 5).join("\n")}`); else toast.success(`Đã duyệt ${ok} ngày`);
    await load();
  }

  return (
    <section className="flex h-full min-h-0 flex-col rounded-xl border border-slate-200 bg-white text-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Kỳ trước" disabled={loading} onClick={() => setMonth((m) => shiftMonth(m, -1))}><ChevronLeft /></Button>
          <div className="min-w-[11rem] text-center">
            <h2 className="font-semibold">Bảng ca tháng {Number(month.slice(5))}/{month.slice(0, 4)}</h2>
            {grid && <p className="text-xs text-slate-600 tabular-nums">{dm(grid.from)}/{grid.from.slice(0, 4)} – {dm(grid.to)}/{grid.to.slice(0, 4)}</p>}
          </div>
          <Button variant="outline" size="icon" aria-label="Kỳ sau" disabled={loading} onClick={() => setMonth((m) => shiftMonth(m, 1))}><ChevronRight /></Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative"><span className="sr-only">Tìm tài xế</span><Search className="absolute left-2.5 top-2.5 size-4 text-slate-500" />
            <input type="search" className={`${field} w-56 pl-8`} placeholder="Tìm tài xế hoặc mã…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <div className="flex rounded-md border border-slate-300 p-0.5" role="group" aria-label="Loại tài xế">
            {(["all", "PT", "FT"] as const).map((t) => (
              <button key={t} type="button" aria-pressed={type === t} onClick={() => setType(t)}
                className={`h-8 rounded px-3 text-sm ${type === t ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"}`}>{t === "all" ? "Tất cả" : t}</button>
            ))}
          </div>
          <Button variant="outline" disabled={loading} onClick={() => void load()}><RefreshCw className="size-4" />Tải lại</Button>
        </div>
      </div>

      {/* The verdicts, counted — each one is also the filter. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2">
        {ORDER.map((s) => (
          <button key={s} type="button" aria-pressed={only === s} disabled={loading || !counts[s]} onClick={() => setOnly((v) => (v === s ? null : s))}
            className={`inline-flex h-8 items-center gap-2 rounded-full border px-3 text-sm tabular-nums disabled:opacity-40 ${only === s ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50"}`}>
            <span aria-hidden className={`size-2 rounded-full ${MARK[s]}`} />{STATUS_LABEL[s]}<span className={only === s ? "text-slate-300" : "text-slate-500"}>{counts[s]}</span>
          </button>
        ))}
        {only === "noshift" && fixable.length > 0 && (
          <Button className="ml-auto" disabled={busy} onClick={() => void approveAll()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}Duyệt {fixable.length} ngày theo chấm công
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto" aria-busy={loading}>
        {error ? <p role="alert" className="p-4 text-sm text-red-700">{error} · Bấm Tải lại để thử lại.</p>
        : loading && !grid ? <div role="status" className="space-y-2 p-4"><p className="text-sm text-slate-600">Đang tải bảng ca…</p>{[1, 2, 3, 4].map((n) => <div key={n} className="h-12 rounded bg-slate-100 motion-safe:animate-pulse" />)}</div>
        : !rows.length ? <p className="p-6 text-sm text-slate-600">{q || only || type !== "all" ? "Không có tài xế nào khớp bộ lọc." : "Kỳ này chưa có dữ liệu ca hoặc chấm công."}</p>
        : (
          <table className="border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 z-20">
              <tr>
                <th scope="col" className="sticky left-0 z-30 min-w-[15rem] border-b border-r border-slate-200 bg-slate-50 p-2 text-left text-xs font-medium text-slate-600">Tài xế · ca tuần</th>
                {grid!.days.map((d) => (
                  <th key={d} scope="col" className={`min-w-[6.75rem] border-b border-slate-200 bg-slate-50 p-1.5 text-center font-medium ${d === grid!.today ? "text-indigo-700" : dow(d) === 0 ? "text-red-600" : "text-slate-600"}`}>
                    <span className="block">{WD[dow(d)]}</span><span className="block text-sm font-semibold tabular-nums">{dm(d)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <RowView key={r.driver_id} r={r} days={grid!.days} only={only} editing={editing === r.driver_id}
                  onEdit={() => setEditing((v) => (v === r.driver_id ? null : r.driver_id))} onSaved={() => { setEditing(null); void load(); }} />
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="border-t border-slate-200 px-3 py-2 text-xs text-slate-600">
        Mỗi ô: dòng trên là ca, dòng dưới là giờ chấm công / chuyến thực tế. CN = theo Lịch Chủ nhật · Thay = thay ca người nghỉ. Ca Chủ nhật sửa ở Master Setup → Lịch Chủ nhật.
      </p>
    </section>
  );
}

function RowView({ r, days, only, editing, onEdit, onSaved }: { r: Row; days: string[]; only: Status | null; editing: boolean; onEdit: () => void; onSaved: () => void }) {
  const wk = weekText(r.week);
  return (
    <>
      <tr className="group">
        <th scope="row" className="sticky left-0 z-10 border-b border-r border-slate-200 bg-white p-2 text-left align-top font-normal group-hover:bg-slate-50">
          <div className="flex items-start gap-1.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-900">{r.name}
                <span className={`ml-1.5 rounded px-1 text-[10px] font-semibold ${r.type === "PT" ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-700"}`}>{r.type}</span></p>
              <p className="text-[11px] text-slate-500 tabular-nums">{r.code}</p>
              {r.type === "PT" && <p className={`text-[11px] tabular-nums ${wk ? "text-slate-700" : "text-orange-700"}`}>{wk ?? "Chưa có ca tuần"}</p>}
            </div>
            {r.type === "PT" && <Button variant="ghost" size="icon" className="size-7 text-blue-600" aria-label={`Sửa ca tuần ${r.name}`} aria-expanded={editing} onClick={onEdit}><Pencil className="size-3.5" /></Button>}
          </div>
        </th>
        {days.map((d) => {
          const c = r.cells[d];
          const dim = only && c?.s !== only;
          return (
            <td key={d} className={`border-b border-slate-100 p-1.5 align-top ${dow(d) === 0 ? "bg-slate-50/60" : ""} ${dim ? "opacity-30" : ""}`}
              title={c?.s ? STATUS_LABEL[c.s as Status] : undefined}>
              {c && <>
                <p className="flex items-center gap-1 font-medium text-slate-800 tabular-nums">
                  {c.s && <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${MARK[c.s as Status]}`} />}
                  <span className={c.p ? "" : c.s === "noshift" ? "text-orange-700" : "text-slate-400"}>{c.p ?? (c.s === "leave" ? "Nghỉ phép" : c.s === "off" ? "Nghỉ" : c.s === "noshift" ? "Không ca" : "—")}</span>
                </p>
                {c.a && <p className={`tabular-nums ${c.s === "short" || c.s === "noshift" ? "text-orange-700" : "text-slate-500"}`}>{c.a}</p>}
                {c.s === "absent" && <p className="text-red-700">Chưa chấm công</p>}
                {c.t?.map((t) => <p key={t} className="truncate text-[10px] text-indigo-700" title={t}>{t}</p>)}
                {c.s && <span className="sr-only">{STATUS_LABEL[c.s as Status]}</span>}
              </>}
            </td>
          );
        })}
      </tr>
      {editing && (
        <tr><td colSpan={days.length + 1} className="border-b border-slate-200 bg-slate-50 p-0">
          <WeekEditor r={r} onCancel={onEdit} onSaved={onSaved} />
        </td></tr>
      )}
    </>
  );
}

/** A PT driver's weekly shift, edited where it is read. Saving writes the days at once
 *  (until a newer weekly shift); days edited by hand are kept. */
function WeekEditor({ r, onCancel, onSaved }: { r: Row; onCancel: () => void; onSaved: () => void }) {
  // No weekly shift yet: start from what they actually worked, so this is a confirm, not a form.
  const guess = useMemo(() => (r.week ? null : guessWeek(r)), [r]);
  const firstWorked = Object.keys(r.cells).sort().find((d) => r.cells[d].a);
  const [from, setFrom] = useState(guess && firstWorked ? firstWorked : vnDate());
  // Each weekday carries its own hours (index = getUTCDay, 0 = CN); null = off.
  const [week, setWeek] = useState<Day[]>(() => r.week ? r.week.days.map((x) => (x ? { ...x } : null))
    : Array.from({ length: 7 }, (_, d) => ((guess?.days.length ? guess.days : [1, 2, 3, 4, 5, 6]).includes(d) ? { start: guess?.start ?? "", end: guess?.end ?? "" } : null)));
  const [saving, setSaving] = useState(false);
  const on = week.filter((x): x is NonNullable<Day> => !!x);
  const valid = on.length > 0 && on.every((x) => x.start && x.end && x.start !== x.end) && !!from;
  const set = (d: number, x: Day) => setWeek((w) => w.map((y, i) => (i === d ? x : y)));
  // Setting a time on one day also fills every ticked day still blank there: tick
  // the days, enter the hours once, then change only the day that differs.
  const setTime = (d: number, k: "start" | "end", v: string) =>
    setWeek((w) => w.map((y, i) => (!y ? y : i === d || !y[k] ? { ...y, [k]: v } : y)));
  // Ticking a day copies the hours of the nearest day before it, so a regular week is still one entry.
  const toggle = (d: number, checked: boolean) => {
    if (!checked) return set(d, null);
    const order = [1, 2, 3, 4, 5, 6, 0], at = order.indexOf(d);
    const near = [...order.slice(0, at).reverse(), ...order.slice(at + 1)].map((i) => week[i]).find(Boolean);
    set(d, near ? { ...near } : { start: "", end: "" });
  };
  async function save() {
    if (!valid) return;
    setSaving(true);
    try {
      const data = { employee_code: r.code || `driver:${r.driver_id}`, label: r.name, driver_id: r.driver_id,
        days: week, active_from: from, active_to: null, active: true, note: "", revision: 0, review_issues: [] };
      const res = await fetch("/api/driver-shifts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "patterns", data }) });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "Không lưu được ca tuần");
      const made = await fetch("/api/driver-shifts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "apply-pt", data: { driver_id: r.driver_id, date: from } }) });
      const m = await made.json();
      if (!made.ok || !m.ok) throw new Error(`Đã lưu ca tuần nhưng chưa tạo được lịch ngày: ${m.error || "lỗi"}`);
      toast.success(`Đã lưu ca tuần cho ${r.name} từ ${dm(from)}`);
      onSaved();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }
  return (
    <form className="sticky left-0 flex max-w-[60rem] flex-wrap items-end gap-3 p-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p className="w-full text-sm font-medium">Ca tuần của {r.name}<span className="ml-2 text-xs font-normal text-slate-600">{guess ? "Gợi ý theo giờ đã làm trong kỳ — kiểm tra rồi lưu. " : ""}Chọn ngày, nhập giờ một lần rồi sửa riêng ngày khác giờ · áp dụng từ ngày chọn đến khi có ca tuần mới · ngày sửa tay được giữ lại</span></p>
      <label className="text-xs text-slate-700">Từ ngày<input type="date" className={`${field} mt-1 block`} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <fieldset className="flex w-full flex-wrap gap-2"><legend className="sr-only">Giờ làm từng ngày trong tuần</legend>
        {[1, 2, 3, 4, 5, 6, 0].map((d) => {
          const x = week[d];
          return (
            <div key={d} className={`w-28 rounded-md border p-2 ${x ? "border-slate-300 bg-white" : "border-dashed border-slate-200"}`}>
              <label className="flex items-center gap-1.5 text-sm font-medium"><input type="checkbox" checked={!!x} disabled={saving} onChange={(e) => toggle(d, e.target.checked)} />{WD[d]}</label>
              {x ? <div className="mt-1.5 space-y-1">
                <PatternTimeSelect label={`${WD[d]} bắt đầu`} value={x.start} onChange={(v) => setTime(d, "start", v)} disabled={saving} />
                <PatternTimeSelect label={`${WD[d]} kết thúc`} value={x.end} onChange={(v) => setTime(d, "end", v)} disabled={saving} />
              </div> : <p className="mt-1.5 text-xs text-slate-500">Nghỉ</p>}
            </div>
          );
        })}
      </fieldset>
      <div className="flex gap-2 pb-0.5">
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}><X className="size-4" />Huỷ</Button>
        <Button type="submit" disabled={saving || !valid}>{saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}Lưu ca tuần</Button>
      </div>
    </form>
  );
}
