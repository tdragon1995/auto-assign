// One-time catch-up: dry-run by default. No scheduled workload.
// npx tsx scripts/labcenter-fill-defaults.mts <env-file> <report.json> [--apply]
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { getAdminToken, listPickDropLocations, labcenterFetch, DELIVERY_BASE, updatePickDropLocation, type PickDropRow } from "../src/lib/labcenter";
import { masterClients } from "../src/lib/master-store";
import { commitPickupSetup, type SetupRow } from "../src/lib/pickup-setup";
import { sbSelect } from "../src/lib/supabase-rest";
import { invalidateConfigCache } from "../src/lib/config";
import { isInactiveLocation } from "../src/lib/location-status";

function defaults(row?: PickDropRow) {
  const blankDrop = !row?.drop_location_id;
  const blankEta = !row || row.eta_blank;
  if (!blankDrop && !blankEta) return null;
  if (!blankEta && (row!.eta_valid===false || !Number.isInteger(row!.eta_mins) || row!.eta_mins<0 || row!.eta_mins>1440)) throw Error("invalid_eta");
  return { blankDrop, eta: blankEta ? 60 : row!.eta_mins };
}
if (process.argv.includes("--check")) {
  const row: PickDropRow = {lc_location_id:1,pick_name:null,drop_location_id:2,drop_name:null,eta_mins:90,eta_valid:true,eta_blank:false};
  assert.equal(defaults(row),null);
  assert.deepEqual(defaults(),{blankDrop:true,eta:60});
  assert.deepEqual(defaults({...row,drop_location_id:0}),{blankDrop:true,eta:90});
  assert.deepEqual(defaults({...row,eta_blank:true}),{blankDrop:false,eta:60});
  assert.equal(defaults({...row,eta_mins:0}),null,"Zero ETA is not blank");
  assert.throws(()=>defaults({...row,drop_location_id:0,eta_valid:false}),/invalid_eta/);
  console.log("Blank defaults, preserved filled values, zero ETA and invalid source checks passed.");
  process.exit(0);
}
process.loadEnvFile(process.argv[2]);
const databaseEnv = process.argv.find(a=>a.startsWith("--database-env="));
if (databaseEnv) process.loadEnvFile(databaseEnv.slice("--database-env=".length));
if (!String(process.env.SUPABASE_URL).includes("odbmfkzkipklepmghjwj.supabase.co")) throw Error("Unexpected Supabase project");
const file = process.argv[3];
if (!file) throw Error("A restricted report path is required");
const apply = process.argv.includes("--apply");
const token = await getAdminToken();
if (!token) throw Error("Labcenter login unavailable");
const [clients, setups] = await Promise.all([masterClients(), listPickDropLocations(token)]);
if (setups.length < 1000) throw Error("Refusing incomplete source snapshot");
const d001 = clients.find(c => c.customer_id === "3927b076-3af9-11ed-b939-506b8dbc8dfb");
if (!d001?.labcenter_location_id) throw Error("D001 is not linked to Labcenter");
const report: { applied: boolean; sourceRows: number; eligible: number; updated: number; skipped: unknown[]; rows: Record<string,unknown>[] } = {applied:apply,sourceRows:setups.length,eligible:0,updated:0,skipped:[],rows:[]};
for (const c of clients) {
  if (!/^\d+$/.test(c.client_code ?? "") || !c.labcenter_location_id || isInactiveLocation(c.cartrack.customer_name) || c.cartrack.is_active === false) continue;
  if (clients.filter(x=>x.labcenter_location_id===c.labcenter_location_id).length!==1) { report.skipped.push({id:c.customer_id,reason:"ambiguous_link"}); continue; }
  const rows = setups.filter(s=>s.lc_location_id===c.labcenter_location_id);
  const before = rows[0];
  if (rows.some(s=>s.drop_location_id!==before.drop_location_id || s.eta_mins!==before.eta_mins || s.eta_blank!==before.eta_blank)) {report.skipped.push({id:c.customer_id,reason:"conflicting_setup"});continue;}
  let plan;
  try { plan=defaults(before); } catch {report.skipped.push({id:c.customer_id,reason:"invalid_eta"});continue;}
  if (!plan) continue;
  const {blankDrop,eta}=plan;
  const destinations = blankDrop ? [d001] : clients.filter(x=>x.labcenter_location_id===before.drop_location_id);
  const drop = destinations.length===1 ? destinations[0] : null;
  if (!drop?.labcenter_location_id) {report.skipped.push({id:c.customer_id,reason:"unresolved_destination"});continue;}
  const item = {customer_id:c.customer_id,name:c.cartrack.customer_name,before:before??null,dropoff_id:drop.customer_id,eta_minutes:eta,status:"planned"};
  report.rows.push(item); report.eligible++;
  await writeFile(file,JSON.stringify(report,null,2));
  if (!apply) continue;
  const current = await labcenterFetch(`${DELIVERY_BASE}/api/pick-drop-locations?pick_location_id=${c.labcenter_location_id}&perPage=100`,{headers:{Authorization:`Bearer ${token}`},cache:"no-store"});
  if (!current.ok) throw Error(`Cannot verify source: ${current.status}`);
  const raw = (await current.json()).data;
  if (!Array.isArray(raw)) throw Error("Invalid source response");
  const live = raw.filter(r=>Number(r.pick_location_id)===c.labcenter_location_id);
  if (live.length!==rows.length || live.some(r=>(r.drop_location_id==null||String(r.drop_location_id).trim()===""?0:Number(r.drop_location_id))!==before?.drop_location_id || (r.estimate_pick_up==null||String(r.estimate_pick_up).trim()==="")!==before?.eta_blank || (Number(r.estimate_pick_up)||0)!==before?.eta_mins)) {item.status="source_changed";continue;}
  const previous = (await sbSelect<SetupRow>("pickup_setup",`select=*&lc_location_id=eq.${c.labcenter_location_id}`))[0]??null;
  const result = await updatePickDropLocation({pickId:c.customer_id,dropId:drop.customer_id,etaMins:eta,lcLocationId:c.labcenter_location_id,dropLocationId:drop.labcenter_location_id},token);
  if (!result.ok) throw Error(result.error);
  item.status="labcenter_verified"; await writeFile(file,JSON.stringify(report,null,2));
  await commitPickupSetup({lc_location_id:c.labcenter_location_id,pick_id:c.customer_id,pick_name:String(c.cartrack.customer_name??""),drop_location_id:drop.labcenter_location_id,drop_id:drop.customer_id,drop_name:String(drop.cartrack.customer_name??""),eta_mins:eta},"client_edit",previous);
  item.status="synced";report.updated++;
}
if (apply && report.updated) await invalidateConfigCache();
await writeFile(file,JSON.stringify(report,null,2));
console.log(JSON.stringify({applied:apply,sourceRows:report.sourceRows,eligible:report.eligible,updated:report.updated,skipped:report.skipped.length}));
