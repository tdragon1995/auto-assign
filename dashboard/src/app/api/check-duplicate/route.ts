import { NextRequest, NextResponse } from "next/server";
import { getActiveJobs, type Env } from "@/lib/cartrack";

export const runtime = "edge";
export const preferredRegion = "sin1";

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const pickup = req.nextUrl.searchParams.get("pickup") ?? "";
  const dropoff = req.nextUrl.searchParams.get("dropoff") ?? "";

  if (!pickup || !dropoff) {
    return NextResponse.json({ error: "Missing pickup or dropoff" }, { status: 400 });
  }

  try {
    const { data: jobs } = await getActiveJobs(env);

    for (const job of jobs) {
      const pickupStop = job.stops.find(
        (s) => s.stop_type_id === 1 && s.customer_id === pickup
      );
      const dropoffStop = job.stops.find((s) => s.customer_id === dropoff);

      if (pickupStop && dropoffStop) {
        const status = pickupStop.stop_status_id ?? 0;
        if (status === 1 || status === 2) {
          return NextResponse.json({
            blocked: true,
            reference: job.reference_number ?? String(job.job_id),
            stop_status_id: status,
          });
        }
      }
    }

    return NextResponse.json({ blocked: false });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
