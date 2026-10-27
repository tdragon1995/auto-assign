"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Copy, Image as ImageIcon, LayoutTemplate, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { DriverCombobox } from "./driver-combobox";
import { addDays, vnDate } from "@/lib/time";
import { areaKey, rosterGaps, rosterSunday, TEMPLATE, validShift, type RosterLine, type RosterWeek } from "@/lib/sunday-roster";
import { stageFor, STAGE_LABEL } from "@/lib/sunday-roster-post";
import type { ConfigDriver } from "@/lib/types";

const box = "w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-900 placeholder:text-slate-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60";
const field = `h-8 ${box}`;
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
/** A Sunday or the template, as a reader names it. */
const named = (d: string) => (d === TEMPLATE ? "Lịch CN mẫu" : `Chủ nhật ${dmy(d)}`);

/**
 * Lịch Chủ nhật — who covers which area on a given Sunday.
 *
 * Edited as a whole week and saved in one go, the way the sheet was: most weeks
 * are another week with a handful of lines changed, so "Sao chép từ CN" (any
 * Sunday, earlier or later) then a few edits is the normal path. Drivers are PICKED (`DriverCombobox`), never
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
  /** The Sunday to copy from — only weeks that HAVE a roster are offered. */
  const [source, setSource] = useState("");
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

  const isTemplate = date === TEMPLATE;
  // Weeks that can be copied: they have a roster and are not this one. The default
  // is the template, else the nearest earlier Sunday, else the nearest later one.
  const dated = useMemo(() => (week?.weeks ?? []).filter((w) => w !== date), [week, date]);
  const withTemplate = !isTemplate && !!week?.hasTemplate;
  const copyable = useMemo(() => (withTemplate ? [TEMPLATE, ...dated] : dated), [withTemplate, dated]);
  const before = isTemplate ? dated[0] ?? null : dated.find((w) => w < date) ?? null;
  const after = isTemplate ? null : [...dated].reverse().find((w) => w > date) ?? null;
  useEffect(() => { setSource(withTemplate ? TEMPLATE : before ?? after ?? ""); }, [withTemplate, before, after]);

  const copyFrom = async (from: string) => {
    if (from === date) { toast.error("Chọn một Chủ nhật khác để sao chép"); return; }
    if (lines.length && !confirm(`Thay ${lines.length} dòng hiện tại bằng ${named(from)}?`)) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/sunday-roster?date=${from}`, { cache: "no-store" });
      const data: RosterWeek & { error?: string } = await res.json();
      if (!res.ok) throw new Error(data.error || "Không tải được lịch tuần được chọn");
      if (!data.lines.length) throw new Error(`${named(from)} chưa có lịch`);
      // Copied as unsaved lines: the version check still points at THIS week,
      // so saving replaces what is here.
      setLines(keyed(data.lines));
      setWeek((w) => (w ? { ...w, names: { ...w.names, ...data.names } } : w));
      setDirty(true);
      toast.info(`Đã sao chép từ ${named(from)} — sửa các dòng khác rồi bấm Lưu.`);
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
      toast.success(`Đã lưu ${data.saved} dòng cho ${named(date)}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // The drivers' post on demand — after fixing the roster, or ahead of the
  // Wednesday/Friday 13:00 posts. Draft until the Friday before the Sunday.
  const [posting, setPosting] = useState(false);
  const stage = isTemplate ? "draft" : stageFor(vnDate(), date);
  // test = the same post to the admin group only, to check it before drivers see it.
  const post = async (test = false) => {
    const what = `lịch Chủ nhật ${dmy(date)} (${STAGE_LABEL[stage].toLowerCase()}: ảnh lịch, ảnh ca trống, tin nhắn)`;
    if (!confirm(test ? `Gửi thử ${what} vào nhóm admin?` : `Đăng ${what} lên các nhóm Zalo tài xế?`)) return;
    setPosting(true);
    try {
      const res = await fetch(test ? "/api/sunday-roster/post/test" : "/api/sunday-roster/post", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date, stage }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không đăng được lên Zalo");
      toast.success(test ? `Đã gửi thử lịch Chủ nhật ${dmy(date)} vào nhóm admin` : `Đã đăng lịch Chủ nhật ${dmy(date)} lên nhóm tài xế`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  };

  const active = useMemo(() => new Map(drivers.map((d) => [d.driver_id, d.name])), [drivers]);
  const label = (id: string) => active.get(id) ?? week?.names[id] ?? id;
  const gaps = useMemo(() => rosterGaps(lines, week?.areas ?? []), [lines, week]);
  // Everything with nobody on it: areas Sunday rules need, and every empty line,
  // whether or not a rule points at its area (an empty slot is still a gap).
  const missing = useMemo(() => {
    const seen = new Set<string>(), out: string[] = [];
    for (const area of [...gaps.uncovered.map((a) => a.area), ...lines.filter((l) => l.area && !l.driver_id).map((l) => l.area)]) {
      if (!seen.has(areaKey(area))) { seen.add(areaKey(area)); out.push(area); }
    }
    return out;
  }, [gaps, lines]);
  const areaOptions = useMemo(() => {
    const opts = [...(week?.areas ?? [])];
    const known = new Set(opts.map((a) => areaKey(a.area)));
    for (const l of lines) if (l.area && !known.has(areaKey(l.area))) { known.add(areaKey(l.area)); opts.push({ area: l.area, rules: 0 }); }
    return opts;
  }, [week, lines]);
  const busy = loading || saving;
  // A Sunday pre-filled from last week is savable as it stands; leaving it loses
  // nothing, so only a real edit asks before navigating away.
  const unsaved = dirty || !!week?.copiedFrom;
  const incomplete = lines.some((l) => !l.area || !validShift(l.shift));
  const today = rosterSunday(vnDate());

  return (
    <section className="flex h-full min-h-0 flex-col rounded-xl border border-slate-200 bg-white text-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-3">
        {isTemplate ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => leave(today)}><ChevronLeft className="size-4" />CN tới</Button>
            <h2 className="font-semibold">Lịch CN mẫu</h2>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" aria-label="Chủ nhật trước" disabled={busy} onClick={() => leave(addDays(date, -7))}><ChevronLeft /></Button>
            <h2 className="min-w-[10rem] text-center font-semibold tabular-nums">Chủ nhật {dmy(date)}</h2>
            <Button variant="outline" size="icon" aria-label="Chủ nhật sau" disabled={busy} onClick={() => leave(addDays(date, 7))}><ChevronRight /></Button>
            {date !== today && <Button variant="ghost" size="sm" disabled={busy} onClick={() => leave(today)}>CN tới</Button>}
            <Button variant="ghost" size="sm" disabled={busy} title="Lịch mỗi Chủ nhật mới bắt đầu từ đây" onClick={() => leave(TEMPLATE)}><LayoutTemplate className="size-4" />Lịch mẫu</Button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {copyable.length > 0 && <>
            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              Sao chép từ
              <select className={`${field} w-auto`} value={source} disabled={busy} aria-label="Lịch để sao chép"
                onChange={(e) => setSource(e.target.value)}>
                {copyable.map((w) => <option key={w} value={w}>{w === TEMPLATE ? "Lịch mẫu" : `CN ${dmy(w)}`}</option>)}
              </select>
            </label>
            <Button variant="outline" disabled={busy || !source} onClick={() => void copyFrom(source)}><Copy className="size-4" />Sao chép</Button>
          </>}
          <Button variant="outline" disabled={busy} onClick={() => { if (discard()) void load(); }}><RefreshCw className="size-4" />Tải lại</Button>
          {!isTemplate && <>
          <Button variant="outline" disabled={busy || unsaved || !lines.length} title={unsaved ? "Lưu lịch trước" : "Xem trước ảnh và tin nhắn sẽ đăng lên Zalo"} onClick={() => window.open(`/api/sunday-roster/post?date=${date}&stage=${stage}`, "_blank", "noopener")}><ImageIcon className="size-4" />Xem ảnh</Button>
          <Button variant="outline" disabled={busy || posting || unsaved || !lines.length} title={unsaved ? "Lưu lịch trước" : "Gửi thử đúng bài đăng vào nhóm admin — tài xế không nhận"} onClick={() => void post(true)}><Send className="size-4" />Gửi thử</Button>
          <Button variant="outline" disabled={busy || posting || unsaved || !lines.length} title={unsaved ? "Lưu lịch trước" : "Đăng ngay lên các nhóm Zalo tài xế (tự động 13:00 thứ Tư bản dự kiến, 13:00 thứ Sáu bản chính thức)"} onClick={() => void post()}><Send className="size-4" />{posting ? "Đang đăng…" : "Đăng Zalo"}</Button>
          </>}
          <Button disabled={busy || !unsaved || !week || incomplete} title={incomplete ? "Mỗi dòng cần khu vực, ca dạng 06:00 - 15:00" : undefined} onClick={() => void save()}>{saving ? "Đang lưu…" : "Lưu lịch"}</Button>
        </div>
      </div>

      {!loading && !error && isTemplate && (
        <p role="status" className="border-b border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
          Mỗi Chủ nhật chưa lưu bắt đầu từ lịch này (thứ Hai 13:00 tự lưu cho Chủ nhật tới). Sửa ở đây những thay đổi lâu dài; đổi người cho một tuần thì sửa tuần đó. Lịch mẫu không dùng để phân công và không gửi cho tài xế.
        </p>
      )}

      {!loading && !error && week?.copiedFrom && (
        <p role="status" className="border-b border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
          Chủ nhật này chưa lưu — đang hiện <span className="font-medium">{named(week.copiedFrom)}</span>. Sửa những dòng khác tuần này rồi bấm Lưu lịch.
        </p>
      )}

      {!loading && !error && missing.length > 0 && (
        <div role="status" className="flex gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p><span className="font-medium">Chưa có tài xế: </span>{missing.join(" · ")}</p>
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
            <p className="mb-3">{named(date)} chưa có lịch.</p>
            {withTemplate || before || after ? (
              <div className="flex flex-wrap gap-2">
                {withTemplate && <Button variant="outline" disabled={busy} onClick={() => void copyFrom(TEMPLATE)}><Copy className="size-4" />Sao chép lịch mẫu</Button>}
                {before && <Button variant="outline" disabled={busy} onClick={() => void copyFrom(before)}><Copy className="size-4" />Sao chép CN {dmy(before)}</Button>}
                {after && <Button variant="outline" disabled={busy} onClick={() => void copyFrom(after)}><Copy className="size-4" />Sao chép CN {dmy(after)}</Button>}
              </div>
            ) : (
              <p className="text-xs text-slate-500">Chưa có Chủ nhật nào có lịch để sao chép — thêm dòng bên dưới.</p>
            )}
          </div>
        ) : (
          <table className="w-full min-w-[56rem] text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs font-medium text-slate-600">
              <tr>
                <th className="w-10 px-2 py-1.5">#</th>
                <th className="w-[30%] px-2 py-1.5">Khu vực</th>
                <th className="px-2 py-1.5">Tài xế</th>
                <th className="w-36 px-2 py-1.5">Ca</th>
                <th className="w-[22%] px-2 py-1.5">Ghi chú</th>
                <th className="w-10 px-2 py-1.5"><span className="sr-only">Xoá</span></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const inactive = l.driver_id && !active.has(l.driver_id);
                const off = l.driver_id ? week?.leave?.[l.driver_id] : undefined;
                // Red = nobody on the line, grey = on leave that Sunday, black = resigned.
                const tone = !l.driver_id ? "bg-red-50" : off?.kind === "resigned" ? "bg-slate-200" : off ? "bg-slate-50 text-slate-500" : "";
                return (
                  <tr key={l.k} className={`border-t border-slate-200 align-top ${tone}`}>
                    <td className="px-2 py-1 pt-2.5 text-xs tabular-nums text-slate-500">{i + 1}</td>
                    <td className="px-2 py-1">
                      <select aria-label={`Khu vực dòng ${i + 1}`} className={field} value={l.area} disabled={saving}
                        onChange={(e) => edit(i, { area: e.target.value })}>
                        {!l.area && <option value="">Chọn khu vực…</option>}
                        {areaOptions.map((a) => <option key={a.area} value={a.area}>{a.area}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <DriverCombobox max={1} drivers={drivers} ariaLabel={`Tài xế dòng ${i + 1}`} placeholder="Chưa có người"
                        names={l.driver_id ? [label(l.driver_id)] : []}
                        onChange={(_, picked) => edit(i, { driver_id: picked?.driver_id ?? null, raw_name: null })} />
                      {off && <p className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-xs font-medium ${off.kind === "resigned" ? "bg-slate-900 text-white" : "bg-slate-300 text-slate-800"}`}>{off.label}</p>}
                      {inactive && !off && <p className="mt-0.5 text-xs text-amber-800">Tài khoản đã ngừng hoạt động — chọn người khác</p>}
                      {!l.driver_id && l.raw_name && <p className="mt-0.5 text-xs text-amber-800">Tên “{l.raw_name}” chưa khớp tài xế nào</p>}
                    </td>
                    <td className="px-2 py-1">
                      <input aria-label={`Ca dòng ${i + 1}`} aria-invalid={!validShift(l.shift)}
                        className={`${validShift(l.shift) ? field : field.replace("border-slate-300", "border-red-600")} tabular-nums`}
                        placeholder="06:00 - 15:00" value={l.shift} disabled={saving} onChange={(e) => edit(i, { shift: e.target.value })} />
                    </td>
                    <td className="px-2 py-1">
                      <textarea aria-label={`Ghi chú dòng ${i + 1}`} rows={1} className={`${box} min-h-8 py-1`}
                        value={l.note} disabled={saving} onChange={(e) => edit(i, { note: e.target.value })} />
                    </td>
                    <td className="px-2 py-1">
                      <Button variant="ghost" size="icon" className="size-8 text-red-700" aria-label={`Xoá dòng ${i + 1}`} disabled={saving}
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
          {loading ? "Đang đọc Supabase" : `${lines.length} dòng${unsaved ? " · chưa lưu" : ""}`}
        </p>
        {!loading && !error && (
          <p className="flex flex-wrap items-center gap-3 text-xs text-slate-600" aria-label="Chú thích màu">
            <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="size-3 rounded-sm border border-red-300 bg-red-50" />Chưa có người</span>
            <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="size-3 rounded-sm bg-slate-300" />Nghỉ phép</span>
            <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="size-3 rounded-sm bg-slate-900" />Nghỉ việc</span>
          </p>
        )}
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
