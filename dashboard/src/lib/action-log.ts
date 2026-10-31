import { UUID } from "./master-reconcile";
import { sbInsert, sbSelect } from "./supabase-rest";
import { cartrackHistoryCutoff } from "./time";

/** Audit trails kept in Supabase `master_action_logs`, one action name per log.
 *  Rows older than Cartrack's history cutoff are dropped; a driver id that is not
 *  in the master roster is stored as null rather than refused. */
async function appendLogRows(title: string, headers: string[], rows: (string | number | null)[][]): Promise<void> {
  const retained=rows.filter(r=>String(r[0]).slice(0,10)>=cartrackHistoryCutoff());
  if(!retained.length)return;
  const ids=[...new Set(retained.map(r=>String(r[2]??"")).filter(id=>UUID.test(id)))];
  const linked=new Set(ids.length?(await sbSelect<{driver_id:string}>("master_drivers",`select=driver_id&driver_id=in.(${ids.join(",")})`)).map(r=>r.driver_id):[]);
  const records=retained.map(r=>({
    action:title,occurred_at:String(r[0]).replace(" ","T")+"+07:00",driver_id:linked.has(String(r[2]))?r[2]:null,job_id:r[3]||null,
    details:Object.fromEntries(headers.map((h,i)=>[h,r[i]??null]))}));
  await sbInsert("master_action_logs",records);
}

// ── Nhận Việc (driver self-claim) audit log ──────────────────────────────────

const NV_LOG_ACTION = "Nhận Việc Log";
const NV_LOG_HEADERS = [
  "Thời gian", "Tài xế", "driver_id", "Job ID", "Mã đơn",
  "Điểm lấy", "Điểm giao", "Tài xế trước đó", "Trạng thái lấy hàng",
];

/** Append one audit row for a successful driver self-claim. Order matches
 *  NV_LOG_HEADERS. Caller should treat this as best-effort (don't fail the claim
 *  if it throws). */
export async function appendNhanViecLog(row: (string | number | null)[]): Promise<void> {
  await appendLogRows(NV_LOG_ACTION, NV_LOG_HEADERS, [row]);
}

// ── Geofence bypass log ("Mở geofence 5 phút" in Điều chỉnh job) ──────────
// "Loại" is Lấy mẫu while the pickup stop is not yet completed, Giao mẫu once it is;
// "Điểm mở" is the stop that stage points at.

const GF_LOG_ACTION = "Mở Geofence Log";
const GF_LOG_HEADERS = [
  "Thời gian", "Tài xế", "driver_id", "Job ID", "Mã đơn",
  "Loại", "Điểm mở", "Điểm lấy", "Điểm giao", "Mở đến",
];

/** Rows in GF_LOG_HEADERS order, queued in Redis and flushed by the assign cron. */
export async function appendGeofenceLog(rows: (string | number | null)[][]): Promise<void> {
  await appendLogRows(GF_LOG_ACTION, GF_LOG_HEADERS, rows);
}

