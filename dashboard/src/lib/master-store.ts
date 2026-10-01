import { sbRpc, sbSelect, sbSelectAll } from "./supabase-rest";
import type { ConfigCells } from "./unmapped-row";
import { timeToMins } from "./time";
import { PROXY_ID, UUID } from "./master-reconcile";

export type AssignmentMode = "fixed" | "smart";
export type MasterRule = {
  id:number; source_uid:string; source_row:number; revision:number; assignment_mode:AssignmentMode;
  row_data:Record<string,string>; driver_ids:string[]; smart_driver_id:string|null; updated_at:string;
  pickup_customer_id:string|null; dropoff_customer_id:string|null; alternate_dropoff_customer_id:string|null;
  shift_start:string|null; shift_end:string|null; review_issues:string[];
};
export type MasterClient = { customer_id: string; cartrack: Record<string, unknown>; client_code: string | null; new_ward: string | null; nearest_psc_id: string | null; nearest_psc_name: string | null; nearest_psc_km: number | null; labcenter_location_id: number | null; default_dropoff_id: string | null; default_dropoff_name: string | null; eta_minutes: number | null; sales_name: string | null; sales_email: string | null; supervisor_name: string | null; supervisor_email: string | null };
export type MasterDriver = { driver_id: string; cartrack: Record<string, unknown>; roster: Record<string, string>; driver_zalo_id: string | null; bot_token: string | null; has_bot_token?:boolean; phone_number_update: string | null };
export const masterEnabled = () => process.env.MASTER_CLIENT_INFO_SOURCE === "supabase";
export function assertMasterWritable() {
  if (!masterEnabled()) throw new Error("Supabase đang là bản đối chiếu. Hãy sửa cấu hình trên Google Sheet trong thời gian kiểm tra.");
}

export async function masterRules(day:"weekday"|"sunday", scope: { ids?: number[]; pickupIds?: string[]; copyIds?: number[]; resolveNames?: boolean } = {}):Promise<MasterRule[]> {
  type Linked = MasterRule & { master_rule_drivers:{driver_id:string;selection_order:number}[] };
  const [rows,clients,drivers]=await Promise.all([sbSelectAll<Linked>("master_config_rules",
    `select=id,source_uid,source_row,revision,row_data,assignment_mode,pickup_customer_id,dropoff_customer_id,alternate_dropoff_customer_id,shift_start,shift_end,review_issues,updated_at,master_rule_drivers(driver_id,selection_order)&active=eq.true&day_type=eq.${day}${scope.ids ? `&id=in.(${scope.ids.join(",")})` : ""}${scope.pickupIds ? `&or=(pickup_customer_id.in.(${scope.pickupIds.join(",")})${scope.copyIds?.length ? `,id.in.(${scope.copyIds.join(",")})` : ""})` : ""}`,"source_row.asc,id.asc"),
    scope.resolveNames === false ? Promise.resolve([]) : sbSelectAll<{customer_id:string;customer_name:string}>("master_clients","select=customer_id,customer_name","customer_id.asc"),
    scope.resolveNames === false ? Promise.resolve([]) : sbSelectAll<{driver_id:string;first_name:string;last_name:string}>("master_drivers","select=driver_id,first_name,last_name","driver_id.asc")]);
  const names=new Map(clients.map(c=>[c.customer_id,c.customer_name]));
  const driverNames=new Map(drivers.map(d=>[d.driver_id,`${d.first_name??""} ${d.last_name??""}`.trim()]));
  return rows.map(({master_rule_drivers,...r})=>{
    const driver_ids=master_rule_drivers.sort((a,b)=>a.selection_order-b.selection_order).map(d=>d.driver_id);
    const smart_driver_id=r.assignment_mode==="smart" ? driver_ids.join(",")||null : null;
    const row_data={...r.row_data,customer_id:r.pickup_customer_id??"",dropoff_id:r.dropoff_customer_id??"",
      alt_drop_off_id:r.alternate_dropoff_customer_id??"",shift_start:r.shift_start?.slice(0,5)??"",shift_end:r.shift_end?.slice(0,5)??"",
      driver_id:r.assignment_mode==="fixed" ? driver_ids[0]??"" : "",smart_driver_id:smart_driver_id??"",
      _rule_id:String(r.id),_revision:String(r.revision),assignment_mode:r.assignment_mode,
      "Điểm Pick-up":names.get(r.pickup_customer_id??"")??r.row_data["Điểm Pick-up"]??"",
      "Điểm Drop-off":names.get(r.dropoff_customer_id??"")??r.row_data["Điểm Drop-off"]??"",
      Driver:driver_ids.map(id=>driverNames.get(id)??id).join(", ")};
    return {...r,row_data,driver_ids,smart_driver_id};
  });
}

