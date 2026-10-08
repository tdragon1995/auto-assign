/**
 * "Cập nhật công" for supervisors — the Lương PT tab's review list.
 *
 *   GET  ?month=YYYY-MM   every request in that payroll period, newest first, each
 *                         with the day's EVIDENCE beside it: Lịch ca shift, the
 *                         check-in/out taps, the first pickup and last dropoff, the
 *                         hours the rule computes, and the hours requested.
 *   POST {action:"approve"|"reject", id, note}
 *        {action:"create", driver_id, date, in_time, out_time, note}
 *                         a supervisor's own correction — approved at once.
 *
 * EVIDENCE, NOT GPS. No GPS trail is kept anywhere (Cartrack gives only a driver's
 * current position); what the day does have is every completed stop with its time
 * and place. A "forgot to tap" request whose hours sit inside the day's first and
 * last stop is consistent with the record; one that reaches far outside it is
 * what a reviewer should look at — `outside_mins` says by how much.
 *
 * Same auth posture as /api/pay/team (the dashboard has none); see that route.
 * Approving changes pay: it is the one write here that matters.
 */
import { NextRequest, NextResponse } from "next/server";
import { sbInsert, sbPatch, sbSelectAll, supabaseConfigured } from "@/lib/supabase-rest";
import { masterDriverNames } from "@/lib/master-store";
import { payrollPeriod } from "@/lib/pay-period";
import { loadPayDayInputs, dayKey } from "@/lib/pay-days";
import { workedMinutes, punchAt, type PayPunch } from "@/lib/pay";
import { checkTimes } from "@/lib/pay-corrections";
import { vnDate, cartrackHistoryCutoff } from "@/lib/time";

export const runtime = "nodejs";
export const maxDuration = 30;
export const preferredRegion = "sin1";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false });
const hhmm = (iso: string | null | undefined) => (iso ? timeFmt.format(new Date(iso)) : null);
const mins = (t: string | null) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);

