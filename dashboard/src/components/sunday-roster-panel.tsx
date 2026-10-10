"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Copy, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { DriverCombobox } from "./driver-combobox";
import { addDays, vnDate } from "@/lib/time";
import { areaKey, rosterGaps, rosterSunday, validShift, type RosterLine, type RosterWeek } from "@/lib/sunday-roster";
import type { ConfigDriver } from "@/lib/types";

const box = "w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-900 placeholder:text-slate-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60";
const field = `h-9 ${box}`;
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/**
 * Lịch Chủ nhật — who covers which area on a given Sunday.
 *
 * Edited as a whole week and saved in one go, the way the sheet was: most weeks
 * are last week with a handful of lines changed, so "Sao chép CN trước" then a
 * few edits is the normal path. Drivers are PICKED (`DriverCombobox`), never
 * typed, so a line always names a real account.
 */
type Line = RosterLine & { k: number };

export function SundayRosterPanel({ drivers }: { drivers: ConfigDriver[] }) {
  const [date, setDate] = useState(() => rosterSunday(vnDate()));
  const [week, setWeek] = useState<RosterWeek | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const seq = useRef(0);
  // Row keys for React only; never sent (the server keeps known fields only).
  const nextKey = useRef(0);
  const keyed = (ls: RosterLine[]): Line[] => ls.map((l) => ({ ...l, k: nextKey.current++ }));

  const load = useCallback(async () => {
    const current = ++seq.current;
    setLoading(true); setError("");
    try {
      const res = await fetch(`/api/sunday-roster?date=${date}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không tải được lịch Chủ nhật");
      if (current !== seq.current) return;
      setWeek(data); setLines(keyed(data.lines)); setDirty(false);
    } catch (e) {
      if (current === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (current === seq.current) setLoading(false);
    }
  }, [date]);
  useEffect(() => { void load(); }, [load]);

  const discard = () => !dirty || confirm("Lịch này chưa lưu. Bỏ các thay đổi?");
  const leave = (next: string) => { if (discard()) setDate(next); };
  const edit = (i: number, patch: Partial<RosterLine>) => {
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
    setDirty(true);
  };

  const copyPrevious = async () => {
    if (lines.length && !confirm(`Thay ${lines.length} dòng hiện tại bằng lịch Chủ nhật ${dmy(addDays(date, -7))}?`)) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/sunday-roster?date=${addDays(date, -7)}`, { cache: "no-store" });
      const data: RosterWeek & { error?: string } = await res.json();
      if (!res.ok) throw new Error(data.error || "Không tải được lịch tuần trước");
      if (!data.lines.length) throw new Error(`Chủ nhật ${dmy(addDays(date, -7))} chưa có lịch`);
      // Copied as unsaved lines: the version check still points at THIS week,
      // so saving replaces what is here.
      setLines(keyed(data.lines));
      setWeek((w) => (w ? { ...w, names: { ...w.names, ...data.names } } : w));
      setDirty(true);
      toast.info("Đã sao chép — sửa các dòng khác tuần trước rồi bấm Lưu.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!week) return;
    setSaving(true);
    try {
      const res = await fetch("/api/sunday-roster", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, ids: week.ids, lines }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không lưu được lịch Chủ nhật");
      toast.success(`Đã lưu ${data.saved} dòng cho Chủ nhật ${dmy(date)}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const active = useMemo(() => new Map(drivers.map((d) => [d.driver_id, d.name])), [drivers]);
  const label = (id: string) => active.get(id) ?? week?.names[id] ?? id;
  const gaps = useMemo(() => rosterGaps(lines, week?.areas ?? []), [lines, week]);
  const areaOptions = useMemo(() => {
    const opts = [...(week?.areas ?? [])];
    const known = new Set(opts.map((a) => areaKey(a.area)));
    for (const l of lines) if (l.area && !known.has(areaKey(l.area))) { known.add(areaKey(l.area)); opts.push({ area: l.area, rules: 0 }); }
    return opts;
  }, [week, lines]);
  const busy = loading || saving;
  const incomplete = lines.some((l) => !l.area || !validShift(l.shift));
  const today = rosterSunday(vnDate());

  return (
    <section className="flex h-full min-h-0 flex-col rounded-xl border border-slate-200 bg-white text-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Chủ nhật trước" disabled={busy} onClick={() => leave(addDays(date, -7))}><ChevronLeft /></Button>
          <h2 className="min-w-[10rem] text-center font-semibold tabular-nums">Chủ nhật {dmy(date)}</h2>
          <Button variant="outline" size="icon" aria-label="Chủ nhật sau" disabled={busy} onClick={() => leave(addDays(date, 7))}><ChevronRight /></Button>
          {date !== today && <Button variant="ghost" size="sm" disabled={busy} onClick={() => leave(today)}>CN tới</Button>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void copyPrevious()}><Copy className="size-4" />Sao chép CN trước</Button>
          <Button variant="outline" disabled={busy} onClick={() => { if (discard()) void load(); }}><RefreshCw className="size-4" />Tải lại</Button>
          <Button disabled={busy || !dirty || !week || incomplete} title={incomplete ? "Mỗi dòng cần khu vực, ca dạng 06:00 - 15:00" : undefined} onClick={() => void save()}>{saving ? "Đang lưu…" : "Lưu lịch"}</Button>
        </div>
      </div>

      {!loading && !error && gaps.uncovered.length > 0 && (
        <div role="status" className="flex gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p>
            <span className="font-medium">Chưa có tài xế — các quy tắc này sẽ không được phân công: </span>
            {gaps.uncovered.map((a) => `${a.area} (${a.rules} quy tắc)`).join(" · ")}
          </p>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto" aria-busy={loading}>
        {error ? (
          <p role="alert" className="p-4 text-sm text-red-700">{error} · Bấm Tải lại để thử lại.</p>
        ) : loading ? (
          <div role="status" className="space-y-3 p-4">
            <p className="text-sm text-slate-600">Đang tải lịch Chủ nhật…</p>
            {[1, 2, 3].map((n) => <div key={n} className="h-10 rounded bg-slate-100 motion-safe:animate-pulse" />)}
          </div>
        ) : lines.length === 0 ? (
          <div className="p-6 text-sm text-slate-600">
            <p className="mb-3">Chủ nhật {dmy(date)} chưa có lịch.</p>
            <Button variant="outline" disabled={busy} onClick={() => void copyPrevious()}><Copy className="size-4" />Sao chép CN {dmy(addDays(date, -7))}</Button>
          </div>
        ) : (
          <table className="w-full min-w-[56rem] text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs font-medium text-slate-600">
              <tr>
                <th className="w-10 p-2">#</th>
                <th className="w-[30%] p-2">Khu vực</th>
                <th className="p-2">Tài xế</th>
                <th className="w-36 p-2">Ca</th>
                <th className="w-[22%] p-2">Ghi chú</th>
                <th className="w-10 p-2"><span className="sr-only">Xoá</span></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const inactive = l.driver_id && !active.has(l.driver_id);
                return (
                  <tr key={l.k} className="border-t border-slate-200 align-top">
                    <td className="p-2 pt-4 text-xs tabular-nums text-slate-500">{i + 1}</td>
                    <td className="p-2">
                      <select aria-label={`Khu vực dòng ${i + 1}`} className={field} value={l.area} disabled={saving}
                        onChange={(e) => edit(i, { area: e.target.value })}>
                        {!l.area && <option value="">Chọn khu vực…</option>}
                        {areaOptions.map((a) => <option key={a.area} value={a.area}>{a.rules ? `${a.area} · ${a.rules} quy tắc` : a.area}</option>)}
                      </select>
                      {l.area && gaps.unused.has(areaKey(l.area)) && <p className="mt-1 text-xs text-slate-500">Không quy tắc Chủ nhật nào dùng khu vực này</p>}
                    </td>
                    <td className="p-2">
                      <DriverCombobox max={1} drivers={drivers} ariaLabel={`Tài xế dòng ${i + 1}`} placeholder="Chưa có người"
                        names={l.driver_id ? [label(l.driver_id)] : []}
                        onChange={(_, picked) => edit(i, { driver_id: picked?.driver_id ?? null, raw_name: null })} />
                      {inactive && <p className="mt-1 text-xs text-amber-800">Tài khoản đã ngừng hoạt động — chọn người khác</p>}
                      {!l.driver_id && l.raw_name && <p className="mt-1 text-xs text-amber-800">Tên “{l.raw_name}” chưa khớp tài xế nào</p>}
                    </td>
                    <td className="p-2">
                      <input aria-label={`Ca dòng ${i + 1}`} aria-invalid={!validShift(l.shift)}
                        className={`${validShift(l.shift) ? field : field.replace("border-slate-300", "border-red-600")} tabular-nums`}
                        placeholder="06:00 - 15:00" value={l.shift} disabled={saving} onChange={(e) => edit(i, { shift: e.target.value })} />
                    </td>
                    <td className="p-2">
                      <textarea aria-label={`Ghi chú dòng ${i + 1}`} rows={1} className={`${box} min-h-9 py-1.5`}
                        value={l.note} disabled={saving} onChange={(e) => edit(i, { note: e.target.value })} />
                    </td>
                    <td className="p-2">
                      <Button variant="ghost" size="icon" className="text-red-700" aria-label={`Xoá dòng ${i + 1}`} disabled={saving}
                        onClick={() => { setLines((prev) => prev.filter((_, j) => j !== i)); setDirty(true); }}><Trash2 className="size-4" /></Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-3 py-2">
        <p className="text-xs text-slate-600">
          {loading ? "Đang đọc Supabase" : `${lines.length} dòng${dirty ? " · chưa lưu" : ""} · Supabase · Chưa dùng để phân công — động cơ vẫn đọc Google Sheet`}
        </p>
        {!loading && !error && (
          <Button variant="outline" size="sm" disabled={saving}
            onClick={() => { setLines((prev) => [...prev, ...keyed([{ area: "", driver_id: null, raw_name: null, shift: "", note: "" }])]); setDirty(true); }}>
            <Plus className="size-4" />Thêm dòng
          </Button>
        )}
      </div>
    </section>
  );
}
