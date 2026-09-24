"use client";

import { useEffect, useMemo, useState, useCallback, useId, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Copy, Search } from "lucide-react";
import { DIAG_LOCATIONS } from "@/lib/diag-locations";
import { foldName } from "@/lib/driver-cell";
import type { ConfigDriver } from "@/lib/types";
import { toast } from "sonner";

type Env = "prod" | "uat";

interface ScheduleRow {
  rowIndex: number;
  pickup_id: string;
  pickup_name: string;
  dropoff_id: string;
  dropoff_name: string;
  delivery_window: string;
  reference: string;
  sent_to_driver_before: number;
  days: boolean[]; // index 0=Sun .. 6=Sat
  driver_name: string;
  driver_id: string;
}

/** Form state for add / edit. `rowIndex` null = new row. */
interface Draft {
  rowIndex: number | null;
  original: { reference: string; pickup_id: string } | null;
  pickup_id: string;
  pickup_name: string;
  dropoff_id: string;
  dropoff_name: string;
  delivery_window: string;
  reference: string;
  sent_to_driver_before: number;
  days: boolean[];
  driver_id: string;
}

const EMPTY_DRAFT: Draft = {
  rowIndex: null,
  original: null,
  pickup_id: "",
  pickup_name: "",
  dropoff_id: "",
  dropoff_name: "",
  delivery_window: "",
  reference: "",
  sent_to_driver_before: 60,
  days: [false, true, true, true, true, true, true],
  driver_id: "",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LocOption {
  id: string;
  name: string;
}

// customer_id → short name ("D001"), used only as a fallback when the sheet has
// no name for a row.
const NAME_BY_ID = new Map(DIAG_LOCATIONS.map((l) => [l.customer_id, l.name]));
// customer_id → full Cartrack customer name ("BRA - D001") — what the sheet's
// pickup/dropoff columns must hold for their *_id formulas to resolve.
const FULL_NAME_BY_ID = new Map(DIAG_LOCATIONS.map((l) => [l.customer_id, l.customer_name]));
// Prefer the sheet's own pickup/dropoff name column; fall back to the branch
// list, then the raw id.
const labelFor = (name: string, id: string) => name || NAME_BY_ID.get(id) || id;

// Sheet days are Sun..Sat; show the week starting Monday for readability.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_FULL = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];
const DAY_SHORT = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

/** Subtract `mins` from "HH:MM", clamped to 00:00. */
function minusMinutes(hhmm: string, mins: number): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  let total = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) - mins;
  if (total < 0) total = 0;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function activeDays(days: boolean[]): number[] {
  return WEEK_ORDER.filter((i) => days[i]);
}

function suggestedReference(pickup: string, dropoff: string, window: string): string {
  const short = (name: string) => name.split(" - ").pop()?.trim() ?? "";
  return pickup && dropoff && window ? `${short(pickup)}→${short(dropoff)} ${window}` : "";
}

const INPUT_CLS =
  "w-full border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-slate-400";

/** Search the sheet's locations and explicitly select the matching customer. */
function LocationField({
  label,
  id,
  name,
  options,
  onChange,
}: {
  label: string;
  id: string;
  name: string;
  options: LocOption[];
  onChange: (id: string, name: string) => void;
}) {
  const listId = useId();
  const [text, setText] = useState(name || id);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const matches = useMemo(() => {
    const terms = foldName(text.trim()).split(/[^a-z0-9]+/).filter(Boolean);
    if (!terms.length) return [];
    return options.filter((o) => {
      const haystack = foldName(`${o.name} ${o.id}`);
      return terms.every((term) => haystack.includes(term));
    }).slice(0, 20);
  }, [options, text]);
  const select = (o: LocOption) => {
    setText(o.name);
    setOpen(false);
    onChange(o.id, o.name);
  };
  const resolve = (t: string) => {
    setText(t);
    setOpen(true);
    setActive(-1);
    const v = t.trim();
    const hit = options.find((o) => o.name === v);
    if (hit) return select(hit);
    // A pasted UUID still needs its full customer name: the sheet's *_id
    // columns are formulas that look the id up FROM the name.
    if (UUID_RE.test(v)) {
      const byId = options.find((o) => o.id === v);
      if (byId) return select(byId);
      return onChange(v, "");
    }
    onChange("", v);
  };
  return (
    <div className="relative block space-y-0.5" onBlur={(e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
    }}>
      <label htmlFor={`${listId}-input`} className="block text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</label>
      <input
        id={`${listId}-input`}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open && matches.length > 0}
        aria-activedescendant={open && active >= 0 && matches.length ? `${listId}-${active}` : undefined}
        value={text}
        onChange={(e) => resolve(e.target.value)}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { setOpen(false); return; }
          if (!matches.length) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((n) => (n + 1) % matches.length); }
          if (e.key === "ArrowUp") { e.preventDefault(); setOpen(true); setActive((n) => (n <= 0 ? matches.length : n) - 1); }
          if (e.key === "Enter" && open) { e.preventDefault(); select(matches[Math.max(active, 0)]); }
        }}
        className={INPUT_CLS}
        placeholder="Tên / mã / UUID"
      />
      {open && matches.length > 0 && (
        <div id={listId} role="listbox" className="absolute z-30 mt-1 max-h-52 w-full overflow-y-auto rounded border border-slate-300 bg-white shadow-lg">
          {matches.map((o, i) => (
            <button
              key={`${o.id}|${o.name}`}
              id={`${listId}-${i}`}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(o)}
              className={`block w-full px-2 py-1.5 text-left text-xs hover:bg-indigo-50 ${i === active ? "bg-indigo-50" : ""}`}
            >{o.name}</button>
          ))}
        </div>
      )}
      <span className={`block text-[10px] font-mono truncate ${id && name ? "text-slate-400" : "text-red-500"}`}>
        {!id ? "chưa khớp địa điểm" : !name ? "UUID chưa có tên khách hàng — chọn từ danh sách" : id}
      </span>
    </div>
  );
}

