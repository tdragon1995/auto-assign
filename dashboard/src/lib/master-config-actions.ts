import { masterRules,ruleChange,writeMasterRules,uniqueNameId,type MasterRule,type AssignmentMode } from "./master-store";
import { sbSelectAll } from "./supabase-rest";
import { findClash, type Line } from "./config-shift";
import { parseConfigRowSnapshot } from "./config-row-match";
import type { ConfigRowSnapshot } from "./config-row-match";
import { replaceDriverInCell } from "./driver-cell";
import { UUID } from "./master-reconcile";

type Target={row:number;expectPickup:string;expected?:ConfigRowSnapshot};
type Patch={driverName?:string;driver_ids?:string[];assignment_mode?:AssignmentMode;start?:string;end?:string;dropoff?:string;alt_drop_off_id?:string};
function targetRule(target:Target,rules:MasterRule[]) {
  const old=rules.find(r=>r.id===target.expected?.rule_id);
  if(!old || old.revision!==target.expected?.revision) throw new Error("Dòng đã thay đổi — tải lại trước khi lưu");
  return old;
}
async function context(ids?:number[],pickupIds?:string[],copyIds?:number[]) {
  const [rules,clients,drivers]=await Promise.all([masterRules("weekday",{ids,pickupIds,copyIds,resolveNames:false}),
    sbSelectAll<{customer_id:string;customer_name:string}>("master_clients","select=customer_id,customer_name","customer_id.asc"),
    sbSelectAll<{driver_id:string;first_name:string;last_name:string;is_active:boolean;Driver?:string}>("master_drivers","select=driver_id,first_name,last_name,is_active,roster->Driver","driver_id.asc")]);
  return {rules,clients:clients.map(c=>({id:c.customer_id,names:[c.customer_name]})),
    drivers:drivers.map(d=>({id:d.driver_id,names:[d.Driver??"",`${d.first_name??""} ${d.last_name??""}`.trim()],active:d.is_active!==false}))};
}
function change(old:MasterRule,patch:Patch,ctx:Awaited<ReturnType<typeof context>>) {
  const driver_ids=patch.driver_ids??(patch.driverName===undefined?old.driver_ids:
    patch.driverName.split(",").map(n=>n.trim()).filter(Boolean).map(n=>uniqueNameId(n,ctx.drivers)));
  return ruleChange({customer_id:old.pickup_customer_id??"",driver_ids,
    assignment_mode:patch.assignment_mode??(driver_ids.length>1?"smart":old.assignment_mode),
    dropoff_id:patch.dropoff===undefined?old.dropoff_customer_id??"":patch.dropoff?uniqueNameId(patch.dropoff,ctx.clients):"",
    shift_start:patch.start??old.shift_start?.slice(0,5)??"",shift_end:patch.end??old.shift_end?.slice(0,5)??"",alt_drop_off_id:patch.alt_drop_off_id},old);
}
function checkSchedule(ctx:Awaited<ReturnType<typeof context>>,changes:Record<string,unknown>[]) {
  const touched = new Set(changes.map(c=>c.id));
  const groups = new Map<string,{pickup:string;dropoff:string|null;lines:Line[]}>();
  for (const c of changes) {
    if (c.active === false) continue;
    const pickup=c.pickup_customer_id as string,dropoff=c.dropoff_customer_id as string|null;
    const key=`${pickup}|${dropoff??""}`;
    const group=groups.get(key)??{pickup,dropoff,lines:[]};
    group.lines.push({key:String(c.id??group.lines.length),driver:"",start:(c.shift_start as string)??"",end:(c.shift_end as string)??"",dropoff:""});
    groups.set(key,group);
  }
  for(const group of groups.values()) {
    const peers=ctx.rules.filter(r=>r.pickup_customer_id===group.pickup && r.dropoff_customer_id===group.dropoff && !touched.has(r.id) && r.driver_ids.length && !r.review_issues.length)
      .map(r=>({key:String(r.id),driver:"",start:r.shift_start?.slice(0,5)??"",end:r.shift_end?.slice(0,5)??"",dropoff:""}));
    if(findClash([...group.lines,...peers])) throw new Error(`Lịch trùng giờ tại ${ctx.clients.find(c=>c.id===group.pickup)?.names[0]} — kiểm tra các ca trước khi lưu`);
  }
}
export async function editMasterConfig(target:Target,patch:Patch|{delete:true}) {
  const ctx=await context([target.expected?.rule_id ?? 0]),old=targetRule(target,ctx.rules);
  const [saved]=await writeMasterRules(["delete" in patch?{id:old.id,revision:old.revision,active:false}:change(old,patch,ctx)]);
  return {row:saved.source_row,rule_id:saved.id,revision:saved.revision,moved:saved.source_row!==target.row};
}
export async function bulkMasterConfig(targets:Target[],patch:Patch|{delete:true}) {
  const withHours=!("delete" in patch) && (patch.start!==undefined || patch.end!==undefined);
  const ctx=await context(withHours ? undefined : targets.map(t=>t.expected?.rule_id ?? 0));
  const done:{row:number;pickup:string}[]=[],skipped:{row:number;pickup:string;reason:string}[]=[],changes:Record<string,unknown>[]=[];
  const seen=new Set<number>();
  for(const target of targets) {
    try {
      const old=targetRule(target,ctx.rules);
      if(seen.has(old.id)) continue;
      const value="delete" in patch?{id:old.id,revision:old.revision,active:false}:change(old,patch,ctx);
      seen.add(old.id);changes.push(value);done.push({row:old.source_row,pickup:target.expectPickup});
    } catch(e) {skipped.push({row:target.row,pickup:target.expectPickup,reason:String(e)});}
  }
  if(changes.length) {
    if(withHours) checkSchedule(ctx,changes);
    await writeMasterRules(changes);
  }
  return {done,skipped};
}
export async function replaceMasterConfig(opts:{from:string;to:string;from_driver_id?:string;to_driver_id?:string;targets:Target[]}) {
  const ctx=await context(opts.targets.map(t=>t.expected?.rule_id ?? 0));
  const from=opts.from_driver_id??uniqueNameId(opts.from,ctx.drivers),to=opts.to_driver_id??uniqueNameId(opts.to,ctx.drivers);
  if (!UUID.test(from) || !UUID.test(to) || !ctx.drivers.some(d=>d.id===from) || !ctx.drivers.some(d=>d.id===to && d.active)) throw new Error("Tài xế không hợp lệ hoặc đã ngừng hoạt động — chọn lại tài xế");
  if (from===to) throw new Error("Hai tài xế trùng nhau");
  const replaced:{row:number;pickup:string;before:string;after:string}[]=[],skipped:{row:number;pickup:string;reason:string}[]=[],changes:Record<string,unknown>[]=[];
  const seen=new Set<number>();
  for(const target of opts.targets) {
    try {
      const old=targetRule(target,ctx.rules);
      if(seen.has(old.id)) continue;
      if(!old.driver_ids.includes(from)) throw new Error("Dòng không còn tài xế này");
      const ids=[...new Set(old.driver_ids.map(id=>id===from?to:id))];
      changes.push(change(old,{driver_ids:ids},ctx));seen.add(old.id);
      const before=target.expected?.driver??"";
      replaced.push({row:old.source_row,pickup:target.expectPickup,before,after:replaceDriverInCell(before,opts.from,opts.to)??opts.to});
    } catch(e) {skipped.push({row:target.row,pickup:target.expectPickup,reason:String(e)});}
  }
  if(changes.length) await writeMasterRules(changes,ctx.rules);
  return {replaced,skipped};
}

