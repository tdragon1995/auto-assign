// MCP-assisted execution when the local workspace has no service-role credential.
// Database snapshots stay in Supabase. This file receives data on stdin, never credentials.
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { readMasterSheets } from "../src/lib/master-sheet-sync";
import { reconcile, normalizeRule, normalizeLeave, sourceHash, type StoredRow } from "../src/lib/master-reconcile";

if (process.stdin.isTTY) process.stdin.setRawMode(true);
const line = process.argv.includes("--reuse-snapshot") ? readFileSync(".state/master-db-review.json","utf8") : await new Promise<string>(resolve=>{
  const input=createInterface({input:process.stdin,terminal:false});
  input.once("line",line=>{input.close();resolve(line);});
});
const db=JSON.parse(line) as {state:{rules:(StoredRow&{day_type:string})[];leave:StoredRow[]};clients:string[];drivers:string[]};
mkdirSync(".state",{recursive:true});
writeFileSync(".state/master-db-review.json",line);
const sheets=await readMasterSheets();
const config=reconcile(sheets[0].rows,db.state.rules.filter(r=>r.day_type==="weekday"));
const leave=reconcile(sheets[1].rows,db.state.leave,true);
const payload={rules:config.rows.map(r=>normalizeRule(r,new Set(db.clients),new Set(db.drivers))),
  leave:leave.rows.map(r=>normalizeLeave(r,new Set(db.drivers)))};
const report={config:{total:config.rows.length,...config.report},leave:{total:leave.rows.length,...leave.report},
  issues:[...payload.rules.map(r=>({kind:"rule",row:r.source_row,issues:r.review_issues})),
    ...payload.leave.map(r=>({kind:"leave",row:r.source_row,issues:r.review_issues}))].filter(r=>r.issues.length)};
writeFileSync(".state/master-catchup.json",JSON.stringify({sheets,payload,report,hash:sourceHash(sheets.flatMap(s=>s.rows))}));
writeFileSync(".state/master-reconciliation-report.json",JSON.stringify(report,null,2));
console.log(JSON.stringify({config:config.rows.length,leave:leave.rows.length,
  configChanges:Object.fromEntries(["added","edited","moved","unchanged"].map(k=>[k,config.report.changes.filter(c=>c.kind===k).length])),
  removed:config.report.removed.length,ambiguousRules:config.report.ambiguous,ambiguousLeave:leave.report.ambiguous,
  overrideConflicts:config.report.overrideConflicts,issues:report.issues.length}));
