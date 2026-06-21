import { NextRequest, NextResponse } from "next/server";
import { getJobsByStatusAndDate, type Env } from "@/lib/cartrack";
import { parseVnTimestamp } from "@/lib/time";
import type { Job, Stop } from "@/lib/types";

// Node runtime + a generous duration: a wide date range fetches day-by-day
// sequentially, and each day can itself paginate several Cartrack calls.
export const runtime = "nodejs";
export const maxDuration = 60;
export const preferredRegion = "sin1";

// job_status_id 5 = Hoàn thành (Completed). Fixed by spec.
const COMPLETED_STATUS = 5;

// Cap the range so one request can't fan out into hundreds of Cartrack calls.
const MAX_DAYS = 62;

// One exported row per completed job. The first 12 fields map 1:1 to the
// downstream Power Query "Export" sheet headers (see the route's response
// `columns`); the rest are extras the query ignores plus the raw coordinates
// the client's distance phase needs.
export interface CompletedRow {
  ft_pt: string;                  // "FT/ PT"            — not derivable; blank
  courier: string;                // "Courier"           — driver first + last
  pickup_from: string;            // "Pickup From"       — stop[0].customer_name
  customer: string;               // "Customer"          — stop[1].customer_name
  order_no: number | "";          // "Order #"           — job_id
  pickup_departure: string;       // "Pickup Departure"  — stop[0].activity_completed_ts
  dropoff_arrival: string;        // "Dropoff Arrival"   — stop[1].activity_arrived_ts
  started_time: string;           // "Started Time"      — stop[0].activity_arrived_ts
  travel_time: number | "";       // "# Travel Time"     — actual mins (arrival − departure)
  target: number | "";            // "# Target"          — Goong mins (filled client-side)
  distance_target: number | "";   // "# Distance Target" — Goong km (filled client-side)
  pass_fail: string;              // "Pass/ Fail"        — Pass when travel ≤ target (client)
  // Extras (kept from the first spec — Power Query ignores unlisted columns).
  device_description: string;
  pickup_coords: string;          // "lat,long"
  dropoff_coords: string;
  // Raw coordinates for the client's distance lookup (not emitted to CSV).
  lat1: number | null;
  lon1: number | null;
  lat2: number | null;
  lon2: number | null;
}

// Inclusive list of "YYYY-MM-DD" days. Built at UTC midnight and stepped by whole
// days so there's no DST drift — the strings only feed Cartrack's date filters.
function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) return days;
  for (let t = start; t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

function coordsStr(stop: Stop | undefined): string {
  if (!stop || stop.latitude == null || stop.longitude == null) return "";
  return `${stop.latitude},${stop.longitude}`;
}

// Whole minutes between the pickup's departure and the dropoff's arrival. Both
// are VN-local Cartrack timestamps; the +07:00 offset cancels in the diff.
// Blank when either is missing or the result is negative (bad data).
function travelMins(departure: string, arrival: string): number | "" {
  if (!departure || !arrival) return "";
  const d = parseVnTimestamp(departure).getTime();
  const a = parseVnTimestamp(arrival).getTime();
  if (Number.isNaN(d) || Number.isNaN(a)) return "";
  const m = Math.round((a - d) / 60_000);
  return m >= 0 ? m : "";
}

function mapJob(job: Job): CompletedRow {
  const dr = job.driver;
  const courier = `${dr?.first_name ?? ""} ${dr?.last_name ?? ""}`.trim();
  // Stops arrive ordered [pickup(type 1), dropoff(type 2)] for transport jobs;
  // a job_type_id 3 (delivery) job has a single stop, so stop[1] is absent and
  // its columns stay blank — per spec.
  const pickup = job.stops?.[0];
  const dropoff = job.stops?.[1];
  const pickupDeparture = pickup?.activity_completed_ts ?? "";
  const dropoffArrival = dropoff?.activity_arrived_ts ?? "";
  return {
    ft_pt: "",
    courier,
    pickup_from: pickup?.customer_name ?? "",
    customer: dropoff?.customer_name ?? "",
    order_no: job.job_id,
    pickup_departure: pickupDeparture,
    dropoff_arrival: dropoffArrival,
    started_time: pickup?.activity_arrived_ts ?? "",
    travel_time: travelMins(pickupDeparture, dropoffArrival),
    target: "",
    distance_target: "",
    pass_fail: "",
    device_description: dr?.device_description ?? "",
    pickup_coords: coordsStr(pickup),
    dropoff_coords: coordsStr(dropoff),
    lat1: pickup?.latitude ?? null,
    lon1: pickup?.longitude ?? null,
    lat2: dropoff?.latitude ?? null,
    lon2: dropoff?.longitude ?? null,
  };
}

// GET /api/export-completed?from=2026-06-01&to=2026-06-21&env=prod
// Returns every job_status_id=5 job scheduled within [from, to], one row each.
export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");

  if (!from || !to) {
    return NextResponse.json({ error: "Missing from or to (YYYY-MM-DD)" }, { status: 400 });
  }

  const days = eachDay(from, to);
  if (days.length === 0) {
    return NextResponse.json({ error: "Invalid range: from must be ≤ to" }, { status: 400 });
  }
  if (days.length > MAX_DAYS) {
    return NextResponse.json(
      { error: `Range too wide: ${days.length} days (max ${MAX_DAYS})` },
      { status: 400 }
    );
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const rows: CompletedRow[] = [];
  const errors: string[] = [];

  for (let i = 0; i < days.length; i++) {
    const date = days[i];
    // A short gap between days keeps the call rate gentle on Cartrack. The
    // per-day pagination inside getJobsByStatusAndDate is already sequential.
    if (i > 0) await sleep(250);
    try {
      const jobs = await getJobsByStatusAndDate(COMPLETED_STATUS, date, env);
      for (const job of jobs) rows.push(mapJob(job));
    } catch (e) {
      // One bad day shouldn't sink the whole export — record it and carry on.
      errors.push(`${date}: ${String(e)}`);
    }
  }

  // Stable order: by pickup departure, then job_id.
  rows.sort(
    (a, b) =>
      a.pickup_departure.localeCompare(b.pickup_departure) ||
      (Number(a.order_no) || 0) - (Number(b.order_no) || 0)
  );

  return NextResponse.json({ count: rows.length, days: days.length, rows, errors });
}
