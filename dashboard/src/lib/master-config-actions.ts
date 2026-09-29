import { masterRules,masterClients,masterDrivers,ruleChange,writeMasterRules,uniqueNameId,type MasterRule,type AssignmentMode } from "./master-store";
import type { ConfigRowSnapshot } from "./config-row-match";
import { replaceDriverInCell } from "./driver-cell";

type Target={row:number;expectPickup:string;expected?:ConfigRowSnapshot};
type Patch={driverName?:string;driver_ids?:string[];assignment_mode?:AssignmentMode;start?:string;end?:string;dropoff?:string};
function targetRule(target:Target,rules:MasterRule[]) {
  const old=rules.find(r=>r.id===target.expected?.rule_id);
  if(!old || old.revision!==target.expected?.revision) throw new Error("Dòng đã thay đổi — tải lại trước khi lưu");
  return old;
}
async function context() {
  const [rules,clients,drivers]=await Promise.all([masterRules("weekday"),masterClients(),masterDrivers()]);
  return {rules,clients:clients.map(c=>({id:c.customer_id,names:[String(c.cartrack.customer_name??"")]})),
    drivers:drivers.map(d=>({id:d.driver_id,names:[d.roster?.Driver??"",`${d.cartrack.first_name??""} ${d.cartrack.last_name??""}`.trim()]}))};
}
function change(old:MasterRule,patch:Patch,ctx:Awaited<ReturnType<typeof context>>) {
  const driver_ids=patch.driver_ids??(patch.driverName===undefined?old.driver_ids:
    patch.driverName.split(",").map(n=>n.trim()).filter(Boolean).map(n=>uniqueNameId(n,ctx.drivers)));
  return ruleChange({customer_id:old.pickup_customer_id??"",driver_ids,
    assignment_mode:patch.assignment_mode??(driver_ids.length>1?"smart":old.assignment_mode),
    dropoff_id:patch.dropoff===undefined?old.dropoff_customer_id??"":patch.dropoff?uniqueNameId(patch.dropoff,ctx.clients):"",
    shift_start:patch.start??old.shift_start?.slice(0,5)??"",shift_end:patch.end??old.shift_end?.slice(0,5)??""},old);
}
export async function editMasterConfig(target:Target,patch:Patch|{delete:true}) {
  const ctx=await context(),old=targetRule(target,ctx.rules);
  const [saved]=await writeMasterRules(["delete" in patch?{id:old.id,revision:old.revision,active:false}:change(old,patch,ctx)]);
  return {row:saved.source_row,rule_id:saved.id,revision:saved.revision,moved:saved.source_row!==target.row};
}
export async function bulkMasterConfig(targets:Target[],patch:Patch|{delete:true}) {
  const ctx=await context();
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
  if(changes.length) await writeMasterRules(changes);
  return {done,skipped};
}
export async function replaceMasterConfig(opts:{from:string;to:string;targets:Target[]}) {
  const ctx=await context();
  const from=uniqueNameId(opts.from,ctx.drivers),to=uniqueNameId(opts.to,ctx.drivers);
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
  if(changes.length) await writeMasterRules(changes);
  return {replaced,skipped};
}
