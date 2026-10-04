import { sbRpc,sbSelectAll } from "./supabase-rest";
import { assertMasterWritable,uniqueNameId } from "./master-store";
import { normalizeLeave,PROXY_ID } from "./master-reconcile";
import { matchLeaveRows,pickLeaveRowToEdit,pickLeaveRowToDelete,normDate,rowSubs,sameSubs,
  type LeaveCells,type LeaveRowMatch,type LeaveSubWrite } from "./sheets-writer";
import { encodeLeaveSplitNote,leaveSplitOperationKey,parseLeaveSplitNote,unwrapLeaveSplitNote,type LeaveSplitPart } from "./leave-split";
import { sourceKey } from "./thay-ca";

export type MasterLeave={id:number;source_uid:string;source_row:number;revision:number;row_data:Record<string,string>;
  linked_driver_id:string|null;starts_on:string|null;ends_on:string|null;starts_at:string|null;ends_at:string|null;
  master_leave_substitutes:{selection_order:number;coverage_kind:string;driver_id:string|null;starts_at:string|null;ends_at:string|null}[]};
export async function masterLeaveRows():Promise<MasterLeave[]> {
  return sbSelectAll<MasterLeave>("master_leave_read",
    "select=id,source_uid,source_row,revision,row_data,linked_driver_id,starts_on,ends_on,starts_at,ends_at,master_leave_substitutes&active=eq.true","source_row.asc,id.asc");
}
export function leaveLegacyRow(row:MasterLeave):Record<string,string> {
  const raw:Record<string,string>={...row.row_data,driver_id:row.linked_driver_id??"",
    _leave_id:String(row.id),_revision:String(row.revision),
    leave_from:row.starts_on??row.row_data.leave_from??"",leave_to:row.ends_on??row.row_data.leave_to??"",
    leave_from_hr:row.starts_at?.slice(0,5)??row.row_data.leave_from_hr??"",
    leave_to_hr:row.ends_at?.slice(0,5)??row.row_data.leave_to_hr??""};
  for(let i=1;i<=4;i++) raw[`sub${i}_id`]="";
  for(const sub of row.master_leave_substitutes) {
    const prefix=`sub${sub.selection_order}`;
    raw[`${prefix}_id`]=sub.coverage_kind==="3pl"?PROXY_ID:sub.driver_id??"";
    raw[`${prefix}_from`]=sub.starts_at?.slice(0,5)??raw[`${prefix}_from`]??"";
    raw[`${prefix}_to`]=sub.ends_at?.slice(0,5)??raw[`${prefix}_to`]??"";
  }
  return raw;
}
export async function masterLeaveGrid() {
  const [records,directory]=await Promise.all([masterLeaveRows(),driverDirectory()]);
  const names=new Map(directory.map(d=>[d.id,d.names[1]||d.names[0]]));
  const rows=records.map(record=>{
    const row=leaveLegacyRow(record);
    row.driver=names.get(row.driver_id)??row.driver;
    for(let i=1;i<=4;i++) row[`sub${i}_name`]=names.get(row[`sub${i}_id`])??row[`sub${i}_name`]??"";
    return row;
  });
  const header=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  return {records,header,col:Object.fromEntries(header.map((k,i)=>[k,i])),all:[header,...rows.map(r=>header.map(h=>r[h]??""))]};
}
async function driverDirectory() {
  const rows=await sbSelectAll<{driver_id:string;first_name:string;last_name:string;roster:Record<string,string>}>("master_drivers","select=driver_id,first_name,last_name,roster","driver_id.asc");
  return rows.map(d=>({id:d.driver_id,names:[d.roster?.Driver??"",`${d.first_name??""} ${d.last_name??""}`.trim()]}));
}
const rawFields=(r:LeaveCells)=>({"Ngày Nộp Đơn":r.submitted_at,driver:r.driver_name,"Loại Nghỉ":r.loai_nghi,
  leave_from:r.leave_from,leave_to:r.leave_to??"",leave_from_hr:r.leave_from_hr??"",leave_to_hr:r.leave_to_hr??"",note:r.note??""});
