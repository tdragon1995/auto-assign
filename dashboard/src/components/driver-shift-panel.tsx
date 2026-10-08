"use client";
import { useCallback,useEffect,useMemo,useRef,useState } from "react";
import { ChevronLeft,ChevronRight,Pencil,Plus,RefreshCw,Search,X } from "lucide-react";
import { Button } from "./ui/button";
import { DriverName } from "./driver-name";
import { foldName } from "@/lib/driver-cell";
import { employmentOf } from "@/lib/driver-label";
import { addDays,cartrackHistoryCutoff,vnDate } from "@/lib/time";
import type { DriverShift,ShiftPattern,ShiftDriver,RuleShiftSuggestion } from "@/lib/driver-shifts";
import { toast } from "sonner";
import { BulkPtShiftPanel } from "./bulk-pt-shift-panel";
const field="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-600 placeholder:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60";
const weekdays=["CN","T2","T3","T4","T5","T6","T7"];
const kindLabel={working:"Làm việc",off:"Nghỉ",holiday:"Nghỉ lễ"};
export function DriverShiftPanel(){
 const [mode,setMode]=useState<"daily"|"patterns"|"bulk">("daily"),[date,setDate]=useState(vnDate),[cutoff,setCutoff]=useState(cartrackHistoryCutoff);
 const [configuredIds,setConfiguredIds]=useState<string[]>([]);
 const [shifts,setShifts]=useState<DriverShift[]>([]),[suggestions,setSuggestions]=useState<Record<string,RuleShiftSuggestion[]>>({});
 const [rows,setRows]=useState<(DriverShift|ShiftPattern)[]>([]),[drivers,setDrivers]=useState<ShiftDriver[]>([]);
 const [search,setSearch]=useState(""),[loading,setLoading]=useState(true),[error,setError]=useState(""),[saving,setSaving]=useState(false);
 const [editing,setEditing]=useState<DriverShift|ShiftPattern|null>(null),[isNew,setIsNew]=useState(false);
 const sequence=useRef(0);
 const load=useCallback(async(quiet=false)=>{const current=++sequence.current;if(!quiet)setLoading(true);setError("");try{
  const res=await fetch(`/api/driver-shifts?mode=${mode==="bulk"?"missing":mode}&date=${date}`,{cache:"no-store"}),data=await res.json();
  if(!res.ok)throw Error(data.error||"Không tải được lịch ca");if(current!==sequence.current)return;setRows(data.rows);setDrivers(data.drivers);setConfiguredIds(data.configuredDriverIds??[]);setShifts(data.shifts??[]);setSuggestions(data.suggestions??{});setCutoff(data.cutoff);
 }catch(e){if(current===sequence.current)setError(e instanceof Error?e.message:String(e));}finally{if(current===sequence.current)setLoading(false);}},[mode,date]);
 useEffect(()=>{void load();setEditing(null);},[load]);
 const directory=useMemo(()=>new Map(drivers.map(d=>[d.driver_id,d])),[drivers]);
 const name=(r:DriverShift|ShiftPattern)=>directory.get(r.driver_id??"")?.name||("full_name" in r?r.full_name:r.label);
 const filtered=rows.filter(r=>foldName(`${name(r)} ${r.employee_code}`).includes(foldName(search)));
 const startNew=()=>{setIsNew(true);setEditing(mode==="daily"?{employee_code:"",full_name:"",driver_id:null,shift_date:date,slot:1,day_type:"working",start_time:"07:00",end_time:"17:00",holiday_name:null,leave_start:null,leave_end:null,leave_gap:false,source:"manual",revision:0,synced_at:""}:{id:0,employee_code:"",label:"",driver_id:null,days:Array(7).fill(null),active_from:date,active_to:null,active:true,note:"",revision:0,review_issues:[]});};
 const choose=(id:string)=>{const driver=directory.get(id);if(!driver||!editing)return;setEditing({...editing,driver_id:id,employee_code:!isNew&&"day_type" in editing?editing.employee_code:driver.employee_code,...("full_name" in editing?{full_name:driver.name}:{label:driver.name})});};
 const save=async()=>{if(!editing)return;setSaving(true);try{
  const data={...editing,...(mode==="patterns"&&isNew?{id:undefined}:{})};
  const res=await fetch("/api/driver-shifts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:mode==="patterns"?"patterns":"daily",data})}),result=await res.json();
  if(!res.ok)throw Error(result.error||"Không lưu được lịch ca");setEditing(null);await load();toast.success("Đã lưu lịch ca vào Supabase");
 }catch(e){toast.error(e instanceof Error?e.message:String(e));}finally{setSaving(false);}};
 const syncMonth=async()=>{setSaving(true);try{const res=await fetch(`/api/misa-sync?month=${date.slice(0,7)}`,{method:"POST"}),data=await res.json();if(!res.ok)throw Error(data.error||"Không bắt đầu được đồng bộ");if(data.status==="disabled")throw Error("Chưa kết nối đồng bộ MISA");toast.info(data.status==="dispatched"?"Đã yêu cầu MISA tải tháng này. Bấm Tải lại khi đồng bộ hoàn tất.":"MISA đang chạy hoặc vừa đồng bộ. Vui lòng tải lại sau.");}catch(e){toast.error(e instanceof Error?e.message:String(e));}finally{setSaving(false);}};
 return <section className="flex h-full min-h-0 flex-col rounded-xl border border-slate-200 bg-white text-slate-900">
  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-3">
   <div className="flex gap-1 rounded-lg bg-slate-100 p-1" aria-label="Chế độ lịch ca">
    <Button size="sm" variant={mode==="daily"?"default":"ghost"} aria-pressed={mode==="daily"} disabled={saving} onClick={()=>setMode("daily")}>Theo ngày</Button>
    <Button size="sm" variant={mode==="patterns"?"default":"ghost"} aria-pressed={mode==="patterns"} disabled={saving} onClick={()=>setMode("patterns")}>Mẫu ca PT</Button>
    <Button size="sm" variant={mode==="bulk"?"default":"ghost"} aria-pressed={mode==="bulk"} disabled={saving} onClick={()=>setMode("bulk")}>Thiếu ca PT</Button>
   </div>
   <div className="flex flex-wrap items-center gap-2">
    {mode==="daily"&&<><Button variant="outline" size="icon" aria-label="Ngày trước" disabled={date<=cutoff||saving} onClick={()=>setDate(addDays(date,-1))}><ChevronLeft/></Button>
     <label className="sr-only" htmlFor="shift-date">Ngày xem lịch ca</label><input id="shift-date" type="date" value={date} min={cutoff} disabled={saving} className={field} onChange={e=>{if(e.target.value>=cutoff)setDate(e.target.value);}}/>
     <Button variant="outline" size="icon" aria-label="Ngày sau" disabled={saving} onClick={()=>setDate(addDays(date,1))}><ChevronRight/></Button>
     <Button variant="ghost" size="sm" disabled={saving} onClick={()=>setDate(vnDate())}>Hôm nay</Button></>}
    {mode!=="daily"&&<Button variant="outline" disabled={loading||saving} onClick={()=>void syncMonth()}>Đồng bộ MISA</Button>}
    <Button variant="outline" disabled={loading||saving} onClick={()=>void load()}><RefreshCw className="size-4"/>Tải lại</Button>
    {mode!=="bulk"&&<Button disabled={loading||saving} onClick={startNew}><Plus className="size-4"/>{mode==="daily"?"Thêm ca":"Thêm mẫu ca"}</Button>}
   </div>
  </div>
  {mode==="bulk"?<>{error?<p role="alert" className="p-4 text-sm text-red-700">{error} · Bấm Tải lại để thử lại.</p>:<BulkPtShiftPanel drivers={drivers} patterns={rows as ShiftPattern[]} shifts={shifts} suggestions={suggestions} configuredIds={configuredIds} date={date} cutoff={cutoff} onDateChange={setDate} loading={loading} onSaved={()=>load(true)} onBusy={setSaving}/>}</>:<>
  <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
   <label className="relative w-full sm:max-w-sm"><span className="sr-only">Tìm tài xế trong lịch ca</span><Search className="absolute left-3 top-3 size-4 text-slate-500"/><input type="search" className={`${field} w-full pl-9`} placeholder="Tìm tài xế hoặc mã nhân viên…" value={search} onChange={e=>setSearch(e.target.value)}/></label>
   <p className="text-xs text-slate-600">Lưu từ {cutoff} · Giờ Việt Nam · Có thể xem ngày tương lai</p>
  </div>
  {editing&&<form className="border-y border-indigo-200 bg-indigo-50/50 p-4" onSubmit={e=>{e.preventDefault();void save();}}>
   <div className="mb-3 flex items-center justify-between gap-3"><h2 className="font-semibold">{isNew?"Thêm":"Sửa"} {mode==="daily"?"ca làm việc":"mẫu ca PT"}</h2><Button type="button" variant="ghost" size="icon" aria-label="Đóng sửa lịch ca" disabled={saving} onClick={()=>setEditing(null)}><X className="size-4"/></Button></div>
   {(isNew||!(editing.driver_id))&&<label className="mb-3 block text-sm font-medium">Tài xế<select required className={`${field} mt-1 w-full sm:max-w-lg`} value={editing.driver_id??""} onChange={e=>choose(e.target.value)} disabled={saving}><option value="">Chọn tài xế…</option>{drivers.filter(d=>d.active&&(mode==="daily"||employmentOf(d.name)==="part-time")).map(d=><option key={d.driver_id} value={d.driver_id}>{d.name}</option>)}</select></label>}
   {!isNew&&editing.driver_id&&<p className="mb-3 text-sm font-medium"><DriverName full={name(editing)}/></p>}
   {"day_type" in editing?<>
    <div className="grid gap-3 sm:grid-cols-3 sm:max-w-2xl">
     <label className="text-sm">Trạng thái<select className={`${field} mt-1 w-full`} value={editing.day_type} disabled={saving} onChange={e=>setEditing({...editing,day_type:e.target.value as DriverShift["day_type"],start_time:e.target.value==="working"?"07:00":null,end_time:e.target.value==="working"?"17:00":null})}>{Object.entries(kindLabel).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
     {editing.day_type==="working"&&<><label className="text-sm">Bắt đầu<input required type="time" className={`${field} mt-1 w-full`} value={editing.start_time??""} disabled={saving} onChange={e=>setEditing({...editing,start_time:e.target.value})}/></label><label className="text-sm">Kết thúc<input required type="time" className={`${field} mt-1 w-full`} value={editing.end_time??""} disabled={saving} onChange={e=>setEditing({...editing,end_time:e.target.value})}/></label></>}
    </div><p className="mt-3 text-xs text-slate-600">Ca sửa tại đây được giữ lại khi MISA đồng bộ. Khung nghỉ phép vẫn lấy từ hồ sơ nghỉ phép.</p>
   </>:<>
    <div className="grid gap-3 sm:grid-cols-3 sm:max-w-2xl"><label className="text-sm">Hiệu lực từ<input type="date" className={`${field} mt-1 w-full`} value={editing.active_from??""} onChange={e=>setEditing({...editing,active_from:e.target.value||null})}/></label><label className="text-sm">Đến ngày<input type="date" className={`${field} mt-1 w-full`} min={editing.active_from??undefined} value={editing.active_to??""} onChange={e=>setEditing({...editing,active_to:e.target.value||null})}/></label><label className="flex items-center gap-2 self-end h-10 text-sm"><input type="checkbox" checked={editing.active} onChange={e=>setEditing({...editing,active:e.target.checked})}/>Đang áp dụng</label></div>
    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[1,2,3,4,5,6,0].map(day=><fieldset key={day} className="min-w-0"><legend className="mb-1 text-xs font-semibold">{weekdays[day]}</legend><div className="flex items-center gap-1"><input aria-label={`${weekdays[day]} bắt đầu`} type="time" className={`${field} min-w-0 w-full px-2`} value={editing.days[day]?.start??""} onChange={e=>{const days=[...editing.days];days[day]=e.target.value?{start:e.target.value,end:days[day]?.end??""}:null;setEditing({...editing,days});}}/><span aria-hidden="true">–</span><input aria-label={`${weekdays[day]} kết thúc`} type="time" className={`${field} min-w-0 w-full px-2`} value={editing.days[day]?.end??""} onChange={e=>{const days=[...editing.days];days[day]=e.target.value?{start:days[day]?.start??"",end:e.target.value}:null;setEditing({...editing,days});}}/></div></fieldset>)}</div>
    <label className="mt-3 block text-sm">Ghi chú<input className={`${field} mt-1 w-full`} value={editing.note} onChange={e=>setEditing({...editing,note:e.target.value})}/></label>
    <p className="mt-2 text-xs text-slate-600">Để trống cả hai giờ nếu nghỉ. Mẫu ca áp dụng trong lần đồng bộ MISA kế tiếp khi chưa có ca MISA. Có thể đặt ngày hiệu lực tương lai.</p>
   </>}
   <div className="mt-4 flex justify-end gap-2"><Button type="button" variant="outline" disabled={saving} onClick={()=>setEditing(null)}>Huỷ</Button><Button type="submit" disabled={saving||!editing.employee_code}>{saving?"Đang lưu…":"Lưu lịch ca"}</Button></div>
  </form>}
  <div className="min-h-0 flex-1 overflow-auto" aria-busy={loading}>
   {error?<p role="alert" className="p-4 text-sm text-red-700">{error} · Bấm Tải lại để thử lại.</p>:loading?<div role="status" className="space-y-3 p-4"><p className="text-sm text-slate-600">Đang tải lịch ca…</p>{[1,2,3].map(n=><div key={n} className="h-10 rounded bg-slate-100 motion-safe:animate-pulse"/>)}</div>:filtered.length===0?<div className="p-6 text-sm"><p className="mb-3 text-slate-600">{search?"Không tìm thấy tài xế phù hợp.":"Chưa có lịch ca cho ngày này. Chưa có dữ liệu không có nghĩa là nghỉ."}</p>{!search&&mode==="daily"&&<Button variant="outline" disabled={saving} onClick={()=>void syncMonth()}>Tải tháng {date.slice(0,7)} từ MISA</Button>}</div>:<table className="w-full text-sm">
    <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs font-medium text-slate-600"><tr><th className="w-12 p-3"><span className="sr-only">Sửa</span></th><th className="p-3">Tài xế</th>{mode==="daily"?<><th className="p-3">Thời gian</th><th className="hidden p-3 sm:table-cell">Nghỉ phép</th><th className="p-3">Nguồn</th></>:<><th className="p-3">Tuần làm việc</th><th className="p-3">Hiệu lực</th><th className="p-3">Trạng thái</th></>}</tr></thead>
    <tbody>{filtered.map(r=><tr key={"id" in r?r.id:`${r.employee_code}|${r.shift_date}|${r.slot}`} className="border-t border-slate-200 align-top hover:bg-slate-50"><td className="p-2"><Button variant="ghost" size="icon" className="text-blue-600" aria-label={`Sửa lịch ca ${name(r)}`} disabled={saving} onClick={()=>{setIsNew(false);setEditing(r);}}><Pencil className="size-4"/></Button></td><td className="p-3"><DriverName full={name(r)}/><p className="mt-1 break-all text-xs text-slate-600">{r.employee_code.startsWith("driver:")?"Liên kết bằng ID tài xế":r.employee_code}</p></td>{"day_type" in r?<><td className="whitespace-nowrap p-3 tabular-nums">{r.day_type==="working"?`${r.start_time} – ${r.end_time}`:r.holiday_name||kindLabel[r.day_type]}{r.slot>1&&<p className="text-xs text-slate-600">Ca {r.slot}</p>}</td><td className="hidden p-3 sm:table-cell">{r.leave_start&&r.leave_end?`${r.leave_start} – ${r.leave_end}`:""}{r.leave_gap&&<p className="text-xs text-amber-800">Cần kiểm tra nghỉ phép</p>}</td><td className="p-3 text-xs text-slate-600">{r.source==="manual"?"Sửa trong app":r.source==="Sheet migration"?"Dữ liệu đã chuyển":r.source}</td></>:<><td className="p-3"><div className="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums">{[1,2,3,4,5,6,0].filter(d=>r.days[d]).map(d=><span key={d}>{weekdays[d]} {r.days[d]!.start}–{r.days[d]!.end}</span>)}{r.days.every(d=>!d)&&<span className="text-slate-600">Chưa nhập giờ làm việc</span>}</div></td><td className="whitespace-nowrap p-3 text-xs">{r.active_from||"Không giới hạn"}{r.active_to&&` → ${r.active_to}`}</td><td className="p-3 text-xs">{r.review_issues.length?<span className="text-amber-800">Cần liên kết tài xế</span>:r.active?"Đang áp dụng":"Tạm ngừng"}</td></>}</tr>)}</tbody>
   </table>}
  </div><p className="border-t border-slate-200 px-3 py-2 text-xs text-slate-600">{loading?"Đang đọc Supabase":`${filtered.length} ${mode==="daily"?"ca":"mẫu ca"} · Supabase`}</p></>}
 </section>;
}
