import { getSheetsClient } from "./sheets-writer";
import type { sheets_v4 } from "googleapis";
import { masterEnabled } from "./master-store";
import { SHEET_ID, SHEET_GID, SHEET_CONTRACT, assertHeaders } from "./sheets";
import { sbRpc, sbSelectAll } from "./supabase-rest";
import { syncMissingProfiles } from "./master-sync";
import { RECORD_ID, reconcile, normalizeLeave, normalizeRule, sourceHash, type SourceRow, type StoredRow } from "./master-reconcile";

type Sheet = { gid: string; title: string; columns: number; header: string[]; rows: SourceRow[]; tables:sheets_v4.Schema$Table[] };
type State = { rules: (StoredRow & { day_type: string })[]; leave: StoredRow[] };
const quote = (title: string) => `'${title.replace(/'/g, "''")}'`;
export function sheetColumn(index: number): string {
  let result = "";
  for (let n=index+1;n>0;n=Math.floor((n-1)/26)) result=String.fromCharCode(65+(n-1)%26)+result;
  return result;
}
export async function readMasterSheets(): Promise<Sheet[]> {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId:SHEET_ID, fields:"sheets(properties,tables)" });
  return Promise.all([SHEET_GID.mapping,SHEET_GID.nghi_phep].map(async gid => {
    const p = meta.data.sheets?.find(s => String(s.properties?.sheetId)===gid)?.properties;
    if (!p?.title || !p.gridProperties?.columnCount) throw new Error(`Missing Sheet ${gid}`);
    const response = await sheets.spreadsheets.values.get({ spreadsheetId:SHEET_ID, range:quote(p.title), valueRenderOption:"FORMATTED_VALUE" });
    const [head,...values] = response.data.values ?? [];
    const header = (head ?? []).map(v => String(v).trim());
    const contract = gid === SHEET_GID.mapping ? SHEET_CONTRACT.mapping : SHEET_CONTRACT.nghi_phep;
    assertHeaders(contract.label,header,contract.require);
    if (header.filter(h => h===RECORD_ID).length>1) throw new Error(`Duplicate ${RECORD_ID} header`);
    const rows = values.map((cells,i) => ({ source_row:i+2,row_data:Object.fromEntries(header.flatMap((key,j) => key ? [[key,String(cells[j]??"").trim()]] : [])) }))
      .filter(r => gid === SHEET_GID.mapping ? !!(r.row_data.customer_id || r.row_data["Điểm Pick-up"])
        : Object.entries(r.row_data).some(([k,v]) => k!==RECORD_ID && !!v));
    if (rows.length<100) throw new Error(`${p.title}: suspiciously short source`);
    return { gid,title:p.title,columns:p.gridProperties.columnCount,header,rows,
      tables:meta.data.sheets?.find(s=>String(s.properties?.sheetId)===gid)?.tables??[] };
  }));
}

/** Only this explicit action stamps IDs. Never changes formula or business cells. */
export async function stampMasterIds(sheet: Sheet, rows: { source_row:number; source_uid:string }[]) {
  const sheets=getSheetsClient();
  let column=sheet.header.indexOf(RECORD_ID);
  if (column<0) {
    if (sheet.header.length!==sheet.columns) throw new Error("Review the last used column before appending the record ID");
    column=sheet.columns; // Outside the existing grid and its formula spill ranges.
    await sheets.spreadsheets.batchUpdate({ spreadsheetId:SHEET_ID,requestBody:{ requests:[
      { appendDimension:{ sheetId:Number(sheet.gid),dimension:"COLUMNS",length:1 } },
      { updateCells:{ start:{sheetId:Number(sheet.gid),rowIndex:0,columnIndex:column},rows:[{values:[{userEnteredValue:{stringValue:RECORD_ID}}]}],fields:"userEnteredValue" } },
      { updateDimensionProperties:{ range:{sheetId:Number(sheet.gid),dimension:"COLUMNS",startIndex:column,endIndex:column+1},properties:{hiddenByUser:true},fields:"hiddenByUser" } },
      ...sheet.tables.filter(t=>(t.range?.startRowIndex??0)===0 && t.range?.endColumnIndex===column).map(t=>({
        updateTable:{table:{tableId:t.tableId,range:{...t.range,endColumnIndex:column+1}},fields:"range"},
      })),
    ] } });
  }
  const byRow=new Map(sheet.rows.map(r=>[r.source_row,r]));
  const data=rows.filter(r => byRow.get(r.source_row)?.row_data[RECORD_ID]!==r.source_uid)
    .map(r=>({range:`${quote(sheet.title)}!${sheetColumn(column)}${r.source_row}`,values:[[r.source_uid]]}));
  if (data.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId:SHEET_ID,requestBody:{valueInputOption:"RAW",data} });
}

