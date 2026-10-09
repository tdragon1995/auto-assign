"use client";
import { useState } from "react";
import { Button } from "./ui/button";
import { DriverName } from "./driver-name";
import { employmentOf } from "@/lib/driver-label";
import { foldName } from "@/lib/driver-cell";
import type { DriverShift, ShiftDriver, ShiftPattern, RuleShiftSuggestion } from "@/lib/driver-shifts";

export function missingPtShifts(drivers:ShiftDriver[],shifts:DriverShift[],configuredIds:string[],date:string) {
 const configured=new Set(configuredIds);
 const codeCounts=new Map<string,number>();
 for(const driver of drivers)codeCounts.set(driver.employee_code,(codeCounts.get(driver.employee_code)??0)+1);
 // "CHƯA CÓ CA" is MISA's placeholder for someone with no shift and no pattern —
 // exactly who this panel exists for, so it never counts as covering the day.
 const dated=shifts.filter(s=>s.shift_date===date&&s.source!=="CHƯA CÓ CA"),covered=new Set(dated.map(s=>s.driver_id));
 // Legacy code-only shifts count only when the payroll code identifies one account.
 const legacyCodes=new Set(dated.filter(s=>!s.driver_id).map(s=>s.employee_code));
 return drivers.filter(d=>d.active&&configured.has(d.driver_id)&&employmentOf(d.name)==="part-time"&&!covered.has(d.driver_id)&&
  !(d.employee_code&&codeCounts.get(d.employee_code)===1&&legacyCodes.has(d.employee_code)));
}

