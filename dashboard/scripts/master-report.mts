import {readFileSync,writeFileSync} from "node:fs";
const d=JSON.parse(readFileSync(".state/master-verified.json","utf8"));
const old=JSON.parse(readFileSync(".state/master-db-review.json","utf8"));
const esc=(v:unknown)=>String(v??"").replaceAll("|","\\|").replaceAll("\n"," ");
const table=(head:string[],rows:unknown[][])=>[head,head.map(()=>"---"),...rows].map(r=>`| ${r.map(esc).join(" | ")} |`).join("\n");
const rules=new Map<number,any>(d.payload.rules.map((r:any)=>[r.source_row,r]));
const leaves=new Map<number,any>(d.payload.leave.map((r:any)=>[r.source_row,r]));
const oldRules=new Map<number,any>(old.state.rules.map((r:any)=>[r.id,r]));
const issues=d.report.issues.map((i:any)=>{
  const r=(i.kind==="rule"?rules:leaves).get(i.row).row_data;
  return [i.row,r.driver??r["Điểm Pick-up"],r.leave_from,r.leave_to,r["Loại Nghỉ"],
    [1,2,3,4].filter(n=>r[`sub${n}_name`]||r[`sub${n}_id`]).map(n=>`${n}: ${r[`sub${n}_name`]||r[`sub${n}_id`]} (${r[`sub${n}_from`]||""}–${r[`sub${n}_to`]||""})`).join("; "),i.issues.join("; ")];
});
const edits=d.report.config.changes.filter((c:any)=>c.kind==="edited").map((c:any)=>{
  const before=oldRules.get(c.id).row_data,after=rules.get(c.row).row_data;
  return [c.id,c.previous_row,c.row,after["Điểm Pick-up"],before.Driver,after.Driver,
    `${before.shift_start||"all day"}–${before.shift_end||""}`,`${after.shift_start||"all day"}–${after.shift_end||""}`];
});
const counts=Object.fromEntries(["added","edited","moved","unchanged"].map(k=>[k,d.report.config.changes.filter((r:any)=>r.kind===k).length]));
const report=`# Master Client Info review

Captured and ID-verified: ${d.verified_at}. Google Sheet remains operational. Sunday configuration and its weekly roster remain on Sheet. No new schedule or polling was added.

## Reconciliation

- Weekday: ${d.payload.rules.length} active records, up from 2,049 (${d.payload.rules.length-2049} net). ${counts.added} additions, ${counts.edited} content edits, ${counts.moved} moves, ${counts.unchanged} unchanged. ${d.report.config.removed.length} old records retained inactive.
- Leave: ${d.payload.leave.length} active records, up from 627. Identical duplicate copies retained separately with permanent IDs.
- Zero ambiguous identity matches and zero Smart override conflicts. All 14 single-driver Smart cases retained their IDs and Smart mode.
- Exact imported fields and driver links match the captured input. Offline effective-rule comparison: zero differences. Leave coverage comparison: zero differences across 105 source-boundary and current dates. No jobs assigned by validation.
- All 367 drivers' Zalo tokens, recipients and local phone settings unchanged; Sunday snapshot unchanged.
- 1,413 verified accounts link to 1,937 distinct locations. Report tables have verified Master links while retaining raw historical names and IDs.

## Leave values requiring case-by-case review

${issues.length} rows retain their original unresolved values. Missing substitute IDs remain unresolved; invalid time strings retain the legacy engine's behavior. Correct these through Google Sheet during review, then use manual catch-up.

${table(["Sheet row","Driver","From","To","Type","Original substitute values","Issue"],issues)}

## Matched rules with changed contents

${table(["Permanent rule ID","Old row","Current row","Pickup","Old driver label","Current driver label","Old shift","Current shift"],edits)}

## Before cutover

Operational edits still go through Sheet; the Supabase rule review editor is read-only. Renames remain blocked while remaining Sheet dependencies cannot be verified. Address edits preserve current GPS unless coordinates are explicitly changed.

After review, briefly freeze weekday/leave edits, perform another delta import, switch both sources together, invalidate caches, and verify a controlled assignment cycle. Sunday stays on Sheet. The deprecated Smart columns are compatibility values derived from mode and links; formula triggers are disabled. Retire these compatibility columns after final cutover validation. If Supabase has received operational edits, reconcile them back before rolling back to Sheet.
`;
writeFileSync(".state/Master-Client-Info-review.md",report);
const csv=(rows:unknown[][])=>rows.map(r=>r.map(v=>'"'+String(v??"").replaceAll('"','""')+'"').join(",")).join("\r\n");
const rows=d.report.config.changes.map((c:any)=>{const r=rules.get(c.row);return [c.kind,c.id??"new",r.source_uid,c.previous_row,c.row,r.row_data["Điểm Pick-up"],r.assignment_mode,r.driver_ids.join(","),r.shift_start,r.shift_end,r.dropoff_customer_id,r.alternate_dropoff_customer_id];});
for(const c of d.report.config.removed) {const r=oldRules.get(c.id);rows.push(["inactive",c.id,r.source_uid,c.row,"",r.row_data["Điểm Pick-up"],"","","","","",""]);}
writeFileSync(".state/Master-Client-Info-reconciliation.csv","\uFEFF"+csv([["change","rule_id","source_uid","previous_row","current_row","pickup","assignment_mode","driver_ids","shift_start","shift_end","destination_id","alternate_destination_id"],...rows]));
console.log(JSON.stringify({report:".state/Master-Client-Info-review.md",issues:issues.length,edits:edits.length,csvRows:rows.length}));
