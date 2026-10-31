import { NextRequest, NextResponse } from "next/server";
import { UUID } from "@/lib/master-reconcile";
import { sbSelect } from "@/lib/supabase-rest";
import { writeMasterSchedule } from "@/lib/master-schedule";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

type Body = {
  schedule_id?:number;
  revision?:number;
  pickup_id?: string;
  dropoff_id?: string;
  delivery_window?: string;
  reference?: string;
  sent_to_driver_before?: number | string;
  days?: boolean[];
  driver_id?: string;
};

type ScheduleWrite = {
  pickup_id: string; dropoff_id: string; driver_id: string; delivery_window: string;
  reference: string; sent_to_driver_before: number; days: boolean[];
};

/** Validate + normalise a dashboard form body. Returns an error string for
 *  anything the user must fix. */
async function toRow(body: Body): Promise<ScheduleWrite | string> {
  const pickup_id = (body.pickup_id ?? "").trim();
  const dropoff_id = (body.dropoff_id ?? "").trim();
  const reference = (body.reference ?? "").trim();
  const window = (body.delivery_window ?? "").trim();
  if (!pickup_id) return "Thiếu điểm lấy (pickup_id)";
  if (!dropoff_id) return "Thiếu điểm giao (dropoff_id)";
  if (pickup_id === dropoff_id) return "Điểm lấy và điểm giao trùng nhau";
  if (!reference) return "Thiếu reference";
  const m = TIME_RE.exec(window);
  if (!m) return `Giờ lấy không hợp lệ: "${window}" (HH:MM)`;
  const before = Number(body.sent_to_driver_before ?? 60);
  if (!Number.isInteger(before) || before < 0 || before > 720)
    return "Gửi trước (phút) phải là số nguyên 0–720";
  if (!Array.isArray(body.days) || body.days.length !== 7) return "Thiếu ngày trong tuần";
  if(!UUID.test(pickup_id)||!UUID.test(dropoff_id)) return "ID địa điểm không hợp lệ";
  const locations=await sbSelect<{customer_id:string;customer_name:string;is_active:boolean}>("master_clients",
    `select=customer_id,customer_name,is_active&customer_id=in.(${pickup_id},${dropoff_id})`);
  const from=locations.find(l=>l.customer_id===pickup_id),to=locations.find(l=>l.customer_id===dropoff_id);
  if(!from?.customer_name||!to?.customer_name) return "Địa điểm không có trong Master Client Info";
  if(from.is_active===false||to.is_active===false) return "Không thể chọn địa điểm đã ngừng hoạt động";

  // Read fresh, not from a cached roster.
  const driver_id = (body.driver_id ?? "").trim();
  if (driver_id) {
    if(!UUID.test(driver_id)) return "ID tài xế không hợp lệ";
    const [found]=await sbSelect<{is_active:boolean}>("master_drivers",`select=is_active&driver_id=eq.${driver_id}`);
    if(!found||found.is_active===false) return "Tài xế không có trong Master Client Info (hoặc đã ngưng hoạt động)";
  }

  return {
    pickup_id,
    dropoff_id,
    driver_id,
    delivery_window: `${m[1].padStart(2, "0")}:${m[2]}`,
    reference,
    sent_to_driver_before: before,
    days: body.days.map(Boolean),
  };
}

const validVersion = (body: Body) =>
  Number.isSafeInteger(body.schedule_id) && Number(body.schedule_id) >= 1 && Number.isSafeInteger(body.revision) && Number(body.revision) >= 1;

async function handle(req: NextRequest, mode: "add" | "edit") {
  const bad = (msg: string) => NextResponse.json({ ok: false, error: msg }, { status: 400 });
  try {
    const body = (await req.json().catch(() => null)) as Body | null;
    if (!body || typeof body !== "object") return bad("Body không hợp lệ");
    const row = await toRow(body);
    if (typeof row === "string") return bad(row);
    if (mode === "edit" && !validVersion(body)) return bad("Thiếu ID / phiên bản lịch — tải lại danh sách");
    const saved=await writeMasterSchedule({...(mode==="edit"?{id:body.schedule_id,revision:body.revision}:{}),...row});
    return NextResponse.json({ok:true,...saved,warning:null});
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

/** Edits use schedule_id + revision. Optional driver_id pre-assigns a job when released. */
export async function POST(req: NextRequest) {
  return handle(req, "add");
}

export async function PUT(req: NextRequest) {
  return handle(req, "edit");
}

/** Soft-delete by ID/revision. */
export async function DELETE(req: NextRequest) {
  const bad = (msg: string) => NextResponse.json({ ok: false, error: msg }, { status: 400 });
  try {
    const body = (await req.json().catch(() => null)) as Body | null;
    if (!body || !validVersion(body)) return bad("Thiếu ID / phiên bản lịch — tải lại danh sách");
    const saved=await writeMasterSchedule({id:body.schedule_id,revision:body.revision,active:false});
    return NextResponse.json({ok:true,...saved});
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