/** One manual catch-up, one DB transaction for rules and leave. Sunday stays on Sheet. */
export async function syncMasterSheet(dryRun = false) {
  if(masterEnabled() && !dryRun) throw new Error("Google Sheet import is disabled after operational cutover");
  const [sheets,state,clients,drivers]=await Promise.all([
    readMasterSheets(),sbRpc<State>("master_review_state"),
    sbSelectAll<{customer_id:string}>("master_clients","select=customer_id","customer_id.asc"),
    sbSelectAll<{driver_id:string}>("master_drivers","select=driver_id","driver_id.asc"),
  ]);
  const weekday=state.rules.filter(r=>r.day_type==="weekday");
  if (sheets[0].rows.length<weekday.filter(r=>r.active).length*.8 || sheets[1].rows.length<state.leave.filter(r=>r.active).length*.8) {
    throw new Error("Source unexpectedly short; import refused");
  }
  const config=reconcile(sheets[0].rows,weekday), leave=reconcile(sheets[1].rows,state.leave,true);
  const clientIds=new Set(clients.map(c=>c.customer_id)), driverIds=new Set(drivers.map(d=>d.driver_id));
  if(!dryRun) await syncMissingProfiles(sheets.flatMap(s=>s.rows),clientIds,driverIds);
  const payload={ rules:config.rows.map(r=>normalizeRule(r,clientIds,driverIds)),leave:leave.rows.map(r=>normalizeLeave(r,driverIds)) };
  const report={ config:{total:config.rows.length,...config.report},leave:{total:leave.rows.length,...leave.report},
    issues: [...payload.rules.map(r=>({kind:"rule",row:r.source_row,issues:r.review_issues})),
      ...payload.leave.map(r=>({kind:"leave",row:r.source_row,issues:r.review_issues}))].filter(r=>r.issues.length),
    sunday:"Google Sheet; unchanged", operationalSource:"Google Sheet" };
  const blocked=config.report.ambiguous.length+leave.report.ambiguous.length+config.report.overrideConflicts.length+leave.report.overrideConflicts.length>0;
  if (dryRun || blocked) return {dryRun,blocked,...report};
  const hash=sourceHash(sheets.flatMap(s=>s.rows));
  const run_id=await sbRpc<string>("master_begin_import",{ source_hash:hash,source_snapshot:sheets,expected_state:state,report });
  const beforeStamp=await readMasterSheets();
  if (sourceHash(beforeStamp.flatMap(s=>s.rows))!==hash) throw new Error("Sheet changed before ID stamping; retry");
  for (let i=0;i<sheets.length;i++) await stampMasterIds(beforeStamp[i],i===0?config.rows:leave.rows);
  const verified=await readMasterSheets();
  if (sourceHash(verified.flatMap(s=>s.rows))!==hash) throw new Error("Sheet changed during ID stamping; retry");
  for (let i=0;i<verified.length;i++) {
    const expected=new Map((i===0?config.rows:leave.rows).map(r=>[r.source_row,r.source_uid]));
    if (verified[i].rows.some(r=>r.row_data[RECORD_ID]!==expected.get(r.source_row))) throw new Error("Sheet ID read-back mismatch; retry");
  }
  for (const row of [...payload.rules,...payload.leave]) row.row_data[RECORD_ID]=row.source_uid;
  await sbRpc("master_commit_import",{run_id,payload,verified_source_hash:hash});
  return {dryRun,blocked:false,run_id,...report};
}
