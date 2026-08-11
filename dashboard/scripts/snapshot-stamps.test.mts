/**
 * Does a cycle-published day reach the branch feed WITHOUT reaching the duplicate guard?
 *
 * That split is the entire safety argument for publishSnapshot: the assign cycle can only
 * publish the day as it looked when it fetched, and it goes on to create via-legs and
 * return trips afterwards — so a published snapshot is knowably incomplete, and the guard
 * must never read one (a missing job means no suspect to confirm, and a twin trip gets
 * created). If BUILT and BUILT_FEED ever collapse back into one stamp, nothing in the type
 * system notices and nothing fails until two drivers are sent for the same samples.
 *
 * The assertions lean on a deliberate absence: with no Cartrack credentials, any rebuild
 * fails and returns null. So "the guard returned null" is proof it went to the network
 * rather than reading what the cycle published — which is exactly what we need to show.
 *
 *   node scripts/redis-stub.mjs &
 *   npx tsx scripts/snapshot-stamps.test.mts
 */

const PORT = Number(process.env.STUB_PORT ?? 8079);
process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${PORT}`;
process.env.UPSTASH_REDIS_REST_TOKEN = "local";
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`;
process.env.KV_REST_API_TOKEN = "local";
// Fail every rebuild closed, so a cache hit is distinguishable from a live fetch.
delete process.env.CARTRACK_WEB_PASS;
delete process.env.CARTRACK_WEB_PASS_UAT;

const { publishSnapshot, locationJobs, blockedPair, invalidateSnapshot } =
  await import("../src/lib/day-snapshot.ts");
const { pscPairKey } = await import("../src/lib/job-filters.ts");

const DATE = "2026-08-11";
const PICKUP = "cust-psc-d006";
const DROPOFF = "cust-lab-d001";

// One assigned job on the timeline (status 4) and one unassigned in the unrouted pool
// (status 2), which is the pair the guard should care about.
const timeline = [{
  job_id: 900001,
  reference_number: "D006→D001_08:15",
  job_status_id: 4,
  scheduled_delivery_ts: `${DATE} 08:15:00`,
  create_ts: `${DATE} 08:10:00`,
  last_assigned_plan_id: null,
  labels: ["🛵 Vận chuyển mẫu PSC"],
  item_tracking_numbers: [],
  delivery_driver_id: "driver-uuid-1",
  driver: { first_name: "F - P - DC100001 Trần Test", last_name: null },
  stops: [
    { stop_id: 1, stop_type_id: 1, stop_status_id: 1, customer_id: PICKUP, customer_name: "BRA - D006", delivery_windows: [] },
    { stop_id: 2, stop_type_id: 2, stop_status_id: 1, customer_id: DROPOFF, customer_name: "BRA - D001", delivery_windows: [] },
  ],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}] as any[];

const unrouted = [{
  jobId: 900002,
  referenceNumber: "D006→D001_09:30",
  jobStatusId: 2,
  scheduledTs: `${DATE}T09:30:00+07`,
  createTs: `${DATE}T09:25:00+07`,
  jobLabels: ["🛵 Vận chuyển mẫu PSC"],
  stops: [
    { stopId: 3, stopTypeId: 1, stopStatusId: 1, customerId: PICKUP, customerName: "BRA - D006", deliveryWindows: [] },
    { stopId: 4, stopTypeId: 2, stopStatusId: 1, customerId: DROPOFF, customerName: "BRA - D001", deliveryWindows: [] },
  ],
  rejectedTs: null,
  rejectedReason: null,
}];

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  ok  " : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!pass) failures++;
}

console.log("\npublishSnapshot → feed reads it, guard does not\n");

const res = await publishSnapshot(DATE, "prod", timeline, unrouted, Date.now());
check("publish writes", res === "written", `got "${res}"`);

// 1. The feed must serve the published day without touching Cartrack.
const feed = await locationJobs(DATE, "prod", PICKUP);
check("feed serves published day", feed !== null && feed.length === 2,
  feed === null ? "got null (it rebuilt — the stamp is not being read)" : `${feed.length} job(s)`);
check("feed includes the unassigned job", (feed ?? []).some((j) => j.job_id === 900002));
check("feed includes the assigned job", (feed ?? []).some((j) => j.job_id === 900001));

// 2. The guard must IGNORE it and attempt a live rebuild, which fails without creds.
const guard = await blockedPair(DATE, "prod", pscPairKey(PICKUP, DROPOFF));
check("guard ignores published day", guard === null,
  guard === null ? "rebuilt (correct)" : `served a cached pair — age ${guard.ageMs}ms`);

// 3. A newer publish wins; an older one is refused rather than overwriting.
const stale = await publishSnapshot(DATE, "prod", timeline, unrouted, Date.now() - 60_000);
check("older publish is refused", stale === "superseded", `got "${stale}"`);
const newer = await publishSnapshot(DATE, "prod", timeline, unrouted, Date.now() + 1);
check("newer publish is accepted", newer === "written", `got "${newer}"`);

// 4. scope:"guard" — what psc-assign uses. The guard must be forced live (it has to see
//    the new job), while the feed keeps riding the published day: the booking branch
//    already patched its own list from the create response, so making 41 other branches
//    rebuild the network's day over it is pure waste.
await publishSnapshot(DATE, "prod", timeline, unrouted, Date.now());
await invalidateSnapshot(DATE, "prod", "guard");
const feedAfterGuard = await locationJobs(DATE, "prod", PICKUP);
check("guard-scoped invalidate leaves the feed served", feedAfterGuard !== null && feedAfterGuard.length === 2,
  feedAfterGuard === null ? "rebuilt — it cleared the feed stamp too" : `${feedAfterGuard.length} job(s)`);
const guardAfterGuard = await blockedPair(DATE, "prod", pscPairKey(PICKUP, DROPOFF));
check("guard-scoped invalidate forces the guard live", guardAfterGuard === null,
  guardAfterGuard === null ? "rebuilt (correct)" : "served from cache");

// 5. scope:"all" (the default) clears both — chấm-công still re-reads its list after
//    acting, so the driver must not be served the day from before their check-in.
await invalidateSnapshot(DATE, "prod");
const afterInvalidate = await locationJobs(DATE, "prod", PICKUP);
check("invalidate clears the feed stamp", afterInvalidate === null,
  afterInvalidate === null ? "rebuilt (correct)" : `still served ${afterInvalidate.length} job(s) from cache`);

// 6. fresh=1 always goes live, published or not.
await publishSnapshot(DATE, "prod", timeline, unrouted, Date.now());
const forced = await locationJobs(DATE, "prod", PICKUP, { fresh: true });
check("fresh=1 bypasses the published day", forced === null,
  forced === null ? "rebuilt (correct)" : "served from cache");

console.log(failures === 0 ? "\nall passed\n" : `\n${failures} FAILED\n`);
// exitCode, not process.exit(): the Upstash client keeps keep-alive sockets open, and
// tearing the loop down under them trips a libuv assertion on Windows. Let Node drain.
process.exitCode = failures === 0 ? 0 : 1;
