// Run: npx tsx scripts/master-reconcile.test.mts
import assert from "node:assert/strict";
import { reconcile, normalizeRule, normalizeLeave, sourceHash, PROXY_ID } from "../src/lib/master-reconcile";
import {ruleChange} from "../src/lib/master-store";
import {configWriteRanges,leaveWriteRanges} from "../src/lib/sheets-writer";
import {publicDriver,publicRule} from "../src/lib/master-public";
const a="00000000-0000-0000-0000-000000000001", b="00000000-0000-0000-0000-000000000002";
const old={id:9,source_uid:a,source_row:2,active:true,row_data:{customer_id:a,driver_id:b,shift_start:"6:00",shift_end:"15:00"}};
let r=reconcile([{source_row:50,row_data:{...old.row_data}}],[old]);
assert.equal(r.rows[0].source_uid,a); assert.equal(r.report.changes[0].kind,"moved");
r=reconcile([{source_row:2,row_data:{...old.row_data,driver_id:a}}],[old]);
assert.equal(r.rows[0].source_uid,a); assert.equal(r.report.changes[0].kind,"edited");
assert.throws(()=>reconcile([{source_row:2,row_data:{_master_record_id:a}},{source_row:3,row_data:{_master_record_id:a}}],[]),/duplicate/);
r=reconcile([{source_row:2,row_data:old.row_data}],[old,{...old,id:10,source_uid:b}]);
assert.equal(r.report.ambiguous.length,1);
const copies=reconcile([{source_row:4,row_data:old.row_data},{source_row:5,row_data:old.row_data}],
  [old,{...old,id:10,source_uid:b,source_row:3}],true);
assert.equal(copies.report.ambiguous.length,0);assert.deepEqual(copies.rows.map(r=>r.source_uid),[a,b]);
assert.equal(copies.report.removed.length,0);
r=reconcile([{source_row:3,row_data:{...old.row_data,_master_record_id:a,driver_id:a}}],[old]);
assert.equal(r.report.changes[0].kind,"edited"); assert.equal(r.rows[0].source_uid,a);
const single={...old,smart_driver_id_manual:b,row_data:{...old.row_data,smart_driver_id:b}};
r=reconcile([{source_row:90,row_data:single.row_data}],[single]);
let rule=normalizeRule(r.rows[0],new Set([a]),new Set([b]));
assert.equal(rule.assignment_mode,"smart"); assert.deepEqual(rule.driver_ids,[b]);
assert.equal(r.report.overrideConflicts.length,0); assert.equal(rule.shift_start,"06:00");
rule=normalizeRule({...r.rows[0],row_data:{...single.row_data,smart_driver_id:`${b},bad`}},new Set([a]),new Set([b]));
assert.deepEqual(rule.driver_ids,[]); assert.ok(rule.review_issues.length);
const leave=normalizeLeave({...r.rows[0],row_data:{driver_id:b,leave_from:"28/09/2026",leave_to:"",sub1_id:PROXY_ID,sub1_from:"0:00"}},new Set([b]));
assert.equal(leave.starts_on,"2026-09-28"); assert.equal(leave.ends_on,null);
assert.equal(leave.substitutes[0].coverage_kind,"3pl"); assert.equal(leave.substitutes[0].driver_id,null);
assert.equal(sourceHash([old]),sourceHash([{...old,row_data:{...old.row_data,_master_record_id:b}}]));
assert.equal(normalizeLeave({...r.rows[0],row_data:{leave_from:"31/02/2026"}},new Set()).starts_on,null);
console.log("Master reconciliation checks passed: moves, duplicates, retries, overrides, invalid IDs, dates, 3PL");

const input={customer_id:a,driver_ids:[b],assignment_mode:"smart" as const,dropoff_id:"",shift_start:"23:00",shift_end:"01:00"};
assert.equal(ruleChange(input).assignment_mode,"smart");
assert.equal(ruleChange({...input,assignment_mode:undefined}).assignment_mode,"fixed");
assert.throws(()=>ruleChange({...input,driver_ids:[PROXY_ID]}));
assert.throws(()=>ruleChange({...input,driver_ids:[b,b]}));
assert.throws(()=>ruleChange({...input,shift_end:""}));
assert.throws(()=>ruleChange({...input,shift_end:"23:00"}));
const ranges=configWriteRanges("config",{pickup:"E",dropoff:"F",driver:"H",start:"I",end:"J",identity:"O"},
  [{pickup:"a",dropoff:"",start:"",end:""},{pickup:"a",dropoff:"",start:"",end:""}],50);
const ids=ranges.find(r=>r.range.includes("!O"))!.values.flat();
assert.equal(new Set(ids).size,2);assert.ok(ids.every(id=>/^[0-9a-f-]{36}$/.test(id)));
assert.ok(ranges.every(r=>!/[!][ABCDKL]/.test(r.range)),"Formula columns remain untouched");
const header=["Ngày Nộp Đơn","driver","Loại Nghỉ","leave_from","leave_to","leave_from_hr","leave_to_hr","note","_master_record_id"];
const leaveRanges=leaveWriteRanges("'Leave'",h=>header.includes(h)?String.fromCharCode(65+header.indexOf(h)):null,
  [{submitted_at:"2026-09-29",driver_name:"A",loai_nghi:"Nghỉ nguyên buổi",leave_from:"2026-09-30"}],20);
assert.ok(leaveRanges.find(r=>r.range.includes("!I"))?.values[0][0]);
assert.equal(normalizeLeave({...r.rows[0],row_data:{driver_id:b,leave_from:"2026-09-29",leave_to_hr:"24:00"}},new Set([b])).ends_at,"24:00");
const publicProfile=publicDriver({driver_id:b,cartrack:{first_name:"A",token:"private",remember_token:"private"},roster:{bot_token:"private"},bot_token:"private",driver_zalo_id:null,phone_number_update:null});
assert.ok(!JSON.stringify(publicProfile).includes("private"));assert.equal(publicProfile.has_bot_token,true);
const publicConfig=publicRule({row_data:{bot_token:"private",chat_id:"private"}} as Parameters<typeof publicRule>[0]);
assert.ok(!JSON.stringify(publicConfig).includes("private"));
console.log("ID generation, mode validation, overnight boundaries, and secret redaction passed");
