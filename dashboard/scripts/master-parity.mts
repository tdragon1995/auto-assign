// Read-only comparison of the exact captured Sheet input and its canonical import.
import {readFileSync,writeFileSync} from "node:fs";
import assert from "node:assert/strict";
import {parseTime} from "../src/lib/config";
import {leaveLegacyRow,type MasterLeave} from "../src/lib/master-leave";
import {leaveEntriesOnDate,type LeaveEntry} from "../src/lib/leave-config";
import {addDays} from "../src/lib/time";
const snapshot=JSON.parse(readFileSync(".state/master-verified.json","utf8"));
const previous=JSON.parse(readFileSync(".state/master-db-review.json","utf8"));
const effective=(r:Record<string,string>)=>({pickup:r.customer_id,dropoff:r.dropoff_id||"",alternate:r.alt_drop_off_id||"",
  drivers:r.smart_driver_id?.trim()?r.smart_driver_id.split(",").map(s=>s.trim()):r.driver_id?[r.driver_id]:[],
  mode:r.smart_driver_id?.trim()?"smart":"fixed",start:parseTime(r.shift_start),end:parseTime(r.shift_end)});
let smart=0;
for(const r of snapshot.payload.rules) {
  assert.deepEqual(r.review_issues,[],`Unresolved rule ${r.source_row}`);
  const canonical={...r.row_data,customer_id:r.pickup_customer_id??"",dropoff_id:r.dropoff_customer_id??"",alt_drop_off_id:r.alternate_dropoff_customer_id??"",
    driver_id:r.assignment_mode==="fixed"?r.driver_ids[0]??"":"",smart_driver_id:r.assignment_mode==="smart"?r.driver_ids.join(","):"",shift_start:r.shift_start??"",shift_end:r.shift_end??""};
  assert.deepEqual(effective(canonical),effective(r.row_data),`Rule ${r.source_row}`);
  if(previous.state.rules.some((old:{source_uid:string;smart_driver_id_manual:string})=>old.source_uid===r.source_uid && old.smart_driver_id_manual)) {
    assert.equal(r.assignment_mode,"smart");assert.equal(r.driver_ids.length,1);smart++;
  }
}
assert.equal(smart,14);
const entry=(r:Record<string,string>):LeaveEntry=>({driver_id:r.driver_id||"",driver_name:r.driver||"",loai_nghi:r["Loại Nghỉ"]||"",leave_from:r.leave_from,
  leave_to:r.leave_to||null,gio_bat_dau:r.leave_from_hr||null,gio_ket_thuc:r.leave_to_hr||null,
  subs:[1,2,3,4].filter(i=>r[`sub${i}_id`]).map(i=>({id:r[`sub${i}_id`],name:r[`sub${i}_name`]||"",from:r[`sub${i}_from`]||null,to:r[`sub${i}_to`]||null}))});
const legacy:LeaveEntry[]=[],canonical:LeaveEntry[]=[];
for(const r of snapshot.payload.leave) {
  legacy.push(entry(r.row_data));
  canonical.push(entry(leaveLegacyRow({...r,id:0,revision:0,master_leave_substitutes:r.substitutes} as MasterLeave)));
}
const dates=new Set<string>();
for(let date="2026-09-27";date<="2026-10-11";date=addDays(date,1)) dates.add(date);
for(const e of legacy) for(const date of [e.leave_from,e.leave_to].filter((d):d is string=>!!d)) {
  dates.add(date);dates.add(addDays(date,-1));dates.add(addDays(date,1));
}
for(const date of [...dates].sort()) {
  // IDs/revisions are navigation metadata and deliberately excluded from behavior comparison.
  assert.deepEqual(leaveEntriesOnDate(date,canonical),leaveEntriesOnDate(date,legacy),`Leave coverage ${date}`);
}
const result={rules:snapshot.payload.rules.length,leave:snapshot.payload.leave.length,singleSmart:smart,ruleDifferences:0,leaveCoverageDifferences:0,datesChecked:dates.size,assignmentsPerformed:0};
writeFileSync(".state/master-parity.json",JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