const weekdays=["CN","T2","T3","T4","T5","T6","T7"];
const field="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-indigo-600";
export function BulkPtShiftPanel({drivers,patterns,shifts,suggestions,configuredIds,date,cutoff,onDateChange,loading,onSaved,onBusy}:{drivers:ShiftDriver[];patterns:ShiftPattern[];shifts:DriverShift[];suggestions:Record<string,RuleShiftSuggestion[]>;configuredIds:string[];date:string;cutoff:string;onDateChange:(date:string)=>void;loading:boolean;onSaved:()=>Promise<void>;onBusy:(busy:boolean)=>void}) {
 const [days,setDays]=useState([1,2,3,4,5,6]),[start,setStart]=useState(""),[end,setEnd]=useState("");
 const [selected,setSelected]=useState<Set<string>>(new Set()),[search,setSearch]=useState(""),[saving,setSaving]=useState(false),[result,setResult]=useState("");
 const missing=loading?[]:missingPtShifts(drivers,shifts,configuredIds,date),shown=missing.filter(d=>foldName(`${d.name} ${d.employee_code}`).includes(foldName(search)));
 const targets=missing.filter(d=>selected.has(d.driver_id));
 const hasPlan=(driver:ShiftDriver)=>patterns.some(p=>p.driver_id===driver.driver_id&&p.active&&!p.review_issues.length&&p.days.some(Boolean)&&(!p.active_from||p.active_from<=date)&&(!p.active_to||p.active_to>=date));
 const applicable=targets.filter(hasPlan);
 const copy=(id:string,suggestion:RuleShiftSuggestion)=>{setStart(suggestion.start);setEnd(suggestion.end);setDays(suggestion.days);setSelected(new Set([id]));setResult("Đã sao chép giờ từ config. Kiểm tra lịch tuần; có thể chọn thêm PT để dùng cùng lịch.");};
 const apply=async(list:ShiftDriver[])=>{
  setSaving(true);onBusy(true);setResult("");
  const applied:string[]=[],failed:string[]=[];
  try{
   for(const driver of list){try{
    const res=await fetch("/api/driver-shifts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"apply-pt",data:{driver_id:driver.driver_id,date}})}),body=await res.json();
    if(!res.ok||!body.ok)throw Error(body.error||"Không áp dụng được chu kỳ");applied.push(driver.driver_id);
   }catch(e){failed.push(`${driver.name}: ${e instanceof Error?e.message:String(e)}`);}setResult(`Đã xử lý ${applied.length+failed.length}/${list.length} PT…`);}
   setSelected(current=>new Set([...current].filter(id=>!applied.includes(id))));
   setResult(`Đã áp dụng ${applied.length}/${list.length} chu kỳ từ ${date} đến cuối tháng. Xem lịch tại Theo ngày.${failed.length?`\n${failed.join("\n")}`:""}`);await onSaved();
  }catch(e){setResult(e instanceof Error?e.message:String(e));}finally{setSaving(false);onBusy(false);}
 };
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
  <fieldset disabled={saving||loading} className="space-y-3 border-b border-slate-200 p-4">
   <h2 className="font-semibold">Thiếu ca · PT có config</h2>
   <p className="text-sm text-slate-600">PT đang hoạt động, được gán trong quy tắc config nhưng chưa có lịch ca cho ngày đã chọn. Ngày nghỉ hoặc nghỉ lễ đã ghi nhận không tính là thiếu. Chọn nhiều PT để dùng cùng lịch tuần.</p>
   <div className="grid gap-3 sm:grid-cols-3">
    <label className="text-sm">Ngày thiếu ca / áp dụng từ<input required type="date" min={cutoff} className={`${field} mt-1`} value={date} onChange={e=>{if(e.target.value>=cutoff){onDateChange(e.target.value);setSelected(new Set());setResult("");}}}/></label>
    <label className="text-sm">Bắt đầu (giờ VN)<input required type="time" className={`${field} mt-1`} value={start} onChange={e=>setStart(e.target.value)}/></label>
    <label className="text-sm">Kết thúc (giờ VN)<input required type="time" className={`${field} mt-1`} value={end} onChange={e=>setEnd(e.target.value)}/></label>
   </div>
   <div className="flex flex-wrap gap-4" role="group" aria-label="Ngày làm trong tuần">{[1,2,3,4,5,6,0].map(day=><label key={day} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={days.includes(day)} onChange={e=>setDays(current=>e.target.checked?[...current,day]:current.filter(d=>d!==day))}/>{weekdays[day]}</label>)}</div>
   <p className="text-xs text-slate-600">Lặp lại hàng tuần từ ngày áp dụng. Ngày không chọn là nghỉ. Sau khi lưu, bấm Áp dụng chu kỳ PT để tạo lịch ngày còn thiếu đến cuối tháng. Ca đã có được giữ lại.</p>
  </fieldset>
  <div className="flex flex-wrap items-center gap-3 p-3"><label className="min-w-0 flex-1"><span className="sr-only">Tìm PT thiếu ca</span><input type="search" className={field} placeholder="Tìm tài xế…" value={search} disabled={saving||loading} onChange={e=>setSearch(e.target.value)}/></label>
   <Button type="button" variant="outline" disabled={saving||loading||!shown.length} onClick={()=>setSelected(current=>new Set([...current,...shown.map(d=>d.driver_id)]))}>Chọn tất cả ({shown.length})</Button>
   <Button type="button" variant="ghost" disabled={saving} onClick={()=>setSelected(new Set())}>Bỏ chọn</Button>
  </div>
  <div className="min-h-0 flex-1 overflow-auto px-3">{loading?<p role="status" className="p-3 text-sm text-slate-600">Đang đọc config và lịch ca ngày {date}…</p>:shown.length?shown.map(driver=><div key={driver.driver_id} className="space-y-2 border-b border-slate-100 py-3 text-sm hover:bg-slate-50">
   <label className="flex cursor-pointer items-center gap-3"><input type="checkbox" checked={selected.has(driver.driver_id)} disabled={saving} onChange={e=>setSelected(current=>{const next=new Set(current);if(e.target.checked)next.add(driver.driver_id);else next.delete(driver.driver_id);return next;})}/><DriverName full={driver.name}/></label>
   {hasPlan(driver)&&<div className="flex flex-wrap items-center gap-2 pl-7"><p className="text-xs text-amber-800">Đã có chu kỳ tuần · cần tạo lịch ngày.</p><Button type="button" size="sm" disabled={saving} onClick={()=>void apply([driver])}>Áp dụng chu kỳ PT · đến cuối tháng</Button></div>}
   <div className="flex flex-wrap gap-2 pl-7">{suggestions[driver.driver_id]?.length?suggestions[driver.driver_id].map(s=><Button key={`${s.start}-${s.end}`} type="button" size="sm" variant="outline" disabled={saving} title={`Config: ${s.sources.join("; ")}`} onClick={()=>copy(driver.driver_id,s)}>Sao chép config · {s.days.map(d=>weekdays[d]).join(", ")} {s.start}–{s.end}</Button>):<span className="text-xs text-slate-600">Config chưa có giờ cụ thể để sao chép. Nhập giờ ở trên.</span>}</div>
  </div>):<p className="p-3 text-sm text-slate-600">{search?"Không tìm thấy tài xế phù hợp.":"Không còn PT có config thiếu ca cho ngày này."}</p>}</div>
  <div className="space-y-2 border-t border-slate-200 p-3">{result&&<p role="status" className="whitespace-pre-line text-sm">{result}</p>}
   <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-sm text-slate-600">{targets.length} tài xế đã chọn</span><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={saving||!applicable.length} onClick={()=>void apply(applicable)}>Áp dụng chu kỳ cho {applicable.length} PT</Button><Button type="submit" disabled={saving||!targets.length||!date||!days.length||!start||!end||start===end}>{saving?"Đang lưu…":`Lưu chu kỳ cho ${targets.length} PT`}</Button></div></div>
  </div>
 </form>;
}