/** Pre-assign driver chooser — names from the Driver tab; blank = none. */
function DriverField({
  drivers,
  driverId,
  onChange,
}: {
  drivers: ConfigDriver[];
  driverId: string;
  onChange: (id: string) => void;
}) {
  const listId = useId();
  const [text, setText] = useState(drivers.find((d) => d.driver_id === driverId)?.name ?? driverId);
  const matched = drivers.find((d) => d.driver_id === driverId);
  return (
    <label className="block space-y-0.5">
      <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Tài xế gán trước</span>
      <div className="flex gap-1">
        <input
          list={listId}
          value={text}
          onChange={(e) => {
            const t = e.target.value;
            setText(t);
            const hit = drivers.find((d) => d.name === t.trim() || d.driver_id === t.trim());
            onChange(hit?.driver_id ?? (t.trim() ? "?" : ""));
          }}
          className={INPUT_CLS}
          placeholder="Để trống = gán tự động"
        />
        {text && (
          <button type="button" onClick={() => { setText(""); onChange(""); }} className="px-1.5 text-slate-400 hover:text-slate-600">
            ✕
          </button>
        )}
      </div>
      <datalist id={listId}>
        {drivers.map((d) => <option key={d.driver_id} value={d.name} />)}
      </datalist>
      <span className={`block text-[10px] ${driverId === "?" ? "text-red-500" : "text-slate-400"}`}>
        {driverId === "?" ? "chưa khớp tài xế nào" : matched ? `Gán thẳng cho ${matched.name} khi tới giờ gửi` : "Gán theo mapping / smart như thường"}
      </span>
    </label>
  );
}

