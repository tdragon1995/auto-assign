// Read-only export using the same parser as the engine. Never creates jobs.
import assert from "node:assert/strict";
import {writeFileSync,mkdirSync,readFileSync} from "node:fs";
import {fetchSheetRows,SHEET_GID,SHEET_CONTRACT} from "../src/lib/sheets";
import {parseScheduleSheetRows,filterRowsForToday} from "../src/lib/schedule-job";
const raw=await fetchSheetRows(SHEET_GID.schedule_job,SHEET_CONTRACT.schedule_job);
if(process.argv.includes("--check")) {
  assert.deepEqual(raw,JSON.parse(readFileSync(".state/schedule-before.json","utf8")).raw,"Sheet changed since the snapshot; reconcile before importing");
  console.log("Scheduled Setup is unchanged from the migration snapshot");process.exit(0);
}
const rows=parseScheduleSheetRows(raw);
const populated=rows.filter(r=>r.pickup_name||r.dropoff_name||r.reference||r.delivery_window||r.driver_name);
assert.ok(populated.length>0);
assert.equal(new Set(populated.map(r=>r.reference)).size,populated.length,"Duplicate references require review");
assert.ok(populated.every(r=>r.pickup_id&&r.dropoff_id&&r.reference&&/^([01]?\d|2[0-3]):[0-5]\d$/.test(r.delivery_window)));
mkdirSync(".state",{recursive:true});
writeFileSync(".state/schedule-before.json",JSON.stringify({at:new Date().toISOString(),raw,rows}));
const imported=populated.map(r=>({source_row:r.rowIndex,source_data:raw[r.rowIndex-2],pickup_id:r.pickup_id,dropoff_id:r.dropoff_id,
  driver_id:r.driver_id||null,delivery_window:r.delivery_window,sent_to_driver_before:r.sent_to_driver_before,reference:r.reference,days:r.days}));
const json=JSON.stringify(imported);
assert.ok(!json.includes("$schedule_import$"));
const recordset=`jsonb_to_recordset($schedule_import$${json}$schedule_import$::jsonb) as r(source_row integer,source_data jsonb,pickup_id uuid,dropoff_id uuid,driver_id uuid,delivery_window time,sent_to_driver_before integer,reference text,days boolean[])`;
writeFileSync(".state/schedule-import.sql",`begin;
do $$ begin if exists(select 1 from public.master_schedule_jobs) then raise exception 'Schedule import already applied; do not replace operational edits'; end if; end $$;
insert into public.master_schedule_jobs(source_row,source_data,pickup_id,dropoff_id,driver_id,delivery_window,sent_to_driver_before,reference,days)
select source_row,source_data,pickup_id,dropoff_id,driver_id,delivery_window,sent_to_driver_before,reference,days from ${recordset};
commit; select count(*) as imported from public.master_schedule_jobs;`);
writeFileSync(".state/schedule-links.sql",`select r.source_row,r.reference,
  not exists(select 1 from public.master_clients where customer_id=r.pickup_id) as missing_pickup,
  not exists(select 1 from public.master_clients where customer_id=r.dropoff_id) as missing_dropoff,
  r.driver_id is not null and not exists(select 1 from public.master_drivers where driver_id=r.driver_id) as missing_driver
from ${recordset} where not exists(select 1 from public.master_clients where customer_id=r.pickup_id)
or not exists(select 1 from public.master_clients where customer_id=r.dropoff_id)
or (r.driver_id is not null and not exists(select 1 from public.master_drivers where driver_id=r.driver_id));`);
console.log(JSON.stringify({rows:rows.length,populated:populated.length,empty:rows.length-populated.length,days:Array.from({length:7},(_,i)=>filterRowsForToday(rows,i).length)}));
