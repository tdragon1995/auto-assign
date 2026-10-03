import { NextRequest, NextResponse } from "next/server";
import { loadDriversFromSheet } from "@/lib/config";
import { masterEnabled } from "@/lib/master-store";
import { UUID } from "@/lib/master-reconcile";
import { sbSelect } from "@/lib/supabase-rest";
import { masterScheduleEnabled,writeMasterSchedule } from "@/lib/master-schedule";
import {
  appendScheduleRow,
  updateScheduleRow,
  deleteScheduleRow,
  ScheduleWriteError,
  type ScheduleRowWrite,
} from "@/lib/sheets-writer";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

type Body = {
  schedule_id?:number;
  revision?:number;
  rowIndex?: number;
  original?: { reference?: string; pickup_id?: string };
  pickup_id?: string;
  pickup_name?: string;
  dropoff_id?: string;
  dropoff_name?: string;
  delivery_window?: string;
  reference?: string;
  sent_to_driver_before?: number | string;
  days?: boolean[];
  driver_id?: string;
};

/** Validate + normalise a dashboard form body into the sheet row shape.
 *  Returns an error string for anything the user must fix. */
async function toRow(body: Body): Promise<ScheduleRowWrite | string> {
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
  let pickup=(body.pickup_name??"").trim(),dropoff=(body.dropoff_name??"").trim();
  if(masterEnabled()) {
    if(!UUID.test(pickup_id)||!UUID.test(dropoff_id)) return "ID địa điểm không hợp lệ";
    const locations=await sbSelect<{customer_id:string;customer_name:string;is_active:boolean}>("master_clients",
      `select=customer_id,customer_name,is_active&customer_id=in.(${pickup_id},${dropoff_id})`);
    const from=locations.find(l=>l.customer_id===pickup_id),to=locations.find(l=>l.customer_id===dropoff_id);
    if(!from?.customer_name||!to?.customer_name) return "Địa điểm không có trong Master Client Info";
    if(from.is_active===false||to.is_active===false) return "Không thể chọn địa điểm đã ngừng hoạt động";
    pickup=from.customer_name;dropoff=to.customer_name;
  }

  // Validate against the active profile source, without a cached roster in Master mode.
  let driver = "";
  const driver_id = (body.driver_id ?? "").trim();
  if (driver_id) {
    if(masterEnabled()) {
      if(!UUID.test(driver_id)) return "ID tài xế không hợp lệ";
      const [found]=await sbSelect<{first_name:string|null;last_name:string|null;is_active:boolean}>("master_drivers",
        `select=first_name,last_name,is_active&driver_id=eq.${driver_id}`);
      if(!found||found.is_active===false) return "Tài xế không có trong Master Client Info (hoặc đã ngưng hoạt động)";
      driver=`${found.first_name??""} ${found.last_name??""}`.trim()||driver_id;
    } else {
      const found = (await loadDriversFromSheet()).find((d) => d.driver_id === driver_id);
      if (!found) return "Tài xế không có trong tab Driver (hoặc đã ngưng hoạt động)";
      driver = found.name;
    }
  }

  return {
    pickup_id,
    pickup,
    dropoff_id,
    dropoff,
    delivery_windows: `${m[1].padStart(2, "0")}:${m[2]}`,
    reference,
    sent_to_driver_before: before,
    days: body.days.map(Boolean),
    driver,
    driver_id,
  };
}

async function handle(req: NextRequest, mode: "add" | "edit") {
  const bad = (msg: string) => NextResponse.json({ ok: false, error: msg }, { status: 400 });
  try {
    const body = (await req.json().catch(() => null)) as Body | null;
    if (!body || typeof body !== "object") return bad("Body không hợp lệ");
    const row = await toRow(body);
    if (typeof row === "string") return bad(row);
    if(masterScheduleEnabled()) {
      if(mode==="edit" && (!Number.isSafeInteger(body.schedule_id)||Number(body.schedule_id)<1||!Number.isSafeInteger(body.revision)||Number(body.revision)<1))
        return bad("Thiếu ID / phiên bản lịch — tải lại danh sách");
      const saved=await writeMasterSchedule({...(mode==="edit"?{id:body.schedule_id,revision:body.revision}:{}),
        pickup_id:row.pickup_id,dropoff_id:row.dropoff_id,driver_id:row.driver_id,delivery_window:row.delivery_windows,
        reference:row.reference,sent_to_driver_before:row.sent_to_driver_before,days:row.days});
      return NextResponse.json({ok:true,...saved,warning:null});
    }

    if (mode === "add") {
      const res = await appendScheduleRow(row);
      return NextResponse.json({ ok: true, row: res.row, warning: res.warning ?? null });
    }
    if (!body.rowIndex || !body.original?.reference || body.original.pickup_id == null)
      return bad("Thiếu rowIndex / original");
    const res = await updateScheduleRow(
      { rowIndex: body.rowIndex, reference: body.original.reference, pickup_id: body.original.pickup_id },
      row,
    );
    return NextResponse.json({ ok: true, row: res.row, warning: res.warning ?? null });
  } catch (e) {
    if (e instanceof ScheduleWriteError) return bad(e.message);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

/** Supabase edits use schedule_id + revision; the retained Sheet backend uses
 * rowIndex + original. Optional driver_id pre-assigns a job when released. */
export async function POST(req: NextRequest) {
  return handle(req, "add");
}

export async function PUT(req: NextRequest) {
  return handle(req, "edit");
}

/** Soft-delete by ID/revision in Supabase; legacy Sheet edits retain their guard. */
export async function DELETE(req: NextRequest) {
  const bad = (msg: string) => NextResponse.json({ ok: false, error: msg }, { status: 400 });
  try {
    const body = (await req.json().catch(() => null)) as Body | null;
    if(masterScheduleEnabled()) {
      if(!body||!Number.isSafeInteger(body.schedule_id)||Number(body.schedule_id)<1||!Number.isSafeInteger(body.revision)||Number(body.revision)<1)
        return bad("Thiếu ID / phiên bản lịch — tải lại danh sách");
      const saved=await writeMasterSchedule({id:body.schedule_id,revision:body.revision,active:false});
      return NextResponse.json({ok:true,...saved});
    }
    if (!body?.rowIndex || !body.original?.reference || body.original.pickup_id == null)
      return bad("Thiếu rowIndex / original");
    const res = await deleteScheduleRow({
      rowIndex: body.rowIndex,
      reference: body.original.reference,
      pickup_id: body.original.pickup_id,
    });
    return NextResponse.json({ ok: true, row: res.row });
  } catch (e) {
    if (e instanceof ScheduleWriteError) return bad(e.message);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
