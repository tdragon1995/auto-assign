"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FilterMultiSelect } from "./filter-multi-select";
import { isInactiveLocation } from "@/lib/location-status";

type Kind = "client" | "driver";
const clientFields = ["customer_name", "address_line_1", "address_line_2", "contact_number", "email", "postal_code", "client_reference", "latitude", "longitude", "default_dropoff_id", "eta_minutes", "is_active"];
const driverFields = ["first_name", "last_name", "email", "phone_code", "phone_number", "shift_time_start", "shift_time_end", "start_location_customer_id", "end_location_customer_id", "driver_zalo_id", "phone_number_update", "employee_code", "employee_full_name", "code_name"];
const shiftFields = new Set(["shift_time_start", "shift_time_end"]);

export function profilePatch(kind: Kind, initial: Record<string, unknown>, draft: Record<string, string>, keepGps: boolean) {
  const patch: Record<string, unknown> = {};
  for (const key of kind === "client" ? clientFields : driverFields) {
    if (!(key in draft) || (kind === "client" && keepGps && ["latitude", "longitude"].includes(key))) continue;
    const before = key === "is_active" ? String(!isInactiveLocation(initial.customer_name)) : shiftFields.has(key) ? String(initial[key] ?? "").slice(0, 5) : String(initial[key] ?? "");
    if (before === draft[key]) continue;
    if (key === "is_active") {
      if (!["true","false"].includes(draft[key])) throw new Error("Trạng thái không hợp lệ");
      patch[key] = draft[key] === "true";
    } else if (["latitude", "longitude", "eta_minutes"].includes(key)) {
      if (!draft[key].trim() || !Number.isFinite(Number(draft[key]))) throw new Error("GPS hoặc ETA không hợp lệ");
      patch[key] = Number(draft[key]);
    } else if (shiftFields.has(key)) patch[key] = draft[key] ? `${draft[key]}:00+07:00` : null;
    else if (kind === "driver" && key.endsWith("_customer_id")) patch[key] = draft[key] || null;
    else patch[key] = draft[key];
  }
  return patch;
}

export function MasterProfileEditor({ kind, id, initial, clients, linkedLabcenter, onCancel, onSaved }: {
  kind: Kind; id: string; initial: Record<string, unknown>;
  clients: { customer_id: string; cartrack: Record<string, unknown>; labcenter_location_id: number | null }[];
  linkedLabcenter?: boolean; onCancel: () => void; onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => Object.fromEntries((kind === "client" ? clientFields : driverFields)
    .map(key => [key, key === "is_active" ? String(!isInactiveLocation(initial.customer_name)) : shiftFields.has(key) ? String(initial[key] ?? "").slice(0, 5) : String(initial[key] ?? "")])));
  const [keepGps, setKeepGps] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fieldClass = "w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:bg-slate-100";
  const set = (key: string, value: string) => setDraft(d => ({ ...d, [key]: value }));
  const input = (key: string, label: string, type = "text") => <label key={key} className="block min-w-0 space-y-1">
    <span className="text-xs font-medium text-slate-700">{label}</span>
    <input className={fieldClass} type={type} step={type === "number" ? "any" : undefined} value={draft[key]} onChange={e => set(key, e.target.value)} />
  </label>;
  const location = (key: string, label: string) => <div className="block min-w-0 space-y-1">
    <span className="text-xs font-medium text-slate-700">{label}</span>
    <FilterMultiSelect label={label} multiple={false} portal={false} disabled={saving}
      allowClear={kind === "driver" || !linkedLabcenter} values={draft[key] ? [draft[key]] : []}
      options={[
        ...(draft[key] && !clients.some(c => c.customer_id === draft[key]) ? [{value:draft[key],label:String(key === "default_dropoff_id" ? initial.default_dropoff_name || draft[key] : draft[key])}] : []),
        ...clients.filter(c => c.customer_id === draft[key] || (!isInactiveLocation(c.cartrack.customer_name) && (kind === "driver" || !linkedLabcenter || c.labcenter_location_id)))
          .map(c => ({value:c.customer_id,label:String(c.cartrack.customer_name ?? c.customer_id)})),
      ]}
      onChange={values => set(key,values[0] ?? "")} placeholder="Tìm tên hoặc mã điểm…" />
  </div>;
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setError("");
    try {
      const patch = profilePatch(kind, initial, draft, keepGps);
      if (Object.keys(patch).length) {
        const res = await fetch("/api/master-client-info", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, id, patch }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      }
      await onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  return <form onSubmit={save} className="space-y-3">
    <fieldset disabled={saving} className="space-y-3">
      {kind === "client" ? <>
        {input("customer_name", "Tên khách hàng")}
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <span id={`location-status-${id}`} className="text-xs font-semibold text-slate-800">{draft.is_active === "true" ? "Địa điểm đang hoạt động" : "Địa điểm ngừng hoạt động"}</span>
            <button type="button" role="switch" aria-checked={draft.is_active === "true"} aria-label="Trạng thái địa điểm" aria-describedby={`location-status-${id}`}
              onClick={() => set("is_active", draft.is_active === "true" ? "false" : "true")}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 ${draft.is_active === "true" ? "bg-emerald-600" : "bg-slate-400"}`}>
              <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${draft.is_active === "true" ? "left-0.5 translate-x-5" : "left-0.5"}`} />
            </button>
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-600">Ngừng hoạt động: chặn gửi yêu cầu ở Diag Portal và thêm {"{inactive}"} vào tên trên Cartrack.</p>
        </div>
        {input("address_line_1", "Địa chỉ")}{input("address_line_2", "Địa chỉ bổ sung")}
        <div className="grid grid-cols-2 gap-3">{input("contact_number", "Điện thoại")}{input("email", "Email")}{input("postal_code", "Mã bưu chính")}{input("client_reference", "Mã tham chiếu")}</div>
        <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={keepGps} onChange={e => setKeepGps(e.target.checked)} className="accent-indigo-600" />Giữ nguyên GPS khi sửa địa chỉ</label>
        {!keepGps && <div className="grid grid-cols-2 gap-3">{input("latitude", "Vĩ độ", "number")}{input("longitude", "Kinh độ", "number")}</div>}
        <div className="space-y-3">{location("default_dropoff_id", "Điểm giao mặc định")}{input("eta_minutes", "ETA (phút)", "number")}</div>
        {linkedLabcenter && draft.default_dropoff_id && !clients.some(c => c.customer_id === draft.default_dropoff_id && c.labcenter_location_id) && <p className="text-xs text-slate-600">Điểm giao hiện tại chưa liên kết Labcenter; cần liên kết trước khi đồng bộ ETA.</p>}
        {!linkedLabcenter && <p className="text-xs text-slate-600">Chưa liên kết Labcenter: điểm giao mặc định và ETA chỉ lưu ở Supabase.</p>}
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
