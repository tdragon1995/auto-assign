import { Redis } from "@upstash/redis";
import { createHash } from "node:crypto";
import { BASE_URL, getHeaders } from "./cartrack";
import { masterClient } from "./master-store";
import { sbUpsert, supabaseConfigured } from "./supabase-rest";
import { staffCode } from "./display-names";
import { isInactiveLocation } from "./location-status";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields=["first_name","last_name","email","phone_code","phone_number","shift_time_start","shift_time_end","start_location_customer_id","end_location_customer_id"];
const local=["driver_zalo_id","phone_number_update","employee_full_name"];
export async function createMasterDriver(requestId:unknown,input:unknown) {
  if(typeof requestId!=="string"||!UUID.test(requestId)||!input||typeof input!=="object"||Array.isArray(input))throw new Error("Yêu cầu tạo tài xế không hợp lệ");
  const draft=input as Record<string,unknown>;
  if(Object.keys(draft).some(k=>![...fields,...local].includes(k)))throw new Error("Trường tài xế không hợp lệ");
  for(const [key,value] of Object.entries(draft))if(value!==null && (typeof value!=="string" || value.length>250))throw new Error(`${key} không hợp lệ`);
  const text=(key:string)=>typeof draft[key]==="string"?draft[key].trim():"";
  if(!text("first_name")||!text("last_name"))throw new Error("Nhập Họ / mã và Tên tài xế");
  if(!/^\d{1,4}$/.test(text("phone_code"))||!/^\d{1,15}$/.test(text("phone_number"))||!Number.isSafeInteger(Number(text("phone_number"))))throw new Error("Mã vùng hoặc số điện thoại không hợp lệ");
  if(text("email") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text("email")))throw new Error("Email không hợp lệ");
  for(const key of ["shift_time_start","shift_time_end"])if(text(key)&&!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d\+07:00$/.test(text(key)))throw new Error("Ca tài xế không hợp lệ");
  if(!!text("shift_time_start")!==!!text("shift_time_end"))throw new Error("Nhập đủ giờ bắt đầu và kết thúc ca, hoặc để trống cả hai");
  for(const key of ["start_location_customer_id","end_location_customer_id"])if(text(key)) {
    if(!UUID.test(text(key)))throw new Error("Điểm tài xế không hợp lệ");
    const location=await masterClient(text(key));if(!location||isInactiveLocation(location.cartrack.customer_name))throw new Error("Điểm tài xế không tồn tại hoặc đã ngừng hoạt động");
  }
  if(!supabaseConfigured() || !process.env.CARTRACK_AUTH)throw new Error("Chưa cấu hình Cartrack/Supabase");
  const url=process.env.KV_REST_API_URL??process.env.UPSTASH_REDIS_REST_URL,token=process.env.KV_REST_API_TOKEN??process.env.UPSTASH_REDIS_REST_TOKEN;
  if(!url||!token)throw new Error("Chưa cấu hình lưu trạng thái tạo tài xế");
  const db=new Redis({url,token}),key="driver:create:"+requestId;
  const payload=Object.fromEntries(fields.filter(k=>text(k)).map(k=>[k,k==="phone_number"?Number(text(k)):text(k)]));
  const hash=createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(draft).sort(([a],[b])=>a.localeCompare(b))))).digest("hex");
  type State={hash:string;id?:string;done?:boolean};
  let state=await db.get<State>(key);
  if(state && state.hash!==hash)throw new Error("Yêu cầu trước chưa kết thúc; tải lại dữ liệu Cartrack trước khi đổi thông tin");
  if(!state) {
    if(await db.set(key,{hash},{nx:true,ex:7*86400})!=="OK")throw new Error("Đang tạo tài xế; chờ rồi thử lại");
    // Never retry an uncertain POST: Cartrack does not provide an idempotency key.
    const res=await fetch(`${BASE_URL}/drivers`,{method:"POST",headers:getHeaders(),body:JSON.stringify({...payload,is_active:true}),signal:AbortSignal.timeout(20000)}).catch(()=>{throw new Error("Chưa xác định được kết quả tạo trên Cartrack. Đồng bộ Cartrack và kiểm tra trước khi tạo lại để tránh trùng");});
    if(!res.ok) {
      if([400,401,403,422].includes(res.status))await db.del(key);
      throw new Error(`Cartrack tạo tài xế HTTP ${res.status}; chưa gửi lại yêu cầu`);
    }
    const body=await res.json(),profile=body.data??body;
    const id=String(profile.delivery_driver_id??"");
    if(!UUID.test(id))throw new Error("Cartrack đã nhận yêu cầu nhưng không trả về ID; đồng bộ Cartrack để kiểm tra trước khi tạo lại");
    state={hash,id};await db.set(key,state,{ex:7*86400});
  }
  if(!state.id)throw new Error("Chưa xác định được kết quả tạo trước đó. Đồng bộ Cartrack và kiểm tra trước khi tạo lại để tránh trùng");
  if(state.done)return {driver_id:state.id};
  const check=await fetch(`${BASE_URL}/drivers/${state.id}`,{headers:getHeaders(),cache:"no-store",signal:AbortSignal.timeout(15000)});
  if(!check.ok)throw new Error(`Đã tạo Cartrack ID ${state.id}; không đọc lại được (HTTP ${check.status}). Thử lưu lại để đồng bộ Supabase`);
  const profile=(await check.json()).data;
  if(profile?.delivery_driver_id!==state.id||profile.first_name!==text("first_name")||profile.last_name!==text("last_name"))throw new Error("Cartrack trả về hồ sơ không khớp; kiểm tra trước khi tạo lại");
  await sbUpsert("master_drivers",[{driver_id:state.id,cartrack:profile,
    roster:{Driver:`${profile.first_name} ${profile.last_name}`.trim(),employee_code:staffCode(String(profile.first_name)),employee_full_name:text("employee_full_name")||text("last_name")},
    driver_zalo_id:text("driver_zalo_id")||null,phone_number_update:text("phone_number_update")||null,detail_synced_at:new Date().toISOString()}],"driver_id");
  await db.set(key,{...state,done:true},{ex:7*86400});
  return {driver_id:state.id};
}
