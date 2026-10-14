"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Plus, Trash2, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { TimeSelect } from "./config-todo-panel";
import type { ConfigRowView } from "@/app/api/config/rows/route";
import { areaKey, suggestSundayArea, suggestSundayDay, type SundayLine } from "@/lib/sunday-roster";

/**
 * One clinic's Sunday in the Config tab: hours + area(s) per line, never a
 * driver. Who drives an area is Lịch Chủ nhật; this only says which areas'
 * people take this clinic's jobs. Saves the clinic's whole Sunday at once.
 */
export function SundayRuleEditor({ pickupName, customerId, rules, allRows, locations, onBusyChange, onCancel, onDone, onStale }: {
  pickupName: string; customerId: string;
  /** This clinic's Sunday rows (none for a clinic not set up yet). */
  rules: readonly ConfigRowView[];
  /** Every Sunday row: the area list and the suggestions come from these. */
  allRows: readonly ConfigRowView[];
  locations: readonly { id: string; name: string }[];
  onBusyChange: (busy: boolean) => void; onCancel: () => void; onDone: () => void; onStale: () => void;
}) {
  const listId = useId();
  const sunday = useMemo(() => allRows.filter((r) => !r.unmapped), [allRows]);
  const proposal = useMemo(() => rules.length ? null : suggestSundayDay(pickupName, customerId, sunday), [rules.length, pickupName, customerId, sunday]);
  const [lines, setLines] = useState<SundayLine[]>(() => rules.length
    ? rules.map((r) => ({ start: r.start, end: r.end, areas: r.areas ?? [], alt_drop_off_id: r.alt_drop_off_id ?? "" }))
    : proposal?.lines ?? [{ start: "", end: "", areas: [], alt_drop_off_id: "" }]);
  const [busy, setBusy] = useState(false);
  // The cleanup matters: a save closes the editor while still busy, and
  // without it the table's pencils stayed disabled until a reload.
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);

  const knownAreas = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of sunday) for (const a of r.areas ?? []) if (!m.has(areaKey(a))) m.set(areaKey(a), a);
    return [...m.values()].sort((a, b) => a.localeCompare(b, "vi"));
  }, [sunday]);
  // Alternate drop-offs are labs and PSCs, never clinics; the one already set stays offered.
  const dropOptions = useMemo(() => locations.filter((l) => /^(BRA|3PL)\b/.test(l.name)), [locations]);
  const nameOf = (id: string) => locations.find((l) => l.id === id)?.name ?? id;

  const set = (i: number, patch: Partial<SundayLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addArea = (i: number, raw: string) => {
    const a = raw.trim().replace(/\s+/g, " ");
    if (!a) return;
    const known = knownAreas.find((k) => areaKey(k) === areaKey(a)) ?? a;
    setLines((ls) => ls.map((l, j) => (j === i && !l.areas.some((x) => areaKey(x) === areaKey(known)) ? { ...l, areas: [...l.areas, known] } : l)));
  };
  const problem = lines.map((l) => !l.start || !l.end ? "Chọn giờ" : l.start === l.end ? "Giờ bắt đầu và kết thúc trùng nhau" : l.areas.length === 0 ? "Chọn khu vực" : "");

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/config/sunday-rules", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: customerId, expected: rules.map((r) => [r.rule_id, r.revision]), rules: lines }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 409) { toast.error(j.error || "Đã có người lưu — tải lại"); onStale(); return; }
      if (!res.ok || !j.ok) throw new Error(j.error || `Lỗi ${res.status}`);
      toast.success(lines.length ? `Đã lưu ${lines.length} ca Chủ nhật` : "Đã xoá lịch Chủ nhật của điểm này");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {proposal && <p className="rounded bg-white px-2 py-1.5 text-xs text-indigo-900">
        <Wand2 aria-hidden="true" className="mr-1 inline size-3.5" />Gợi ý theo điểm cùng khu vực ({proposal.from}). Kiểm tra rồi lưu.
      </p>}
      <datalist id={listId}>{knownAreas.map((a) => <option key={a} value={a} />)}</datalist>
      {lines.map((l, i) => {
        const hint = l.areas.length === 0 && l.start && l.end ? suggestSundayArea(pickupName, customerId, l.start, l.end, sunday) : null;
        return (
          <div key={i} className="flex flex-wrap items-start gap-2 rounded bg-white p-2">
            <div className="flex items-center gap-1">
              <TimeSelect label={`Ca ${i + 1}: bắt đầu`} value={l.start} onChange={(v) => set(i, { start: v })} />
              <span aria-hidden="true">–</span>
              <TimeSelect label={`Ca ${i + 1}: kết thúc`} value={l.end} onChange={(v) => set(i, { end: v })} />
            </div>
            <div className="min-w-[16rem] flex-1 space-y-1">
              <div className="flex flex-wrap gap-1">
                {l.areas.map((a) => (
                  <span key={a} className="inline-flex items-center gap-1 rounded bg-indigo-100 px-1.5 py-0.5 text-xs text-indigo-900">
                    {a}
                    {!knownAreas.some((k) => areaKey(k) === areaKey(a)) && <span className="text-amber-700">(mới)</span>}
                    <button type="button" aria-label={`Bỏ khu vực ${a}`} onClick={() => set(i, { areas: l.areas.filter((x) => x !== a) })}
                      className="rounded text-indigo-700 hover:text-indigo-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"><X aria-hidden="true" className="size-3" /></button>
                  </span>
                ))}
              </div>
              <input list={listId} aria-label={`Ca ${i + 1}: thêm khu vực`} placeholder={l.areas.length ? "Thêm khu vực…" : "Chọn khu vực…"}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addArea(i, e.currentTarget.value); e.currentTarget.value = ""; } }}
                onChange={(e) => { if (knownAreas.includes(e.currentTarget.value)) { addArea(i, e.currentTarget.value); e.currentTarget.value = ""; } }}
                onBlur={(e) => { addArea(i, e.currentTarget.value); e.currentTarget.value = ""; }}
                className="h-8 w-full rounded border border-slate-300 bg-white px-2 text-xs outline-none focus:ring-2 focus:ring-indigo-400/50" />
              {hint && <button type="button" onClick={() => set(i, { areas: hint })}
                className="text-left text-xs text-indigo-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                Gợi ý: {hint.join(" + ")} — dùng
              </button>}
            </div>
            <select aria-label={`Ca ${i + 1}: điểm giao thay thế`} value={l.alt_drop_off_id} onChange={(e) => set(i, { alt_drop_off_id: e.target.value })}
              className="h-8 max-w-[14rem] rounded border border-slate-300 bg-white px-1 text-xs">
              <option value="">Không đổi điểm giao</option>
              {l.alt_drop_off_id && !dropOptions.some((d) => d.id === l.alt_drop_off_id) && <option value={l.alt_drop_off_id}>{nameOf(l.alt_drop_off_id)}</option>}
              {dropOptions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <Button size="icon" variant="ghost" className="size-8 text-red-700 hover:bg-red-50" aria-label={`Xoá ca ${i + 1}`}
              onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 aria-hidden="true" className="size-4" /></Button>
            {problem[i] && <p className="basis-full text-xs text-red-700">{problem[i]}</p>}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setLines((ls) => [...ls, { start: "", end: "", areas: [], alt_drop_off_id: "" }])}>
          <Plus aria-hidden="true" className="size-3.5" />Thêm ca
        </Button>
        <span className="flex-1 text-xs text-slate-600">Ai trực khu vực nào: sửa ở Lịch Chủ nhật.</span>
        <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={busy} onClick={onCancel}>Huỷ</Button>
        <Button size="sm" className="h-8 bg-indigo-600 text-xs hover:bg-indigo-700" disabled={busy || problem.some(Boolean) || (lines.length === 0 && rules.length === 0)} onClick={save}>
          {busy ? "Đang lưu…" : lines.length === 0 ? "Xoá lịch Chủ nhật" : "Lưu"}
        </Button>
      </div>
    </div>
  );
}
