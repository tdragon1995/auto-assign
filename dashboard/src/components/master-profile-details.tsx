import { BadgeCheck, Clock3, Hash, Mail, MapPin, MessageCircle, Navigation, Phone, Route, ShieldCheck, UserRound, Users, Warehouse, type LucideIcon } from "lucide-react";
import { staffCode } from "@/lib/display-names";
import { isInactiveLocation } from "@/lib/location-status";
import type { DriverShift } from "@/lib/driver-shifts";
import type { PickupVolume } from "@/lib/pickup-setup";

export type ClientMeta = {
  customer_id: string; cartrack: Record<string, unknown>;
  client_code: string | null; new_ward: string | null;
  nearest_psc_name: string | null; nearest_psc_km: number | null;
  default_dropoff_name: string | null; eta_minutes: number | null;
  default_dropoff_id: string | null; labcenter_location_id: number | null;
  sales_name: string | null; sales_email: string | null;
  supervisor_name: string | null; supervisor_email: string | null;
  pickup_volume?: PickupVolume | null;
};
export type DriverMeta = {
  driver_id: string; cartrack: Record<string, unknown>; roster: Record<string, unknown>;
  driver_zalo_id: string | null; phone_number_update: string | null; has_bot_token: boolean;
  shift_date?:string; work_shifts?:DriverShift[]|null;
};

const text = (v: unknown): string => {
  const s = v == null ? "" : String(v).trim();
  return /^[-–—]+$/.test(s) ? "" : s;
};
const join = (values: unknown[], separator = " · ") => values.map(text).filter(Boolean).join(separator);
type Detail = [LucideIcon, string, string];

