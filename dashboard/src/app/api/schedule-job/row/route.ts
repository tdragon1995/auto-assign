import { NextRequest, NextResponse } from "next/server";
import { loadDriversFromSheet } from "@/lib/config";
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

  // Pre-assign driver: must come from the Driver tab so the name/id pair on the
  // sheet is one Cartrack accepts (deactivated accounts are already excluded).
  let driver = "";
  const driver_id = (body.driver_id ?? "").trim();
  if (driver_id) {
    const found = (await loadDriversFromSheet()).find((d) => d.driver_id === driver_id);
    if (!found) return "Tài xế không có trong tab Driver (hoặc đã ngưng hoạt động)";
    driver = found.name;
  }

  return {
    pickup_id,
    pickup: (body.pickup_name ?? "").trim(),
    dropoff_id,
    dropoff: (body.dropoff_name ?? "").trim(),
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

/** POST — add a Lịch cố định row. PUT — edit one (`rowIndex` + `original`
 *  identity from the list, re-checked against the live sheet before writing).
 *  Body fields mirror ScheduleJobRow; `driver_id` (optional) pre-assigns the
 *  job to that driver when it's released from the proxy.
 *  The sheet derives pickup_id / dropoff_id / driver_id by formula from the
 *  NAMES, so names must be the exact Cartrack customer / Driver-tab names;
 *  a mismatch comes back as `warning`. */
export async function POST(req: NextRequest) {
  return handle(req, "add");
}

export async function PUT(req: NextRequest) {
  return handle(req, "edit");
}

/** DELETE — remove a row. Body: { rowIndex, original: { reference, pickup_id } },
 *  re-checked against the live sheet like an edit. */
export async function DELETE(req: NextRequest) {
  const bad = (msg: string) => NextResponse.json({ ok: false, error: msg }, { status: 400 });
  try {
    const body = (await req.json().catch(() => null)) as Body | null;
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
