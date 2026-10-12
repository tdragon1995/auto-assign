import { NextRequest, NextResponse } from "next/server";
import type { Env } from "@/lib/cartrack";
import { sbPatch, sbUpsert } from "@/lib/supabase-rest";
import { check3plHandoff, complete3plHandoff } from "@/lib/three-pl-handoff";
import { RIDE_HAIL_ADMINS, RIDE_HAIL_PROVIDERS, type RideHailTrip } from "@/lib/ride-hail";

// ── /api/admin/ride-hail — "Gửi xe công nghệ" in Điều chỉnh job ──────────────
// POST {job_id, provider, amount_vnd, waybill, admin_name}: the same handoff as the
//   branch's /qr button (3PL proxy driver, codes as tracking numbers, completed),
//   plus a ride_hail_trips row. The row is written BEFORE the Cartrack write and
//   upserted on job_id, so a failed handoff is retried by sending again, never
//   recorded twice.
// PATCH {job_id, amount_vnd}: correct the amount afterwards.

const err = (error: string, status: number) => NextResponse.json({ error }, { status });
const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => list.includes(v as T);

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  try {
    const b = await req.json();
    const jobId = Number(b.job_id);
    const amount = Number(b.amount_vnd);
    const waybill = String(b.waybill ?? "").trim();
    if (!Number.isInteger(jobId) || jobId <= 0) return err("Job ID không hợp lệ", 400);
    if (!isOneOf(RIDE_HAIL_PROVIDERS, b.provider)) return err("Chọn hãng xe", 400);
    if (!Number.isSafeInteger(amount) || amount <= 0) return err("Số tiền không hợp lệ", 400);
    if (!waybill) return err("Nhập mã vận đơn", 400);
    if (!isOneOf(RIDE_HAIL_ADMINS, b.admin_name)) return err("Chọn người gửi", 400);

    const job = await check3plHandoff(jobId, env);
    if (!job.ok) return err(job.error, job.status);

    await sbUpsert("ride_hail_trips", [{
      job_id: jobId,
      provider: b.provider,
      amount_vnd: amount,
      waybill,
      admin_name: b.admin_name,
      pickup_name: job.pickup?.customer_name ?? null,
      dropoff_name: job.dropoff?.customer_name ?? null,
      updated_at: new Date().toISOString(),
    }], "job_id");

    // The update REPLACES the job's items, so carry any batch codes already on it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const batches: string[] = (job.data?.items ?? []).map((it: any) => String(it?.tracking_number ?? "").trim())
      .filter((t: string) => t && t !== waybill);
    const done = await complete3plHandoff(job, [
      ...batches.map((t) => ({ description: "🧪 Mẫu", tracking_number: t })),
      { description: `🚕 ${b.provider}`, tracking_number: waybill },
    ], env);
    if (!done.ok) return err(`Đã lưu, nhưng ${done.error.toLowerCase()} — bấm gửi lại`, done.status);

    await sbPatch("ride_hail_trips", `job_id=eq.${jobId}`, { completed_at: new Date().toISOString() });
    return NextResponse.json({ success: true });
  } catch (e) {
    return err(String(e), 500);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const b = await req.json();
    const jobId = Number(b.job_id);
    const amount = Number(b.amount_vnd);
    if (!Number.isInteger(jobId) || jobId <= 0) return err("Job ID không hợp lệ", 400);
    if (!Number.isSafeInteger(amount) || amount <= 0) return err("Số tiền không hợp lệ", 400);
    const rows = await sbPatch<RideHailTrip>("ride_hail_trips", `job_id=eq.${jobId}`, {
      amount_vnd: amount,
      updated_at: new Date().toISOString(),
    });
    if (!rows.length) return err("Job này chưa gửi xe công nghệ", 404);
    return NextResponse.json(rows[0]);
  } catch (e) {
    return err(String(e), 500);
  }
}
