"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

type Kind = "client" | "driver";
type DropoffRule = { rule_id: number; revision: number; start: string; end: string; dropoff: string; alt_drop_off_id?: string };
const clientFields = ["customer_name", "address_line_1", "address_line_2", "contact_number", "email", "postal_code", "client_reference", "latitude", "longitude", "default_dropoff_id", "eta_minutes"];
const driverFields = ["first_name", "last_name", "email", "phone_code", "phone_number", "shift_time_start", "shift_time_end", "start_location_customer_id", "end_location_customer_id", "driver_zalo_id", "phone_number_update", "employee_code", "employee_full_name", "code_name"];
const shiftFields = new Set(["shift_time_start", "shift_time_end"]);

export function profilePatch(kind: Kind, initial: Record<string, unknown>, draft: Record<string, string>, keepGps: boolean) {
  const patch: Record<string, unknown> = {};
  for (const key of kind === "client" ? clientFields : driverFields) {
    if (!(key in draft) || (kind === "client" && keepGps && ["latitude", "longitude"].includes(key))) continue;
    const before = shiftFields.has(key) ? String(initial[key] ?? "").slice(0, 5) : String(initial[key] ?? "");
    if (before === draft[key]) continue;
    if (["latitude", "longitude", "eta_minutes"].includes(key)) {
      if (!draft[key].trim() || !Number.isFinite(Number(draft[key]))) throw new Error("GPS hoặc ETA không hợp lệ");
      patch[key] = Number(draft[key]);
    } else if (shiftFields.has(key)) patch[key] = draft[key] ? `${draft[key]}:00+07:00` : null;
    else if (kind === "driver" && key.endsWith("_customer_id")) patch[key] = draft[key] || null;
    else patch[key] = draft[key];
  }
  return patch;
}

