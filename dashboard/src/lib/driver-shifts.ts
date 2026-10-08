import { sbRpc, sbSelect, sbSelectAll } from "./supabase-rest";
import { cartrackHistoryCutoff } from "./time";
import { UUID } from "./master-reconcile";
import { assertMasterWritable } from "./master-store";
import { employmentOf } from "./driver-label";
import type { MasterRule } from "./master-store";

export type DriverShift = {employee_code:string;full_name:string;driver_id:string|null;shift_date:string;slot:number;
 day_type:"working"|"off"|"holiday";start_time:string|null;end_time:string|null;holiday_name:string|null;
 leave_start:string|null;leave_end:string|null;leave_gap:boolean;source:string;revision:number;synced_at:string};
export type ShiftPattern = {id:number;driver_id:string|null;employee_code:string;label:string;days:({start:string;end:string}|null)[];
 active_from:string|null;active_to:string|null;active:boolean;note:string;revision:number;review_issues:string[]};
export type ShiftDriver = {driver_id:string;name:string;employee_code:string;active:boolean};
export type RuleShiftSuggestion = {start:string;end:string;days:number[];sources:string[]};
export const validShiftDate=(v:unknown):v is string=>typeof v==="string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v+"T00:00:00Z").toISOString().slice(0,10)===v;
const hhmm=(v:unknown)=>typeof v==="string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
export function configShiftSuggestions(ruleGroups:MasterRule[][]) {
 const suggestions:Record<string,RuleShiftSuggestion[]>={};
 ruleGroups.forEach((rules,group)=>{for(const rule of rules){
  const start=rule.shift_start?.slice(0,5)??"",end=rule.shift_end?.slice(0,5)??"";
  if(!rule.pickup_customer_id||rule.review_issues.length||!hhmm(start)||!hhmm(end)||start===end)continue;
  const days=group===0?[1,2,3,4,5,6]:[0],source=rule.row_data["Điểm Pick-up"]||rule.pickup_customer_id;
  for(const id of rule.driver_ids){
   const choices=suggestions[id]??=[];
   let choice=choices.find(s=>s.start===start&&s.end===end);
   if(!choice){choice={start,end,days:[],sources:[]};choices.push(choice);}
   choice.days=[...new Set([...choice.days,...days])];
   if(!choice.sources.includes(source))choice.sources.push(source);
  }
 }});
 return suggestions;
}
export async function shiftDrivers():Promise<ShiftDriver[]> {
 const rows=await sbSelectAll<{driver_id:string;first_name:string|null;last_name:string|null;roster:{employee_code?:string};is_active:boolean}>("master_drivers","select=driver_id,first_name,last_name,roster,is_active","driver_id.asc");
 return rows.map(r=>({driver_id:r.driver_id,name:`${r.first_name??""} ${r.last_name??""}`.trim()||r.driver_id,
   employee_code:r.roster?.employee_code||`driver:${r.driver_id}`,active:r.is_active!==false})).sort((a,b)=>a.name.localeCompare(b.name,"vi"));
}
export async function dailyDriverShifts(date:string):Promise<DriverShift[]> {
 if(!validShiftDate(date)||date<cartrackHistoryCutoff())throw new Error("Ngày nằm ngoài kỳ lưu dữ liệu lương");
 return sbSelectAll<DriverShift>("driver_shifts",`select=employee_code,full_name,driver_id,shift_date,slot,day_type,start_time,end_time,holiday_name,leave_start,leave_end,leave_gap,source,revision,synced_at&shift_date=eq.${date}`,"employee_code.asc,shift_date.asc,slot.asc");
}
export const shiftPatterns=()=>sbSelectAll<ShiftPattern>("driver_shift_patterns","select=id,driver_id,employee_code,label,days,active_from,active_to,active,note,revision,review_issues","id.asc");
export function visiblePtPatterns(patterns:ShiftPattern[],drivers:ShiftDriver[]) {
 const ids=new Set(drivers.filter(d=>d.active&&employmentOf(d.name)==="part-time").map(d=>d.driver_id));
 return patterns.filter(p=>p.active&&p.driver_id&&ids.has(p.driver_id)&&!p.review_issues.length);
}
export async function saveDriverShift(input:unknown,pattern=false) {
 assertMasterWritable();
 if(!input||typeof input!=="object")throw new Error("Ca không hợp lệ");
 const data={...input} as Record<string,unknown>;
 if(typeof data.employee_code!=="string"||!data.employee_code.trim()||data.employee_code.length>200 ||
   !Number.isSafeInteger(data.revision)||Number(data.revision)<0 || (data.driver_id!==null && (typeof data.driver_id!=="string"||!UUID.test(data.driver_id))))throw new Error("Tài xế hoặc phiên bản không hợp lệ");
 if(pattern&&!data.driver_id)throw new Error("Chọn tài xế PT đang hoạt động");
 if(data.driver_id && (pattern||data.revision===0)) {
  const driver=(await sbSelect<{driver_id:string;first_name:string|null;last_name:string|null;roster:{employee_code?:string};is_active:boolean}>("master_drivers",`select=driver_id,first_name,last_name,roster,is_active&driver_id=eq.${data.driver_id}`))[0];
  if(!driver || ((pattern||data.revision===0) && !driver.is_active))throw new Error("Chọn tài xế đang hoạt động");
  if(pattern&&employmentOf(`${driver.first_name??""} ${driver.last_name??""}`)!=="part-time")throw new Error("Mẫu ca chỉ dành cho tài xế PT; ca FT lấy từ MISA");
  data.employee_code=driver.roster?.employee_code||`driver:${driver.driver_id}`;
  if(pattern)data.label=`${driver.first_name??""} ${driver.last_name??""}`.trim();
  else data.full_name=`${driver.first_name??""} ${driver.last_name??""}`.trim();
 }
 if(pattern){
  if((data.id!==undefined&&(!Number.isSafeInteger(data.id)||Number(data.id)<1))||typeof data.active!=="boolean"||typeof data.note!=="string"||typeof data.label!=="string" ||
    (data.active_from!==null&&!validShiftDate(data.active_from))||(data.active_to!==null&&!validShiftDate(data.active_to)) ||
    (data.active_from&&data.active_to&&String(data.active_to)<String(data.active_from)))throw new Error("Ngày hiệu lực không hợp lệ");
  if(!Array.isArray(data.days)||data.days.length!==7||data.days.some(d=>d!==null&&(!d||!hhmm(d.start)||!hhmm(d.end)||d.start===d.end)))throw new Error("Nhập đủ giờ bắt đầu và kết thúc cho từng ngày làm việc");
  return sbRpc("master_write_shift_pattern",{data});
 }
 if(!validShiftDate(data.shift_date)||data.shift_date<cartrackHistoryCutoff()||!Number.isSafeInteger(data.slot)||Number(data.slot)<1||Number(data.slot)>20 ||typeof data.full_name!=="string")throw new Error("Ngày hoặc số ca không hợp lệ");
 if(!["working","off","holiday"].includes(String(data.day_type)) ||
  (data.day_type==="working"?(!hhmm(data.start_time)||!hhmm(data.end_time)||data.start_time===data.end_time):(!!data.start_time||!!data.end_time)))throw new Error("Ca phải đủ giờ bắt đầu và kết thúc");
 return sbRpc("master_write_shift",{data});
}