async function changesFor(rows:{old?:MasterLeave;raw:Record<string,string>}[]) {
  const directory=await driverDirectory(),ids=new Set(directory.map(d=>d.id));
  return rows.map(({old,raw})=>{
    const data={...raw};
    delete data._leave_id; delete data._revision; delete data._master_record_id;
    if(!data.driver_id) data.driver_id=uniqueNameId(data.driver,directory);
    for(let i=1;i<=4;i++) if(data[`sub${i}_name`] && !data[`sub${i}_id`]) data[`sub${i}_id`]=uniqueNameId(data[`sub${i}_name`],directory);
    const normalized=normalizeLeave({source_uid:old?.source_uid??"",source_row:old?.source_row??0,row_data:data},ids);
    if(normalized.review_issues.length) throw new Error(normalized.review_issues.join("; "));
    return {...normalized,id:old?.id,revision:old?.revision};
  });
}
async function write(changes:Record<string,unknown>[]) {
  assertMasterWritable();
  return sbRpc<{id:number;revision:number}[]>("master_write_leave",{changes});
}
export async function appendMasterLeave(rows:LeaveCells[]) { await write(await changesFor(rows.map(r=>({raw:rawFields(r)})))); }
export async function updateMasterLeave(id:number,values:LeaveCells,revision?:number) {
  const old=(await masterLeaveRows()).find(r=>r.id===id);
  if(!old || old.revision!==revision) throw new Error("Stale leave revision; refresh");
  await write(await changesFor([{old,raw:{...leaveLegacyRow(old),...rawFields(values)}}]));
}
export async function deleteMasterLeaves(ids:number[],versions:Map<number,number>) {
  await write(ids.map(id=>({id,revision:versions.get(id),active:false})));
}
function matches(grid:Awaited<ReturnType<typeof masterLeaveGrid>>,match:LeaveRowMatch) {
  const candidates=matchLeaveRows(grid.all,grid.col,match);
  if(match.leave_id===undefined) return candidates;
  const target=grid.records.find(r=>r.id===match.leave_id);
  if(!target || target.revision!==match.revision) throw new Error("Stale leave revision; refresh");
  return candidates.filter(c=>grid.records[c.row-2].id===match.leave_id);
}
export async function editMasterLeaveSubs(match:LeaveRowMatch,subs:LeaveSubWrite[],replace:boolean) {
  if(subs.length>3 || (!replace && !subs.length)) throw new Error("1–3 người thay mỗi lần");
  const grid=await masterLeaveGrid(),candidates=matches(grid,match);
  const candidate=replace ? pickLeaveRowToEdit(candidates) : candidates.find(c=>
    [1,2,3].filter(i=>!grid.all[c.row-1][grid.col[`sub${i}_name`]]).length>=subs.length)?.row;
  if(!candidate) throw new Error("Không tìm thấy dòng nghỉ còn ô trống — Refresh");
  const old=grid.records[candidate-2],raw=leaveLegacyRow(old);
  const slots=replace?[1,2,3]:[1,2,3].filter(i=>!raw[`sub${i}_name`]).slice(0,subs.length);
  slots.forEach((n,i)=>{const sub=subs[i];raw[`sub${n}_name`]=sub?.name??"";raw[`sub${n}_id`]="";
    raw[`sub${n}_from`]=sub?.from??"";raw[`sub${n}_to`]=sub?.to??"";});
  const [saved]=await write(await changesFor([{old,raw}]));
  return {row:old.source_row,leave_id:saved.id,revision:saved.revision};
}
export async function deleteMasterLeave(match:LeaveRowMatch) {
  const grid=await masterLeaveGrid(),candidates=matches(grid,match),victim=pickLeaveRowToDelete(candidates);
  if(!victim) throw new Error("Không tìm thấy dòng nghỉ — Refresh");
  const old=grid.records[victim.row-2];
  await write([{id:old.id,revision:old.revision,active:false}]);
  return {...victim,row:old.source_row,remaining:candidates.length-1};
}
export async function splitMasterLeave(match:LeaveRowMatch,parts:readonly LeaveSplitPart[],expectedSubs:readonly LeaveSubWrite[]) {
  if(parts.length<2 || parts.length>3) throw new Error("Chia ca cần 2–3 dòng");
  const grid=await masterLeaveGrid();
  const [from="",to=""]=(match.timeLabel??"").split("–");
  const date=normDate(match.leave_from),operationKey=leaveSplitOperationKey(match.driver_id,date,from||null,to||null,parts);
  const previous=grid.records.filter(r=>parseLeaveSplitNote(r.row_data.note??"")?.operationKey===operationKey);
  if(previous.length===parts.length) return {rows:previous.map(r=>r.source_row),created:0};
  const index=pickLeaveRowToEdit(matches(grid,match));
  if(!index || !sameSubs(rowSubs(grid.all[index-1],grid.col),expectedSubs)) throw new Error("Dòng nghỉ đã thay đổi — Refresh rồi chia ca lại");
  const old=grid.records[index-2],original=leaveLegacyRow(old);
  if(original["Loại Nghỉ"]==="Nghỉ việc") throw new Error("Nghỉ việc không thể chia ca — chọn một người thay trên dòng này");
  const rows=parts.map((part,i)=>{
    const raw:Record<string,string>={...original,leave_from_hr:part.from,leave_to_hr:part.to,
      note:encodeLeaveSplitNote({operationKey,sourceKey:sourceKey(match.driver_id,date,from||null,to||null),
        partKey:`${part.from}-${part.to}`,originalNote:unwrapLeaveSplitNote(original.note??"")})};
    for(let n=1;n<=4;n++) for(const suffix of ["name","id","from","to"]) raw[`sub${n}_${suffix}`]="";
    if(part.sub) {raw.sub1_name=part.sub.name;raw.sub1_from=part.sub.from??"";raw.sub1_to=part.sub.to??"";}
    return {old:i===0?old:undefined,raw};
  });
  const saved=await write(await changesFor(rows));
  return {rows:saved.map(r=>r.id),created:parts.length-1};
}