/** Only this boundary derives legacy fields for the unchanged assignment engine. */
export async function masterRuleRows(day:"weekday"|"sunday"):Promise<Record<string,string>[]> {
  const rules=await masterRules(day);
  const out:Record<string,string>[]=[];
  for (const r of rules) {
    const row={...r.row_data};
    if (r.review_issues.length) {row.driver_id="";row.smart_driver_id="";}
    out[r.source_row-2]=row;
  }
  for(let i=0;i<out.length;i++) out[i]??={};
  return out;
}
export const masterClients=()=>sbSelectAll<MasterClient>("master_clients","select=customer_id,cartrack,is_active,client_code,new_ward,nearest_psc_id,nearest_psc_name,nearest_psc_km,labcenter_location_id,default_dropoff_id,default_dropoff_name,eta_minutes,sales_name,sales_email,supervisor_name,supervisor_email","customer_id.asc");
export async function inactiveMasterClientIds():Promise<string[]> {
  if (!masterEnabled()) return [];
  return (await sbSelectAll<{customer_id:string;is_active:boolean}>("master_clients","select=customer_id,is_active&is_active=eq.false","customer_id.asc")).filter(c=>c.is_active===false).map(c=>c.customer_id);
}
export const masterDrivers=()=>sbSelectAll<MasterDriver>("master_drivers","select=driver_id,cartrack,roster,driver_zalo_id,bot_token,phone_number_update","driver_id.asc");
/** Current report labels come from IDs; archived labels remain historical snapshots. */
export async function masterDriverNames(driverIds:string[]):Promise<Map<string,string>> {
  const ids=[...new Set(driverIds)];
  if(ids.some(id=>!UUID.test(id))) throw new Error("Invalid driver ID");
  if(!ids.length) return new Map();
  const rows=await sbSelectAll<{driver_id:string;first_name:string|null;last_name:string|null}>(
    "master_drivers",`select=driver_id,first_name,last_name&driver_id=in.(${ids.join(",")})`,"driver_id.asc");
  return new Map(rows.map(d=>[d.driver_id,`${d.first_name??""} ${d.last_name??""}`.trim()]));
}
export async function masterClient(id:string):Promise<MasterClient|null> {
  if(!UUID.test(id)) throw new Error("Invalid customer ID");
  return (await sbSelect<MasterClient>("master_clients",`select=*&customer_id=eq.${id}`))[0]??null;
}
export async function masterDriver(id:string):Promise<MasterDriver|null> {
  if(!UUID.test(id)) throw new Error("Invalid driver ID");
  return (await sbSelect<MasterDriver>("master_drivers",`select=*&driver_id=eq.${id}`))[0]??null;
}
export type RuleInput={customer_id:string;driver_ids:string[];assignment_mode?:AssignmentMode;dropoff_id:string;
  shift_start:string;shift_end:string;bot_token?:string;chat_id?:string;alt_drop_off_id?:string};
