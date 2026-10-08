"use client";
import { useState } from "react";
import { Button } from "./ui/button";
import { DriverName } from "./driver-name";
import { employmentOf } from "@/lib/driver-label";
import { foldName } from "@/lib/driver-cell";
import { vnDate } from "@/lib/time";
import type { ShiftDriver, ShiftPattern } from "@/lib/driver-shifts";

export function missingPtCycles(drivers:ShiftDriver[],patterns:ShiftPattern[],configuredIds:string[],date:string) {
 const configured=new Set(configuredIds);
 // Match UUIDs; shared PTBU payroll labels must never merge separate accounts.
 const covered=new Set(patterns.filter(p=>p.active&&!p.review_issues.length&&p.days.some(Boolean)&&
  (!p.active_from||p.active_from<=date)&&(!p.active_to||p.active_to>=date)).map(p=>p.driver_id));
 return drivers.filter(d=>d.active&&configured.has(d.driver_id)&&employmentOf(d.name)==="part-time"&&!covered.has(d.driver_id));
}

const weekdays=["CN","T2","T3","T4","T5","T6","T7"];
const field="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-indigo-600";
export function BulkPtShiftPanel({drivers,patterns,configuredIds,onSaved,onBusy}:{drivers:ShiftDriver[];patterns:ShiftPattern[];configuredIds:string[];onSaved:()=>Promise<void>;onBusy:(busy:boolean)=>void}) {
 const [date,setDate]=useState(vnDate),[days,setDays]=useState([1,2,3,4,5,6]),[start,setStart]=useState(""),[end,setEnd]=useState("");
 const [selected,setSelected]=useState<Set<string>>(new Set()),[search,setSearch]=useState(""),[saving,setSaving]=useState(false),[result,setResult]=useState("");
 const missing=missingPtCycles(drivers,patterns,configuredIds,date),shown=missing.filter(d=>foldName(`${d.name} ${d.employee_code}`).includes(foldName(search)));
 const targets=missing.filter(d=>selected.has(d.driver_id));
 const save=async()=>{
  if(!targets.length||!date||!days.length||!start||!end||start===end)return;
  setSaving(true);onBusy(true);setResult("");const saved:string[]=[],failed:string[]=[];
  try {
   // Reuse the validated pattern writer. Keep successful rows on partial failure.
   for(const driver of targets){try{
    const data={employee_code:driver.employee_code,label:driver.name,driver_id:driver.driver_id,
     days:Array.from({length:7},(_,day)=>days.includes(day)?{start,end}:null),active_from:date,active_to:null,active:true,note:"",revision:0,review_issues:[]};
    const res=await fetch("/api/driver-shifts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"patterns",data})});
    const body=await res.json();if(!res.ok||!body.ok)throw Error(body.error||"Không lưu được");saved.push(driver.driver_id);
   }catch(e){failed.push(`${driver.name}: ${e instanceof Error?e.message:String(e)}`);}setResult(`Đã xử lý ${saved.length+failed.length}/${targets.length} tài xế…`);}
   setSelected(current=>new Set([...current].filter(id=>!saved.includes(id))));
   setResult(`Đã lưu ${saved.length}/${targets.length} chu kỳ.${failed.length?`\n${failed.join("\n")}`:""}`);
   await onSaved();
  }catch(e){setResult(`Đã lưu ${saved.length} chu kỳ. Không tải lại được: ${e instanceof Error?e.message:String(e)}`);}
  finally{setSaving(false);onBusy(false);}
 };
 return <form className="flex min-h-0 flex-1 flex-col" onSubmit={e=>{e.preventDefault();void save();}}>
  <fieldset disabled={saving} className="space-y-3 border-b border-slate-200 p-4">
   <h2 className="font-semibold">Thiếu chu kỳ tuần · PT có config</h2>
   <p className="text-sm text-slate-600">Chỉ tài xế PT đang hoạt động, có config và chưa có chu kỳ áp dụng từ ngày đã chọn. Chọn nhiều tài xế để dùng cùng lịch tuần.</p>
   <div className="grid gap-3 sm:grid-cols-3">
    <label className="text-sm">Áp dụng từ ngày<input required type="date" className={`${field} mt-1`} value={date} onChange={e=>{setDate(e.target.value);setSelected(new Set());setResult("");}}/></label>
    <label className="text-sm">Bắt đầu (giờ VN)<input required type="time" className={`${field} mt-1`} value={start} onChange={e=>setStart(e.target.value)}/></label>
    <label className="text-sm">Kết thúc (giờ VN)<input required type="time" className={`${field} mt-1`} value={end} onChange={e=>setEnd(e.target.value)}/></label>
   </div>
   <div className="flex flex-wrap gap-4" role="group" aria-label="Ngày làm trong tuần">{[1,2,3,4,5,6,0].map(day=><label key={day} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={days.includes(day)} onChange={e=>setDays(current=>e.target.checked?[...current,day]:current.filter(d=>d!==day))}/>{weekdays[day]}</label>)}</div>
   <p className="text-xs text-slate-600">Lặp lại hàng tuần từ ngày áp dụng. Ngày không chọn là nghỉ. Chu kỳ được đưa vào lịch ngày trong lần đồng bộ MISA kế tiếp khi chưa có ca MISA; ca sửa thủ công được giữ lại.</p>
  </fieldset>
  <div className="flex flex-wrap items-center gap-3 p-3"><label className="min-w-0 flex-1"><span className="sr-only">Tìm PT thiếu chu kỳ</span><input type="search" className={field} placeholder="Tìm tài xế…" value={search} disabled={saving} onChange={e=>setSearch(e.target.value)}/></label>
   <Button type="button" variant="outline" disabled={saving||!shown.length} onClick={()=>setSelected(current=>new Set([...current,...shown.map(d=>d.driver_id)]))}>Chọn tất cả ({shown.length})</Button>
   <Button type="button" variant="ghost" disabled={saving} onClick={()=>setSelected(new Set())}>Bỏ chọn</Button>
  </div>
  <div className="min-h-0 flex-1 overflow-auto px-3">{shown.length?shown.map(driver=><label key={driver.driver_id} className="flex cursor-pointer items-center gap-3 border-b border-slate-100 py-3 text-sm hover:bg-slate-50"><input type="checkbox" checked={selected.has(driver.driver_id)} disabled={saving} onChange={e=>setSelected(current=>{const next=new Set(current);if(e.target.checked)next.add(driver.driver_id);else next.delete(driver.driver_id);return next;})}/><DriverName full={driver.name}/></label>):<p className="p-3 text-sm text-slate-600">{search?"Không tìm thấy tài xế phù hợp.":"Không còn PT có config thiếu chu kỳ cho ngày này."}</p>}</div>
  <div className="space-y-2 border-t border-slate-200 p-3">{result&&<p role="status" className="whitespace-pre-line text-sm">{result}</p>}
   <div className="flex items-center justify-between gap-3"><span className="text-sm text-slate-600">{targets.length} tài xế đã chọn</span><Button type="submit" disabled={saving||!targets.length||!date||!days.length||!start||!end||start===end}>{saving?"Đang lưu…":`Lưu chu kỳ cho ${targets.length} PT`}</Button></div>
  </div>
 </form>;
}
