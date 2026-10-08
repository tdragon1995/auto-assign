"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FilterMultiSelect } from "./filter-multi-select";
import { isInactiveLocation } from "@/lib/location-status";
import { haversineKm } from "@/lib/distance";
import { staffCode } from "@/lib/display-names";

type Kind = "client" | "driver";
const clientFields = ["customer_name", "address_line_1", "address_line_2", "contact_number", "email", "postal_code", "client_reference", "latitude", "longitude", "default_dropoff_id", "eta_minutes", "is_active"];
const driverFields = ["first_name", "last_name", "email", "phone_code", "phone_number", "shift_time_start", "shift_time_end", "start_location_customer_id", "end_location_customer_id", "driver_zalo_id", "phone_number_update", "employee_full_name"];
const shiftFields = new Set(["shift_time_start", "shift_time_end"]);

export function profilePatch(kind: Kind, initial: Record<string, unknown>, draft: Record<string, string>, keepGps: boolean) {
  const patch: Record<string, unknown> = {};
  if(kind==="client" && !keepGps) {
    const lat=Number(draft.latitude),lon=Number(draft.longitude);
    if(!draft.latitude?.trim()||!draft.longitude?.trim()||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)throw new Error("Nhập vĩ độ từ −90 đến 90 và kinh độ từ −180 đến 180");
  }
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

export function gpsDeltaKm(initial: Record<string, unknown>, draft: Record<string, string>): number | null {
  const coords = [initial.latitude, initial.longitude, draft.latitude, draft.longitude];
  if (coords.some(value => value == null || String(value).trim() === "")) return null;
  const [lat, lon, nextLat, nextLon] = coords.map(Number);
  if (![lat, lon, nextLat, nextLon].every(Number.isFinite) || Math.abs(lat)>90 || Math.abs(nextLat)>90 || Math.abs(lon)>180 || Math.abs(nextLon)>180) return null;
  return haversineKm(lat, lon, nextLat, nextLon);
}

export function MasterProfileEditor({ kind, id, initial, clients, linkedLabcenter, onCancel, onSaved, gpsOnly=false, creating=false }: {
  kind: Kind; id: string; gpsOnly?:boolean; creating?:boolean; initial: Record<string, unknown>;
  clients: { customer_id: string; cartrack: Record<string, unknown>; labcenter_location_id: number | null }[];
  linkedLabcenter?: boolean; onCancel: () => void; onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => Object.fromEntries((kind === "client" ? clientFields : driverFields)
    .map(key => [key, key === "is_active" ? String(!isInactiveLocation(initial.customer_name)) : shiftFields.has(key) ? String(initial[key] ?? "").slice(0, 5) : String(initial[key] ?? "")])));
  const [keepGps, setKeepGps] = useState(!gpsOnly);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [requestId]=useState(()=>crypto.randomUUID());
  const gpsDistance = kind === "client" && !keepGps ? gpsDeltaKm(initial, draft) : null;
  const fieldClass = "w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:bg-slate-100";
  const set = (key: string, value: string) => setDraft(d => ({ ...d, [key]: value }));
  const input = (key: string, label: string, type = "text") => <label key={key} className="block min-w-0 space-y-1">
    <span className="text-xs font-medium text-slate-700">{label}</span>
    <input className={fieldClass} type={type} step={type === "number" ? "any" : undefined} required={creating && ["first_name","last_name","phone_code","phone_number"].includes(key)} autoFocus={gpsOnly && key==="latitude"} value={draft[key]} onChange={e => set(key, e.target.value)} />
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
      const patch = profilePatch(kind, creating?{}:initial, gpsOnly ? {latitude:draft.latitude,longitude:draft.longitude} : draft, keepGps);
      if(creating) {
        const res=await fetch("/api/drivers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({request_id:requestId,profile:patch})});
        const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (!creating && Object.keys(patch).length) {
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
      {kind === "client" && <section className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3" aria-label="Toạ độ GPS">
        <div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold text-slate-800">Toạ độ GPS</span>
          {!gpsOnly && <button type="button" aria-pressed={!keepGps} onClick={()=>setKeepGps(v=>!v)} className="rounded px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">{keepGps ? "Đổi GPS" : "Giữ GPS hiện tại"}</button>}</div>
        <fieldset disabled={keepGps} className="grid grid-cols-2 gap-3">{input("latitude","Vĩ độ","number")}{input("longitude","Kinh độ","number")}</fieldset>
        {!keepGps && <div className="space-y-1 text-xs leading-5 text-slate-700">
          {gpsDeltaKm(initial,{latitude:String(initial.latitude??""),longitude:String(initial.longitude??"")}) !== null && <p>GPS hiện tại: <span className="tabular-nums">{String(initial.latitude)}, {String(initial.longitude)}</span></p>}
          <p aria-live="polite">{gpsDistance === null ? "Nhập đủ GPS hợp lệ để tính khoảng cách." : <>Khoảng cách đường thẳng (Haversine): <strong className="tabular-nums text-slate-900">{gpsDistance < 1 ? `${Math.round(gpsDistance*1000).toLocaleString("vi-VN")} m` : `${gpsDistance.toLocaleString("vi-VN",{maximumFractionDigits:2})} km`}</strong></>}</p>
        </div>}
        <p className="text-[11px] leading-4 text-slate-600">{keepGps ? "Sửa địa chỉ sẽ giữ nguyên GPS." : "Đồng bộ GPS tới Cartrack, Supabase và Labcenter nếu đã liên kết; tính lại phường và PSC gần nhất."}</p>
      </section>}
      {gpsOnly ? null : kind === "client" ? <>
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

        <div className="space-y-3">{location("default_dropoff_id", "Điểm giao mặc định")}{input("eta_minutes", "ETA (phút)", "number")}</div>
        {linkedLabcenter && draft.default_dropoff_id && !clients.some(c => c.customer_id === draft.default_dropoff_id && c.labcenter_location_id) && <p className="text-xs text-slate-600">Điểm giao hiện tại chưa liên kết Labcenter; cần liên kết trước khi đồng bộ ETA.</p>}
        {!linkedLabcenter && <p className="text-xs text-slate-600">Chưa liên kết Labcenter: điểm giao mặc định và ETA chỉ lưu ở Supabase.</p>}
      </> : <>
        <div className="grid grid-cols-2 gap-3">{input("first_name", "Họ / mã")}{input("last_name", "Tên")}{input("email", "Email")}{input("phone_code", "Mã vùng")}{input("phone_number", "Điện thoại")}{input("phone_number_update", "Điện thoại thay thế")}{input("shift_time_start", "Bắt đầu ca (giờ VN)", "time")}{input("shift_time_end", "Kết thúc ca (giờ VN)", "time")}</div>
        {location("start_location_customer_id", "Điểm xuất phát")}{location("end_location_customer_id", "Điểm kết thúc")}
        <div className="grid grid-cols-2 gap-3">{input("driver_zalo_id", "Zalo ID")}<label className="block min-w-0 space-y-1"><span className="text-xs font-medium text-slate-700">Mã nhân viên</span><input className={fieldClass} readOnly value={staffCode(draft.first_name) || String(initial.employee_code ?? "")} /><span className="block text-[11px] text-slate-500">Lấy từ Họ / mã; tài xế vẫn được phân biệt bằng ID.</span></label>{input("employee_full_name", "Tên nhân viên MISA")}</div>
      </>}
      {error && <p role="alert" className="whitespace-pre-line text-xs text-red-700">{error}</p>}
      <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="outline" onClick={onCancel}>Huỷ</Button><Button type="submit" size="sm">{saving ? "Đang lưu…" : creating ? "Tạo tài xế" : gpsOnly ? "Lưu GPS" : "Lưu và đồng bộ"}</Button></div>
    </fieldset>
  </form>;
}

export function DriverCreateDialog({clients,onClose,onSaved}:{
  clients:Parameters<typeof MasterProfileEditor>[0]["clients"];onClose:()=>void;onSaved:()=>Promise<void>;
}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const dialog=ref.current;dialog?.showModal();return ()=>dialog?.close();},[]);
  return <dialog ref={ref} aria-label="Tạo tài xế" onCancel={event=>{
    event.preventDefault();if(!ref.current?.querySelector<HTMLFieldSetElement>("form > fieldset")?.disabled)onClose();
  }} className="m-auto max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 text-slate-900 shadow-xl backdrop:bg-slate-950/40">
    <h2 className="mb-1 text-base font-semibold">Tạo tài xế</h2>
    <p className="mb-4 text-xs leading-5 text-slate-600">Tạo trên Cartrack và lưu cùng ID vào Supabase. Không cần có hồ sơ MISA.</p>
    <MasterProfileEditor kind="driver" id="new" creating initial={{phone_code:"84"}} clients={clients} onCancel={onClose} onSaved={onSaved}/>
  </dialog>;
}
