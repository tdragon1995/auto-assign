import type { MasterClient, MasterDriver, MasterRule } from "./master-store";

const pick = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map(k=>[k,value[k]]));
/** Explicit allowlists keep Cartrack tokens and raw private payloads off list responses. */
export function publicDriver(d: MasterDriver) {
  return { driver_id:d.driver_id,driver_zalo_id:d.driver_zalo_id,phone_number_update:d.phone_number_update,
    has_bot_token:!!d.bot_token,
    roster:pick(d.roster??{},["Driver","employee_code","employee_full_name","code_name"]),
    cartrack:pick(d.cartrack,["first_name","last_name","email","phone_code","phone_number","is_active",
      "shift_time_start","shift_time_end","start_location_customer_id","end_location_customer_id"]) };
}
export function publicClient(c: MasterClient) {
  const fields=["customer_id","client_code","new_ward","nearest_psc_id","nearest_psc_name","nearest_psc_km",
    "labcenter_location_id","default_dropoff_id","default_dropoff_name","eta_minutes","sales_name","sales_email","supervisor_name","supervisor_email"];
  return { ...pick(c as unknown as Record<string,unknown>,fields),cartrack:pick(c.cartrack,["customer_name","address_line_1",
    "address_line_2","latitude","longitude","contact_number","email","postal_code","client_reference","is_active","create_ts","update_ts"]) };
}
export function publicRule(r: MasterRule) {
  const {bot_token,chat_id,...row_data}=r.row_data;
  return {...r,row_data,has_bot_token:!!bot_token,has_chat_id:!!chat_id};
}