/** Copy one existing schedule into the new form; saving remains a separate action. */
function CopyFromSchedule({
  rows,
  panelId,
  onCopy,
  onClose,
}: {
  rows: ScheduleRow[];
  panelId: string;
  onCopy: (row: ScheduleRow) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  useEffect(() => { inputRef.current?.focus(); }, []);

  const matches = useMemo(() => {
    const terms = foldName(query).split(/[^a-z0-9]+/).filter(Boolean);
    if (!terms.length) return [];
    return rows.filter((r) => {
      if (!r.pickup_id || !r.pickup_name || !r.dropoff_id || !r.dropoff_name || !r.delivery_window) return false;
      const haystack = foldName(`${r.pickup_name} ${r.dropoff_name} ${r.reference} ${r.driver_name} ${r.delivery_window}`);
      return terms.every((term) => haystack.includes(term));
    });
  }, [rows, query]);
  const shown = matches.slice(0, 8);
  const activeIndex = Math.min(active, shown.length - 1);
  const take = (row: ScheduleRow) => {
    onCopy(row);
    onClose();
  };

  return (
    <div id={panelId} className="rounded-md border border-slate-300 bg-slate-50 p-2">
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-slate-500" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Tìm lịch để copy"
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded={shown.length > 0}
            aria-activedescendant={shown.length ? `${listId}-o${activeIndex}` : undefined}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); onClose(); }
              else if (e.key === "ArrowDown" && shown.length) { e.preventDefault(); setActive((activeIndex + 1) % shown.length); }
              else if (e.key === "ArrowUp" && shown.length) { e.preventDefault(); setActive((activeIndex - 1 + shown.length) % shown.length); }
              else if (e.key === "Enter" && shown[activeIndex]) { e.preventDefault(); take(shown[activeIndex]); }
            }}
            placeholder="Tìm điểm lấy, điểm giao, reference hoặc tài xế…"
            className={`${INPUT_CLS} pl-7`}
          />
        </div>
        <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[11px]" onClick={onClose}>Đóng</Button>
      </div>
      <p className="mt-1 text-[11px] text-slate-600">Copy vào form, xem lại rồi bấm Lưu để tạo lịch mới.</p>
      {query.trim() && shown.length === 0 && <p className="mt-1.5 text-[11px] text-slate-600">Không có lịch nào khớp.</p>}
      {shown.length > 0 && (
        <ul id={listId} role="listbox" aria-label="Lịch để copy" className="mt-1.5 space-y-1">
          {shown.map((r, i) => (
            <li key={r.rowIndex}>
              <button
                type="button"
                id={`${listId}-o${i}`}
                role="option"
                aria-selected={i === activeIndex}
                tabIndex={-1}
                onMouseEnter={() => setActive(i)}
                onClick={() => take(r)}
                className={`w-full rounded border p-1.5 text-left text-[11px] transition-colors ${i === activeIndex ? "border-indigo-400 bg-indigo-50" : "border-slate-200 bg-white hover:border-indigo-300"}`}
              >
                <span className="block font-medium text-slate-800">{r.pickup_name} → {r.dropoff_name}</span>
                <span className="block text-slate-600">{r.delivery_window} · {activeDays(r.days).map((day) => DAY_SHORT[day]).join(", ")} · {r.driver_name || "gán tự động"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {matches.length > shown.length && <p className="mt-1 text-[11px] text-slate-600">Còn {matches.length - shown.length} lịch nữa — gõ thêm để thu hẹp.</p>}
    </div>
  );
}

function ScheduleForm({
  initial,
  drivers,
  locations,
  sourceRows,
  onSaved,
  onCancel,
}: {
  initial: Draft;
  drivers: ConfigDriver[];
  locations: LocOption[];
  sourceRows: ScheduleRow[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [refTouched, setRefTouched] = useState(initial.rowIndex !== null);
  const [saving, setSaving] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyVersion, setCopyVersion] = useState(0);
  const copyBtnRef = useRef<HTMLButtonElement>(null);
  const copyPanelId = useId();
  const isNew = d.rowIndex === null;

  const set = (patch: Partial<Draft>) =>
    setD((prev) => {
      const next = { ...prev, ...patch };
      // New rows: suggest a reference in the sheet's own style
      // ("Bệnh Viện X→D028 14:30") until the user types one.
      if (!refTouched) {
        next.reference = suggestedReference(next.pickup_name, next.dropoff_name, next.delivery_window);
      }
      return next;
    });

  const problem =
    !d.pickup_id || !d.pickup_name ? "Chưa chọn điểm lấy"
    : !d.dropoff_id || !d.dropoff_name ? "Chưa chọn điểm giao"
    : !/^\d{2}:\d{2}$/.test(d.delivery_window) ? "Chưa nhập giờ lấy"
    : !d.reference.trim() ? "Thiếu reference"
    : d.driver_id === "?" ? "Tài xế chưa khớp"
    : !d.days.some(Boolean) ? "Chưa chọn ngày nào"
    : null;

  const save = async () => {
    if (problem) return;
    setSaving(true);
    try {
      const res = await fetch("/api/schedule-job/row", {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rowIndex: d.rowIndex,
          original: d.original,
          pickup_id: d.pickup_id,
          pickup_name: d.pickup_name,
          dropoff_id: d.dropoff_id,
          dropoff_name: d.dropoff_name,
          delivery_window: d.delivery_window,
          reference: d.reference.trim(),
          sent_to_driver_before: d.sent_to_driver_before,
          days: d.days,
          driver_id: d.driver_id,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        toast.error(`Lưu lịch lỗi: ${data.error ?? `HTTP ${res.status}`}`);
        return;
      }
      toast.success(isNew ? `Đã thêm lịch (dòng ${data.row})` : `Đã cập nhật lịch (dòng ${data.row})`);
      if (data.warning) toast.warning(data.warning);
      onSaved();
    } catch (e) {
      toast.error(`Lưu lịch lỗi: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (isNew || !d.original) return;
    if (!window.confirm(`Xoá lịch "${d.original.reference}" (dòng ${d.rowIndex}) khỏi sheet?`)) return;
    setSaving(true);
    try {
      const res = await fetch("/api/schedule-job/row", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowIndex: d.rowIndex, original: d.original }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        toast.error(`Xoá lịch lỗi: ${data.error ?? `HTTP ${res.status}`}`);
        return;
      }
      toast.success(`Đã xoá lịch (dòng ${data.row})`);
      onSaved();
    } catch (e) {
      toast.error(`Xoá lịch lỗi: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded border-2 border-indigo-300 bg-indigo-50/40 p-2 space-y-2">
      <div className="text-[11px] font-semibold text-indigo-800">
        {isNew ? "➕ Thêm lịch cố định" : `✏️ Sửa lịch — dòng ${d.rowIndex}`}
      </div>
      {isNew && (
        <>
          <div className="border-b border-slate-200 pb-1.5">
            <Button
              ref={copyBtnRef}
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-[11px] font-semibold border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
              aria-expanded={copyOpen}
              aria-controls={copyPanelId}
              onClick={() => setCopyOpen((open) => !open)}
              disabled={saving}
            >
              <Copy className="size-3.5" aria-hidden />
              Copy từ lịch khác
            </Button>
          </div>
          {copyOpen && (
            <CopyFromSchedule
              rows={sourceRows}
              panelId={copyPanelId}
              onClose={() => { setCopyOpen(false); copyBtnRef.current?.focus(); }}
              onCopy={(source) => {
                setD((prev) => {
                  const pickup = prev.pickup_id && prev.pickup_name
                    ? { id: prev.pickup_id, name: prev.pickup_name }
                    : { id: source.pickup_id, name: source.pickup_name };
                  const dropoff = prev.dropoff_id && prev.dropoff_name
                    ? { id: prev.dropoff_id, name: prev.dropoff_name }
                    : { id: source.dropoff_id, name: source.dropoff_name };
                  const window = source.delivery_window.padStart(5, "0");
                  return {
                    ...prev,
                    pickup_id: pickup.id,
                    pickup_name: pickup.name,
                    dropoff_id: dropoff.id,
                    dropoff_name: dropoff.name,
                    delivery_window: window,
                    sent_to_driver_before: source.sent_to_driver_before,
                    days: [...source.days],
                    driver_id: source.driver_id,
                    reference: refTouched ? prev.reference : suggestedReference(pickup.name, dropoff.name, window),
                  };
                });
                setCopyVersion((version) => version + 1);
                toast.success("Đã copy vào form — xem lại rồi bấm Lưu");
              }}
            />
          )}
        </>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <LocationField
          key={`pickup-${copyVersion}`}
          label="Điểm lấy"
          id={d.pickup_id}
          name={d.pickup_name}
          options={locations}
          onChange={(id, name) => set({ pickup_id: id, pickup_name: name })}
        />
        <LocationField
          key={`dropoff-${copyVersion}`}
          label="Điểm giao"
          id={d.dropoff_id}
          name={d.dropoff_name}
          options={locations}
          onChange={(id, name) => set({ dropoff_id: id, dropoff_name: name })}
        />
        <label className="block space-y-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Giờ lấy</span>
          <input type="time" value={d.delivery_window} onChange={(e) => set({ delivery_window: e.target.value })} className={INPUT_CLS} />
        </label>
        <label className="block space-y-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Gửi trước (phút)</span>
          <input
            type="number"
            min={0}
            max={720}
            value={d.sent_to_driver_before}
            onChange={(e) => set({ sent_to_driver_before: Math.max(0, parseInt(e.target.value, 10) || 0) })}
            className={INPUT_CLS}
          />
        </label>
        <label className="block space-y-0.5 sm:col-span-2">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Reference</span>
          <input
            value={d.reference}
            onChange={(e) => { setRefTouched(true); setD((p) => ({ ...p, reference: e.target.value })); }}
            className={`${INPUT_CLS} font-mono`}
          />
          {!isNew && d.original && d.reference.trim() !== d.original.reference && (
            <span className="block text-[10px] text-amber-600">
              Đổi reference: job hôm nay (nếu đã tạo) sẽ không được nhận ra là trùng khi chạy lại.
            </span>
          )}
        </label>
        <div className="sm:col-span-2">
          <DriverField key={`driver-${copyVersion}`} drivers={drivers} driverId={d.driver_id} onChange={(id) => set({ driver_id: id })} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mr-1">Ngày</span>
        {WEEK_ORDER.map((i) => (
          <button
            key={i}
            type="button"
            onClick={() => set({ days: d.days.map((v, j) => (j === i ? !v : v)) })}
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
              d.days[i] ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {DAY_SHORT[i]}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" className="h-7 text-xs bg-indigo-600 hover:bg-indigo-700" disabled={!!problem || saving} onClick={save}>
          {saving ? "Đang lưu…" : "Lưu"}
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={saving} onClick={onCancel}>
          Huỷ
        </Button>
        {problem && <span className="text-[10px] text-slate-500">{problem}</span>}
        {!isNew && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7 text-xs text-red-600 border-red-200 hover:bg-red-50"
            disabled={saving}
            onClick={remove}
          >
            Xoá
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The "Lịch cố định" tab: every fixed schedule, with live filtering by
 * pickup/dropoff (name or code), weekday and driver, plus add / edit / delete
 * (written straight to the sheet). A row may name a pre-assigned driver: the job then
 * goes to that driver when it's released from the proxy. Run incidents are
 * surfaced separately in the "Cần xử lý" tab, not here.
 */
export function ScheduleListPanel({ env, drivers }: { env: Env; drivers: ConfigDriver[] }) {
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [dayFilter, setDayFilter] = useState<Set<number>>(new Set());
  const [running, setRunning] = useState(false);
  // Open form: "new" or the rowIndex being edited.
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [sheetLocations, setSheetLocations] = useState<LocOption[] | null>(null);
  const [loadingLocations, setLoadingLocations] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch("/api/schedule-job/list", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (alive) setRows(Array.isArray(d.rows) ? d.rows : []); })
      .catch(() => { if (alive) setRows([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [reloadKey]);

  const onSaved = useCallback(() => {
    setEditing(null);
    setReloadKey((k) => k + 1);
  }, []);

  const openForm = async (target: number | "new") => {
    if (!sheetLocations) {
      setLoadingLocations(true);
      try {
        const res = await fetch("/api/schedule-job/locations", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || !Array.isArray(data.locations) || data.locations.length === 0)
          throw new Error(data.error ?? "Danh sách địa điểm trống");
        setSheetLocations(data.locations as LocOption[]);
      } catch (e) {
        toast.error(`Không tải được địa điểm: ${String(e)}`);
        return;
      } finally {
        setLoadingLocations(false);
      }
    }
    setEditing(target);
  };

  // Use the same Location Table as the sheet's name-to-id formulas. Keep the
  // existing schedule rows as fallbacks for names removed from that table.
  const locations = useMemo<LocOption[]>(() => {
    const byName = new Map<string, LocOption>();
    const add = (id: string, name: string) => {
      if (id && name && !byName.has(name)) byName.set(name, { id, name });
    };
    sheetLocations?.forEach((l) => add(l.id, l.name));
    DIAG_LOCATIONS.forEach((l) => add(l.customer_id, l.customer_name));
    rows.forEach((r) => { add(r.pickup_id, r.pickup_name); add(r.dropoff_id, r.dropoff_name); });
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, sheetLocations]);

  const draftFor = (r: ScheduleRow): Draft => ({
    rowIndex: r.rowIndex,
    original: { reference: r.reference, pickup_id: r.pickup_id },
    pickup_id: r.pickup_id,
    pickup_name: r.pickup_name || FULL_NAME_BY_ID.get(r.pickup_id) || "",
    dropoff_id: r.dropoff_id,
    dropoff_name: r.dropoff_name || FULL_NAME_BY_ID.get(r.dropoff_id) || "",
    delivery_window: /^\d:\d{2}$/.test(r.delivery_window) ? `0${r.delivery_window}` : r.delivery_window,
    reference: r.reference,
    sent_to_driver_before: r.sent_to_driver_before,
    days: [...r.days],
    driver_id: r.driver_id,
  });

  const driverLabel = (r: ScheduleRow) =>
    r.driver_name || drivers.find((d) => d.driver_id === r.driver_id)?.name || r.driver_id;

  const runNow = useCallback(async () => {
    setRunning(true);
    try {
      const res = await fetch(`/api/schedule-job?env=${env}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) toast.error(`Lịch cố định: ${data.error ?? `HTTP ${res.status}`}`);
      else if (data.counts) {
        const { ok, skipped, error } = data.counts;
        toast.success(`Lịch cố định: ${ok} tạo / ${skipped} bỏ qua / ${error} lỗi`);
      } else toast.info(data.message ?? "Không có gì để chạy");
    } catch (e) {
      toast.error(`Lịch cố định lỗi: ${String(e)}`);
    } finally {
      setRunning(false);
    }
  }, [env]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => r.pickup_id && r.dropoff_id && r.delivery_window)
      .filter((r) => {
        if (dayFilter.size > 0 && !WEEK_ORDER.some((i) => dayFilter.has(i) && r.days[i])) return false;
        if (!q) return true;
        const hay = `${r.pickup_name} ${r.pickup_id} ${r.dropoff_name} ${r.dropoff_id} ${r.driver_name} ${r.reference}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => a.delivery_window.padStart(5, "0").localeCompare(b.delivery_window.padStart(5, "0")));
  }, [rows, query, dayFilter]);

  const toggleDay = (i: number) =>
    setDayFilter((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });

  return (
    <Card className="flex flex-col h-full py-4">
      <CardHeader className="pb-2 shrink-0 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">📅 Lịch cố định</CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{filtered.length}/{rows.length}</span>
            <Button
              size="sm"
              className="h-7 text-xs bg-indigo-600 hover:bg-indigo-700"
              disabled={editing !== null || loadingLocations}
              onClick={() => void openForm("new")}
            >
              {loadingLocations ? "Đang tải địa điểm…" : "+ Thêm"}
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={running} onClick={runNow}>
              {running ? "Đang chạy…" : "Chạy thủ công"}
            </Button>
          </div>
        </div>

        {/* Filters: free text (pickup/dropoff, name or code) + weekday chips */}
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Lọc theo điểm lấy / điểm giao / tài xế / reference…"
          className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mr-1">Thứ</span>
          {WEEK_ORDER.map((i) => (
            <button
              key={i}
              type="button"
              onClick={() => toggleDay(i)}
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
                dayFilter.has(i) ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {DAY_SHORT[i]}
            </button>
          ))}
          {dayFilter.size > 0 && (
            <button
              type="button"
              onClick={() => setDayFilter(new Set())}
              className="text-[10px] font-semibold text-slate-400 hover:text-slate-600 ml-1"
            >
              Xoá
            </button>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="space-y-1.5 pr-3 text-xs">
            {editing === "new" && (
              <ScheduleForm
                initial={EMPTY_DRAFT}
                drivers={drivers}
                locations={locations}
                sourceRows={rows}
                onSaved={onSaved}
                onCancel={() => setEditing(null)}
              />
            )}
            {loading && <p className="text-muted-foreground text-center py-8">Đang tải…</p>}
            {!loading && filtered.length === 0 && (
              <p className="text-muted-foreground text-center py-8">Không có lịch nào khớp.</p>
            )}
            {filtered.map((r) => {
              if (editing === r.rowIndex) {
                return (
                  <ScheduleForm
                    key={r.rowIndex}
                    initial={draftFor(r)}
                    drivers={drivers}
                    locations={locations}
                    sourceRows={rows}
                    onSaved={onSaved}
                    onCancel={() => setEditing(null)}
                  />
                );
              }
              const sendTime = minusMinutes(r.delivery_window, r.sent_to_driver_before);
              const days = activeDays(r.days);
              return (
                <div key={r.rowIndex} className="rounded border bg-white p-2 space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 font-semibold text-slate-800 break-words">
                      {labelFor(r.pickup_name, r.pickup_id)} <span className="text-slate-400">→</span> {labelFor(r.dropoff_name, r.dropoff_id)}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="rounded bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 font-mono font-semibold text-indigo-700">
                        {r.delivery_window}
                      </span>
                      <button
                        type="button"
                        disabled={editing !== null || loadingLocations}
                        onClick={() => void openForm(r.rowIndex)}
                        className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 hover:bg-slate-100 disabled:opacity-40"
                      >
                        Sửa
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                    <span>{days.length ? days.map((i) => DAY_FULL[i]).join(" · ") : "—"}</span>
                    <span>
                      <span className="font-semibold text-slate-400">Gửi:</span>{" "}
                      {sendTime} <span className="text-slate-400">(trước {r.sent_to_driver_before}′)</span>
                    </span>
                    <span>
                      <span className="font-semibold text-slate-400">Tài xế:</span>{" "}
                      {r.driver_id ? (
                        <span className="font-semibold text-emerald-700">{driverLabel(r)}</span>
                      ) : (
                        <span className="text-slate-400">tự động</span>
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
