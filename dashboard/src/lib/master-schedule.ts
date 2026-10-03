import { masterEnabled } from "./master-store";
import { sbRpc,sbSelectAll } from "./supabase-rest";
import type { ScheduleJobRow } from "./schedule-job";

export const masterScheduleEnabled=()=>masterEnabled()&&process.env.MASTER_SCHEDULE_SOURCE!=="sheet";
export async function masterScheduleRows():Promise<ScheduleJobRow[]> {
  type Stored={id:number;source_row:number;revision:number;pickup_id:string;dropoff_id:string;driver_id:string|null;
    delivery_window:string;sent_to_driver_before:number;reference:string;days:boolean[];
    pickup:{customer_name:string};dropoff:{customer_name:string};driver:{first_name:string|null;last_name:string|null}|null};
  const rows=await sbSelectAll<Stored>("master_schedule_jobs",
    "select=id,source_row,revision,pickup_id,dropoff_id,driver_id,delivery_window,sent_to_driver_before,reference,days,pickup:master_clients!pickup_id(customer_name),dropoff:master_clients!dropoff_id(customer_name),driver:master_drivers!driver_id(first_name,last_name)&active=eq.true","source_row.asc,id.asc");
  return rows.map(r=>({rowIndex:r.source_row,schedule_id:r.id,revision:r.revision,
    pickup_id:r.pickup_id,pickup_name:r.pickup.customer_name,dropoff_id:r.dropoff_id,dropoff_name:r.dropoff.customer_name,
    driver_id:r.driver_id??"",driver_name:r.driver?`${r.driver.first_name??""} ${r.driver.last_name??""}`.trim():"",
    delivery_window:r.delivery_window.slice(0,5),sent_to_driver_before:r.sent_to_driver_before,reference:r.reference,days:r.days}));
}
export const writeMasterSchedule=(item:Record<string,unknown>)=>sbRpc<{id:number;revision:number;row:number}>("master_write_schedule",{item});