export function MasterProfileEditor({ kind, id, initial, clients, rules = [], linkedLabcenter, onCancel, onSaved }: {
  kind: Kind; id: string; initial: Record<string, unknown>;
  clients: { customer_id: string; cartrack: Record<string, unknown>; labcenter_location_id: number | null }[];
  rules?: DropoffRule[];
  linkedLabcenter?: boolean; onCancel: () => void; onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => Object.fromEntries((kind === "client" ? clientFields : driverFields)
    .map(key => [key, shiftFields.has(key) ? String(initial[key] ?? "").slice(0, 5) : String(initial[key] ?? "")])));
  const [keepGps, setKeepGps] = useState(true);
  const [alternatives, setAlternatives] = useState(() => Object.fromEntries(rules.map(r => [r.rule_id, r.alt_drop_off_id ?? ""])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fieldClass = "w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:bg-slate-100";
  const set = (key: string, value: string) => setDraft(d => ({ ...d, [key]: value }));
  const input = (key: string, label: string, type = "text") => <label key={key} className="block min-w-0 space-y-1">
    <span className="text-xs font-medium text-slate-700">{label}</span>
    <input className={fieldClass} type={type} step={type === "number" ? "any" : undefined} value={draft[key]} onChange={e => set(key, e.target.value)} />
  </label>;
  const location = (key: string, label: string) => <label className="block min-w-0 space-y-1">
    <span className="text-xs font-medium text-slate-700">{label}</span>
    <select className={fieldClass} value={draft[key]} onChange={e => set(key, e.target.value)}>
      <option value="" disabled={kind === "client" && linkedLabcenter}>—</option>
      {clients.filter(c => kind === "driver" || !linkedLabcenter || c.labcenter_location_id).map(c => <option key={c.customer_id} value={c.customer_id}>{String(c.cartrack.customer_name ?? c.customer_id)}</option>)}
    </select>
  </label>;
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setError("");
    let profileSaved = false;
    try {
      const patch = profilePatch(kind, initial, draft, keepGps);
      if (Object.keys(patch).length) {
        const res = await fetch("/api/master-client-info", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, id, patch }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        profileSaved = true;
      }
      const rows = rules.filter(r => alternatives[r.rule_id] !== (r.alt_drop_off_id ?? "")).map(r => ({ rule_id: r.rule_id, revision: r.revision, alt_drop_off_id: alternatives[r.rule_id] }));
      if (rows.length) {
        const res = await fetch("/api/master-client-info", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "alternate_dropoffs", id, rows }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      }
      await onSaved();
    } catch (e) { setError(`${profileSaved ? "Đã lưu hồ sơ; điểm giao thay thế chưa lưu: " : ""}${e instanceof Error ? e.message : String(e)}`); }
    finally { setSaving(false); }
  };
  return <form onSubmit={save} className="space-y-3">
    <fieldset disabled={saving} className="space-y-3">
      {kind === "client" ? <>
        {input("customer_name", "Tên khách hàng")}
        {input("address_line_1", "Địa chỉ")}{input("address_line_2", "Địa chỉ bổ sung")}
        <div className="grid grid-cols-2 gap-3">{input("contact_number", "Điện thoại")}{input("email", "Email")}{input("postal_code", "Mã bưu chính")}{input("client_reference", "Mã tham chiếu")}</div>
        <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={keepGps} onChange={e => setKeepGps(e.target.checked)} className="accent-indigo-600" />Giữ nguyên GPS khi sửa địa chỉ</label>
        {!keepGps && <div className="grid grid-cols-2 gap-3">{input("latitude", "Vĩ độ", "number")}{input("longitude", "Kinh độ", "number")}</div>}
        <div className="space-y-3">{location("default_dropoff_id", "Điểm giao mặc định")}{input("eta_minutes", "ETA (phút)", "number")}</div>
        {!linkedLabcenter && <p className="text-xs text-slate-600">Chưa liên kết Labcenter: điểm giao mặc định và ETA chỉ lưu ở Supabase.</p>}
        {rules.length > 0 && <div className="space-y-3 border-t border-slate-200 pt-3">
          <h4 className="text-xs font-semibold text-slate-900">Điểm giao thay thế theo ca</h4>
          <p className="text-xs text-slate-600">Chuyển điểm giao của job khi ca này được áp dụng.</p>
          {rules.map(r => <label key={r.rule_id} className="block min-w-0 space-y-1">
            <span className="text-xs font-medium text-slate-700">{r.start && r.end ? `${r.start}–${r.end}` : "Cả ngày"} · {r.dropoff || "mọi điểm giao"}</span>
            <select className={fieldClass} value={alternatives[r.rule_id]} onChange={e => setAlternatives(a => ({ ...a, [r.rule_id]: e.target.value }))}>
              <option value="">Giữ điểm giao của job</option>
              {clients.map(c => <option key={c.customer_id} value={c.customer_id}>{String(c.cartrack.customer_name ?? c.customer_id)}</option>)}
            </select>
          </label>)}
        </div>}
      </> : <>
        <div className="grid grid-cols-2 gap-3">{input("first_name", "Họ / mã")}{input("last_name", "Tên")}{input("email", "Email")}{input("phone_code", "Mã vùng")}{input("phone_number", "Điện thoại")}{input("phone_number_update", "Điện thoại thay thế")}{input("shift_time_start", "Bắt đầu ca (giờ VN)", "time")}{input("shift_time_end", "Kết thúc ca (giờ VN)", "time")}</div>
        {location("start_location_customer_id", "Điểm xuất phát")}{location("end_location_customer_id", "Điểm kết thúc")}
        <div className="grid grid-cols-2 gap-3">{input("driver_zalo_id", "Zalo ID")}{input("employee_code", "Mã nhân viên")}{input("employee_full_name", "Tên nhân viên MISA")}{input("code_name", "Mã / tên nội bộ")}</div>
      </>}
      {error && <p role="alert" className="whitespace-pre-line text-xs text-red-700">{error}</p>}
      <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="outline" onClick={onCancel}>Huỷ</Button><Button type="submit" size="sm">{saving ? "Đang lưu…" : "Lưu và đồng bộ"}</Button></div>
    </fieldset>
  </form>;
}
