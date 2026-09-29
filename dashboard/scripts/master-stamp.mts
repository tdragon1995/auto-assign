import {readFileSync,writeFileSync} from "node:fs";
import {readMasterSheets,stampMasterIds} from "../src/lib/master-sheet-sync";
import {sourceHash,RECORD_ID} from "../src/lib/master-reconcile";

const prepared=JSON.parse(readFileSync(".state/master-catchup.json","utf8"));
if(prepared.report.config.ambiguous.length || prepared.report.leave.ambiguous.length || prepared.report.config.overrideConflicts.length)
  throw new Error("Resolve reconciliation conflicts before stamping");
const sheets=await readMasterSheets();
if(sourceHash(sheets.flatMap(s=>s.rows))!==prepared.hash) throw new Error("Sheet changed; reconcile again before stamping");
for(let i=0;i<sheets.length;i++) await stampMasterIds(sheets[i],i===0?prepared.payload.rules:prepared.payload.leave);
const verified=await readMasterSheets();
if(sourceHash(verified.flatMap(s=>s.rows))!==prepared.hash) throw new Error("Sheet changed during stamping; reconcile again");
for(let i=0;i<verified.length;i++) {
  const desired=new Map<number,string>((i===0?prepared.payload.rules:prepared.payload.leave).map((r:{source_row:number;source_uid:string})=>[r.source_row,r.source_uid]));
  if(verified[i].rows.some(r=>r.row_data[RECORD_ID]!==desired.get(r.source_row))) throw new Error("ID read-back mismatch");
}
for(const row of [...prepared.payload.rules,...prepared.payload.leave]) row.row_data[RECORD_ID]=row.source_uid;
writeFileSync(".state/master-verified.json",JSON.stringify({...prepared,verified_at:new Date().toISOString()}));
console.log(JSON.stringify({verified:true,hash:prepared.hash,rules:prepared.payload.rules.length,leave:prepared.payload.leave.length}));
