import { NextRequest, NextResponse, after } from "next/server";
import { Redis } from "@upstash/redis";
import { runEtaSync } from "@/lib/eta-sync";

/**
 * Pickup-ETA sync for Labcenter delivery requests. Pinged every 10 minutes by
 * cron-job.org, the same mechanism as /api/assign/cron and the daily report —
 * GitHub's own `schedule:` trigger was observed firing ~85 minutes late, which is
 * useless for an ETA. Keep the schedule in exactly one place or the PATCHes double up.
 *
 *   GET /api/labcenter/eta-sync            → run in the background, respond at once
 *   GET /api/labcenter/eta-sync?dry=1      → compute and report, write nothing
 *   GET /api/labcenter/eta-sync?wait=1     → run inline and return the full outcome
 *
 * Optional overrides: ?date=YYYY-MM-DD, ?status=assigned, ?lateOverMin=30,
 * ?only=<delivery_request_id> to re-sync or verify a single row.
 */

// Cartrack timeline + Goong legs + one PATCH per row; give it room.
export const maxDuration = 60;

/** Reject unless the caller presents the shared secret; open when unset, matching
 *  the other cron endpoints. */
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`
    || req.headers.get("x-cron-secret") === secret;
}

const LOCK_KEY = "labcenter:eta_sync:lock";
const LOCK_TTL_S = 540; // just under the 10-minute cadence

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const dryRun = sp.get("dry") === "1";
  const opts = {
    dryRun,
    date: sp.get("date") ?? undefined,
    lateOverStatus: sp.get("status") ?? undefined,
    lateOverMin: sp.get("lateOverMin") ? Number(sp.get("lateOverMin")) : undefined,
    only: sp.get("only") ? Number(sp.get("only")) : undefined,
  };

  // A dry run writes nothing, so it never needs the lock and always answers inline.
  if (dryRun || sp.get("wait") === "1") {
    try {
      return NextResponse.json({ ran: true, dryRun, ...(await runEtaSync(opts)) });
    } catch (e) {
      return NextResponse.json({ ran: false, error: String(e) }, { status: 500 });
    }
  }

  // One pass at a time: a slow run must not overlap the next ping and PATCH the same
  // rows twice with two different answers.
  const redis = getRedis();
  if (redis) {
    const got = await redis.set(LOCK_KEY, new Date().toISOString(), { nx: true, ex: LOCK_TTL_S })
      .catch(() => "OK");
    if (got !== "OK") return NextResponse.json({ ran: false, skipped: "locked" });
  }

  // Respond immediately — cron-job.org gives up at 30s.
  after(async () => {
    try {
      const res = await runEtaSync(opts);
      console.log(`[eta-sync] scanned=${res.scanned} patched=${res.patched} skipped=${res.skipped} failed=${res.failed}`);
      for (const o of res.outcomes) {
        if (o.error) console.error(`[eta-sync] request ${o.request_id} (${o.code}): ${o.error}`);
      }
    } catch (e) {
      console.error("[eta-sync] failed:", e);
    } finally {
      if (redis) await redis.del(LOCK_KEY).catch(() => {});
    }
  });

  return NextResponse.json({ ran: true });
}