export async function GET(req: NextRequest) {
  if (!supabaseConfigured()) return NextResponse.json({ ok: false, error: "Chưa cấu hình hệ thống lưu trữ." }, { status: 503 });
  const month = req.nextUrl.searchParams.get("month") ?? vnDate().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return NextResponse.json({ ok: false, error: "month phải có dạng YYYY-MM" }, { status: 400 });
  const { from, to } = payrollPeriod(month);

  try {
    const inputs = await loadPayDayInputs(from, to);
    const reqs = inputs.corrections.filter((c) => c.status !== "withdrawn").sort((a, b) => b.id - a.id);
    const ids = [...new Set(reqs.map((c) => c.driver_id))];
    if (ids.length === 0) return NextResponse.json({ ok: true, month, from, to, corrections: [] });

    const inList = `driver_id=in.(${ids.join(",")})&trip_date=gte.${from}&trip_date=lte.${to}`;
    const [punches, daily, names] = await Promise.all([
      sbSelectAll<PayPunch>("pay_punches", `select=*&${inList}`, "id.asc"),
      sbSelectAll<{ driver_id: string; trip_date: string; jobs_total: number; first_pickup_ts: string | null; last_dropoff_ts: string | null }>(
        "v_pay_daily", `select=driver_id,trip_date,jobs_total,first_pickup_ts,last_dropoff_ts&${inList}`, "trip_date.asc,driver_id.asc"),
      masterDriverNames(ids),
    ]);
    const punchesBy = new Map<string, PayPunch[]>();
    for (const p of punches) {
      const k = dayKey(p.driver_id, p.trip_date);
      const l = punchesBy.get(k); if (l) l.push(p); else punchesBy.set(k, [p]);
    }
    const dayBy = new Map(daily.map((d) => [dayKey(d.driver_id, d.trip_date), d]));

    const corrections = reqs.map((c) => {
      const k = dayKey(c.driver_id, c.trip_date);
      const taps = punchesBy.get(k) ?? [];
      const d = dayBy.get(k);
      const shifts = inputs.shifts.get(k) ?? [];
      // What the rule pays WITHOUT any correction — the "before" of the decision.
      const rule = workedMinutes(taps, { date: c.trip_date, shifts, firstTaskAt: d?.first_pickup_ts ?? null, lastTaskAt: d?.last_dropoff_ts ?? null });
      const first = hhmm(d?.first_pickup_ts), last = hhmm(d?.last_dropoff_ts);
      const inT = c.in_time.slice(0, 5), outT = c.out_time.slice(0, 5);
      // Minutes of the requested window that fall outside the day's first→last
      // stop. Null when there were no stops to compare against.
      const outside = first && last
        ? Math.max(0, mins(first)! - mins(inT)!) + Math.max(0, mins(outT)! - mins(last)!)
        : null;
      return {
        id: c.id, driver_id: c.driver_id,
        driver_name: names.get(c.driver_id) || c.driver_name || c.driver_id.slice(0, 8),
        date: c.trip_date, reason: c.reason, source: c.source, status: c.status,
        in_time: inT, out_time: outT, note: c.note, proof_urls: c.proof_urls,
        decision_note: c.decision_note, created_at: c.created_at, decided_at: c.decided_at,
        requested_mins: mins(outT)! - mins(inT)!,
        evidence: {
          shifts,
          taps: taps
            .map((p) => ({ kind: p.kind, at: hhmm(p.arrived_ts ?? p.started_ts ?? punchAt(p)), place: p.location_name }))
            .filter((t) => t.at)
            .sort((a, b) => a.at!.localeCompare(b.at!)),
          trips: d?.jobs_total ?? 0,
          first_stop: first,
          last_stop: last,
          rule_mins: rule.clocked,
          outside_mins: outside,
        },
      };
    });
    return NextResponse.json({ ok: true, month, from, to, corrections });
  } catch (e) {
    console.error("[pay/corrections] GET error:", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, error: "Không tải được danh sách cập nhật công." }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  if (!supabaseConfigured()) return NextResponse.json({ ok: false, error: "Chưa cấu hình hệ thống lưu trữ." }, { status: 503 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const note = typeof body?.note === "string" ? body.note.slice(0, 500) : "";
  const now = new Date().toISOString();

  try {
    if (body?.action === "approve" || body?.action === "reject") {
      const id = Number(body.id);
      if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ ok: false, error: "Yêu cầu không hợp lệ." }, { status: 400 });
      if (body.action === "reject" && !note.trim()) {
        return NextResponse.json({ ok: false, error: "Ghi lý do từ chối để tài xế biết." }, { status: 400 });
      }
      // Only a PENDING request can be decided — a stale screen gets a refusal,
      // not a second decision on top of the first.
      const rows = await sbPatch("pay_day_corrections", `id=eq.${id}&status=eq.pending`, {
        status: body.action === "approve" ? "approved" : "rejected", decision_note: note, decided_at: now,
      });
      if (rows.length === 0) return NextResponse.json({ ok: false, error: "Yêu cầu đã được xử lý hoặc đã được thay thế — tải lại." }, { status: 409 });
      return NextResponse.json({ ok: true });
    }

    if (body?.action === "create") {
      const driverId = String(body.driver_id ?? "");
      if (!UUID.test(driverId)) return NextResponse.json({ ok: false, error: "Chọn tài xế." }, { status: 400 });
      const input = { date: body.date as string, in_time: body.in_time as string, out_time: body.out_time as string, note };
      const bad = checkTimes(input, vnDate(), { anyPastDay: true });
      if (bad) return NextResponse.json({ ok: false, error: bad }, { status: 400 });
      if (input.date < cartrackHistoryCutoff()) return NextResponse.json({ ok: false, error: "Ngày đã ngoài kỳ lưu dữ liệu." }, { status: 400 });
      if (!note.trim()) return NextResponse.json({ ok: false, error: "Ghi lý do điều chỉnh." }, { status: 400 });

      const name = (await masterDriverNames([driverId])).get(driverId) ?? null;
      // A supervisor's correction answers any open request for the day.
      await sbPatch("pay_day_corrections", `driver_id=eq.${driverId}&trip_date=eq.${input.date}&status=eq.pending`, {
        status: "rejected", decision_note: "Thay bằng điều chỉnh của quản lý.", decided_at: now,
      });
      await sbInsert("pay_day_corrections", [{
        driver_id: driverId, driver_name: name, trip_date: input.date,
        in_time: input.in_time, out_time: input.out_time, reason: "supervisor", note,
        source: "supervisor", status: "approved", decided_at: now,
      }]);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "Thao tác không hợp lệ." }, { status: 400 });
  } catch (e) {
    console.error("[pay/corrections] POST error:", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, error: "Không lưu được. Thử lại sau." }, { status: 502 });
  }
}