export function ruleChange(input:RuleInput,old?:MasterRule) {
  if(input?.alt_drop_off_id!==undefined && typeof input.alt_drop_off_id!=="string") throw new Error("Điểm giao thay thế không hợp lệ");
  if(!input || !UUID.test(input.customer_id) || !Array.isArray(input.driver_ids) || input.driver_ids.length>20 ||
    input.driver_ids.some(id=>typeof id!=="string" || !UUID.test(id) || id===PROXY_ID) || new Set(input.driver_ids).size!==input.driver_ids.length ||
    (input.dropoff_id && !UUID.test(input.dropoff_id)) || (input.alt_drop_off_id && !UUID.test(input.alt_drop_off_id))) throw new Error("Quy tắc không hợp lệ");
  const mode=input.assignment_mode??(input.driver_ids.length>1?"smart":old?.assignment_mode??"fixed");
  if(!["fixed","smart"].includes(mode) || (mode==="fixed" && input.driver_ids.length>1)) throw new Error("Chế độ phân công không hợp lệ");
  const start=input.shift_start,end=input.shift_end;
  if(typeof start!=="string" || typeof end!=="string" || (!!start!==!!end) ||
    (start && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || timeToMins(start)===timeToMins(end)))) throw new Error("Ca làm việc không hợp lệ");
  const row_data:Record<string,string>={};
  for(const key of ["bot_token","chat_id"] as const) {
    if(input[key]!==undefined) {
      if(typeof input[key]!=="string") throw new Error("Invalid notification setting");
      row_data[key]=input[key];
    }
  }
  return {id:old?.id,revision:old?.revision,assignment_mode:mode,driver_ids:input.driver_ids,
    pickup_customer_id:input.customer_id,dropoff_customer_id:input.dropoff_id||null,
    alternate_dropoff_customer_id:input.alt_drop_off_id===undefined?old?.alternate_dropoff_customer_id??null:input.alt_drop_off_id||null,
    shift_start:start||null,shift_end:end||null,row_data};
}
export async function writeMasterRules(changes:Record<string,unknown>[]) {
  assertMasterWritable();
  const references=new Set(changes.filter(c=>c.active!==false).flatMap(c=>[c.pickup_customer_id,c.dropoff_customer_id,c.alternate_dropoff_customer_id]));
  if (references.size && (await inactiveMasterClientIds()).some(id=>references.has(id))) throw new Error("Không thể chọn địa điểm đã ngừng hoạt động");
  return sbRpc<{id:number;revision:number;source_row:number}[]>("master_write_rules",{changes});
}
export async function saveMasterRule(input:RuleInput,id?:number,revision?:number):Promise<number> {
  const old=id===undefined?undefined:(await masterRules("weekday")).find(r=>r.id===id);
  if(id!==undefined && (!old || old.revision!==revision)) throw new Error("Dòng đã thay đổi — tải lại trước khi lưu");
  return (await writeMasterRules([ruleChange(input,old)]))[0].source_row;
}
export async function deleteMasterRule(id:number,revision:number):Promise<void> {
  await writeMasterRules([{id,revision,active:false}]);
}
export function uniqueNameId(name:string,items:{id:string;names:string[]}[]):string {
  const matches=items.filter(item=>item.names.some(n=>n.trim()===name.trim()));
  if(matches.length!==1) throw new Error(`Không xác định duy nhất: ${name}`);
  return matches[0].id;
}
export async function createMasterConfigRows(cells:ConfigCells[]):Promise<number[]> {
  assertMasterWritable();
  const [clients,drivers,rules]=await Promise.all([masterClients(),masterDrivers(),masterRules("weekday")]);
  const c=clients.map(c=>({id:c.customer_id,names:[String(c.cartrack.customer_name??"")]}));
  const d=drivers.map(d=>({id:d.driver_id,names:[d.roster?.Driver??"",`${d.cartrack.first_name??""} ${d.cartrack.last_name??""}`.trim()]}));
  const changes=cells.map(cell=>{
    const copied=rules.find(r=>r.id===cell.copyFromRuleId);
    if(cell.copyFromRow!==undefined && !copied) throw new Error("Chọn lại quy tắc cần sao chép bằng ID");
    const driver_ids=cell.driver_ids??(cell.driver??"").split(",").map(s=>s.trim()).filter(Boolean).map(n=>uniqueNameId(n,d));
    const change=ruleChange({customer_id:cell.customer_id??uniqueNameId(cell.pickup,c),driver_ids,
      assignment_mode:cell.assignment_mode??(driver_ids.length>1?"smart":copied?.assignment_mode??"fixed"),
      dropoff_id:cell.dropoff_id??(cell.dropoff?uniqueNameId(cell.dropoff,c):""),shift_start:cell.start,shift_end:cell.end,alt_drop_off_id:cell.alt_drop_off_id});
    if(copied) change.row_data={...copied.row_data,...change.row_data};
    return change;
  });
  return (await writeMasterRules(changes)).map(r=>r.source_row);
}