export function MasterProfileDetails({ client, driver, clients }: {
  client?: ClientMeta | null; driver?: DriverMeta | null; clients: Map<string, ClientMeta>;
}) {
  let groups: Detail[][] = [];
  if (client) {
    const c = client.cartrack;
    const gps = text(c.latitude) && text(c.longitude) && Number.isFinite(Number(c.latitude)) && Number.isFinite(Number(c.longitude))
      && Math.abs(Number(c.latitude)) <= 90 && Math.abs(Number(c.longitude)) <= 180 ? `${Number(c.latitude)}, ${Number(c.longitude)}` : "";
    groups = [
      [[MapPin, "Địa chỉ", text(c.address_line_1)], [MessageCircle, "Lưu ý", text(c.address_line_2)],
        [Navigation, "Phường mới", text(client.new_ward)], [MapPin, "GPS", gps]],
      [[Phone, "Điện thoại", text(c.contact_number)], [Mail, "Email", text(c.email)]],
      [[Route, "PSC gần nhất", text(client.nearest_psc_name) ? `${client.nearest_psc_name}${client.nearest_psc_km == null ? "" : ` · ${client.nearest_psc_km.toFixed(1)} km`}` : ""],
        [Warehouse, "Điểm giao mặc định", text(client.default_dropoff_name)],
        [Clock3, "ETA", client.eta_minutes == null ? "" : `${client.eta_minutes} phút`]],
      [[Hash, "Lượt lấy mẫu hoàn thành", client.pickup_volume ? Number(client.pickup_volume.total_pickups).toLocaleString("vi-VN") : "Chưa có thống kê"],
        [Route, "Trung bình / ngày", client.pickup_volume ? `${Number(client.pickup_volume.average_per_day).toLocaleString("vi-VN", { maximumFractionDigits: 2 })} lượt` : ""],
        [Clock3, "Khoảng thống kê", client.pickup_volume ? `${client.pickup_volume.period_from} → ${client.pickup_volume.period_to}\n${client.pickup_volume.calendar_days} ngày lịch, gồm ngày không có lượt lấy mẫu` : ""]],
      [[Hash, "Mã khách hàng", text(client.client_code)], [Hash, "Mã tham chiếu", text(c.client_reference)], [MapPin, "Mã bưu chính", text(c.postal_code)],
        [UserRound, "Sales phụ trách", join([client.sales_name, client.sales_email], "\n")],
        [Users, "Supervisor", join([client.supervisor_name, client.supervisor_email], "\n")]],
      [[Hash, "Customer ID (Cartrack)", text(client.customer_id)],
        [ShieldCheck, "Trạng thái", isInactiveLocation(c.customer_name) ? "Ngừng hoạt động" : "Hoạt động"],
        [Clock3, "Ngày tạo (Cartrack)", text(c.create_ts)],
        [Clock3, "Cập nhật (Cartrack)", text(c.update_ts)]],
    ];
  } else if (driver) {
    const c = driver.cartrack;
    const location = (id: unknown) => text(clients.get(text(id))?.cartrack.customer_name) || text(id);
    const start = /^(\d{1,2}:\d{2})/.exec(text(c.shift_time_start))?.[1];
    const end = /^(\d{1,2}:\d{2})/.exec(text(c.shift_time_end))?.[1];
    const active = c.is_active === true || c.is_active === 1 || c.is_active === "1" ? "Hoạt động"
      : c.is_active === false || c.is_active === 0 || c.is_active === "0" ? "Ngừng hoạt động" : "";
    const duty=driver.work_shifts==null ? "Không đọc được lịch ca; bấm Tải lại để thử lại" : !driver.work_shifts.length ? "Chưa có ca được lưu" : driver.work_shifts.map(s=>{
      const window=s.day_type==="working" && s.start_time && s.end_time ? `${s.start_time.slice(0,5)}–${s.end_time.slice(0,5)}` : s.day_type==="holiday" ? `Nghỉ lễ${s.holiday_name ? ` · ${s.holiday_name}` : ""}` : "Nghỉ";
      return join([window,s.source,s.leave_start && s.leave_end ? `Nghỉ phép ${s.leave_start.slice(0,5)}–${s.leave_end.slice(0,5)}` : "",s.leave_gap ? "Cần kiểm tra nghỉ phép" : ""]);
    }).join("\n");
    const dutyDate=driver.shift_date?.split("-").reverse().join("/");
    groups = [
      [[Clock3, `Ca làm${dutyDate ? ` · ${dutyDate}` : ""} (giờ VN)`, duty]],
      [[Phone, "Điện thoại", text(c.phone_number) ? join([c.phone_code, c.phone_number], " ") : ""],
        [Phone, "Điện thoại thay thế", text(driver.phone_number_update)], [Mail, "Email", text(c.email)]],
      [[Clock3, "Ca hồ sơ Cartrack (giờ VN)", start && end ? `${start}–${end}` : start ? `Từ ${start}` : end ? `Đến ${end}` : ""],
        [Navigation, "Điểm xuất phát", location(c.start_location_customer_id)], [Warehouse, "Điểm kết thúc", location(c.end_location_customer_id)]],
      [[BadgeCheck, "Mã nhân viên", staffCode(String(c.first_name ?? "")) || text(driver.roster.employee_code)], [UserRound, "Tên nhân viên", text(driver.roster.employee_full_name)],
        [ShieldCheck, "Trạng thái", active]],
      [[MessageCircle, "Zalo ID", text(driver.driver_zalo_id)], [MessageCircle, "Thông báo Zalo", driver.has_bot_token ? "Đã lưu token" : ""]],
    ];
  }
  const visible = groups.map(group => group.filter(([, , value]) => value)).filter(group => group.length);
  if (!visible.length) return <p className="py-3 text-sm leading-6 text-slate-600">Chưa có thông tin bổ sung. Chọn Sửa hồ sơ để cập nhật.</p>;
  return <div className="divide-y divide-slate-200">
    {visible.map((group, i) => <dl key={i} className="space-y-3 py-3 first:pt-0 last:pb-0">
      {group.map(([Icon, label, value]) => <div key={label} className="relative min-w-0 pl-7">
        <dt className="text-xs leading-4 text-slate-600"><Icon aria-hidden="true" strokeWidth={1.75} className="absolute left-0 top-0.5 size-4 text-slate-500" />{label}</dt>
        <dd className="mt-0.5 whitespace-pre-line text-[13px] leading-5 text-slate-900 [overflow-wrap:anywhere]">{value}</dd>
      </div>)}
    </dl>)}
  </div>;
}