/** One transaction for a reviewed schedule, including copies, additions and removals. */
export async function saveMasterConfigBatch(branches: unknown) {
  if (!Array.isArray(branches) || !branches.length || branches.length > 100) throw new Error("Chọn từ 1 đến 100 điểm");
  if (branches.some(b=>!b || !Array.isArray(b.rows) || !Array.isArray(b.removed)) || branches.reduce((n,b)=>n+b.rows.length+b.removed.length,0)>500) throw new Error("Tối đa 500 dòng một lần");
  const copyIds = branches.flatMap(b=>b.rows.map((l:{copy_from_rule_id?:unknown})=>l?.copy_from_rule_id).filter((id:unknown)=>id!==undefined));
  if (copyIds.some(id=>!Number.isSafeInteger(id) || id<1)) throw new Error("Quy tắc copy không hợp lệ");
  if (branches.some(b=>b.pickup_customer_id !== undefined && (typeof b.pickup_customer_id !== "string" || !UUID.test(b.pickup_customer_id)))) throw new Error("Điểm lấy không hợp lệ");
  const ctx = await context(undefined,branches.every(b=>b.pickup_customer_id) ? [...new Set<string>(branches.map(b=>b.pickup_customer_id))] : undefined,copyIds);
  const changes: Record<string, unknown>[] = [];
  const seen = new Set<number>();
  for (const branch of branches) {
    if (!branch || typeof branch.pickup_name !== "string" || !Array.isArray(branch.rows) || !Array.isArray(branch.removed)) throw new Error("Lịch không hợp lệ");
    const pickupId = uniqueNameId(branch.pickup_name, ctx.clients);
    if (branch.pickup_customer_id && branch.pickup_customer_id !== pickupId) throw new Error("Điểm lấy đã thay đổi — tải lại trước khi lưu");
    for (const line of branch.rows) {
      if (!line || [line.driver,line.start,line.end,line.dropoff].some(v => typeof v !== "string")) throw new Error("Thông tin dòng không hợp lệ");
      const expected = line.expected_row === undefined ? undefined : parseConfigRowSnapshot(line.expected_row);
      if (line.expected_row !== undefined && !expected) throw new Error("Thông tin dòng cũ không hợp lệ");
      const old = expected ? targetRule({row:line.row,expectPickup:branch.pickup_name,expected},ctx.rules) : undefined;
      if (line.row !== undefined && !old) throw new Error("Dòng đã thay đổi — tải lại trước khi lưu");
      if (old && (old.pickup_customer_id !== pickupId || seen.has(old.id))) throw new Error("Dòng không thuộc điểm lấy hoặc bị lặp");
      if (old) seen.add(old.id);
      const ids = line.driver.split(",").map((n:string)=>n.trim()).filter(Boolean).map((n:string)=>uniqueNameId(n,ctx.drivers));
      if (!ids.length || ids.some((id:string)=>!ctx.drivers.find(d=>d.id===id)?.active)) throw new Error("Chọn tài xế đang hoạt động");
      const copied = line.copy_from_rule_id === undefined ? undefined : ctx.rules.find(r=>r.id===line.copy_from_rule_id);
      if (line.copy_from_rule_id !== undefined && !copied) throw new Error("Quy tắc copy đã thay đổi — chọn lại");
      const value = ruleChange({customer_id:pickupId,driver_ids:ids,assignment_mode:line.assignment_mode,
        dropoff_id:line.dropoff ? uniqueNameId(line.dropoff,ctx.clients) : "",shift_start:line.start,shift_end:line.end,alt_drop_off_id:line.alt_drop_off_id},old);
      if (!old && copied) for (const key of ["bot_token","chat_id"]) if (copied.row_data[key] !== undefined) value.row_data[key] = copied.row_data[key];
      changes.push(value);
    }
    for (const removed of branch.removed) {
      const expected = parseConfigRowSnapshot(removed?.expected_row);
      if (!expected) throw new Error("Thông tin dòng cần xoá không hợp lệ");
      const old = targetRule({row:removed.row,expectPickup:branch.pickup_name,expected},ctx.rules);
      if (old.pickup_customer_id !== pickupId || seen.has(old.id)) throw new Error("Dòng cần xoá không thuộc điểm lấy hoặc bị lặp");
      seen.add(old.id); changes.push({id:old.id,revision:old.revision,active:false});
    }
  }
  if (!changes.length || changes.length > 500) throw new Error("Lưu từ 1 đến 500 dòng một lần");
  checkSchedule(ctx,changes);
  return writeMasterRules(changes);
}
