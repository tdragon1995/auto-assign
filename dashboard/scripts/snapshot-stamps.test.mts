/**
 * The duplicate guard reads a day the assign cycle published, plus a write-through overlay
 * of everything this app has just booked. This checks that BOTH halves are load-bearing.
 *
 * Why the pair matters: reading the published day is what makes the guard cheap (a read
 * instead of the ~3s fleet-wide rebuild measured against D030), but that day can be a few
 * minutes behind. The guard's dangerous failure is a MISSING job — there is no suspect for
 * stillBlocking to confirm, so a twin trip gets created and two drivers collect the same
 * samples. The overlay closes precisely that window for trips the app books. Drop either
 * half and nothing fails a type check; it fails in the car park.
 *
 * Some assertions lean on a deliberate absence: with no Cartrack credentials any rebuild
 * fails and returns null, which makes "returned null" positive proof that a reader went to
 * the network instead of using the cache.
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
  await import("../src/lib/day-snapshot");
const { pscPairKey } = await import("../src/lib/job-filters");
const { markPscPair, unmarkPscPair, lookupPscPair } = await import("../src/lib/smart-log-kv");

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

console.log("\npublished day + write-through overlay\n");

const res = await publishSnapshot(DATE, "prod", timeline, unrouted, Date.now());
check("publish writes", res === "written", `got "${res}"`);

// 1. The feed must serve the published day without touching Cartrack.
const feed = await locationJobs(DATE, "prod", PICKUP);
check("feed serves published day", feed !== null && feed.length === 2,
  feed === null ? "got null (it rebuilt — the stamp is not being read)" : `${feed.length} job(s)`);
check("feed includes the unassigned job", (feed ?? []).some((j) => j.job_id === 900002));
check("feed includes the assigned job", (feed ?? []).some((j) => j.job_id === 900001));

// 2. The guard now READS the published day rather than rebuilding — that is the whole
//    ~3s-per-booking saving. It must find the pair the published day contains.
const guard = await blockedPair(DATE, "prod", pscPairKey(PICKUP, DROPOFF));
check("guard reads the published day", guard !== null && guard.hit?.job_id === 900001,
  guard === null ? "rebuilt — it is not reading the publish" : `job ${guard.hit?.job_id}, age ${guard.ageMs}ms`);

// 3. A newer publish wins; an older one is refused rather than overwriting.
const stale = await publishSnapshot(DATE, "prod", timeline, unrouted, Date.now() - 60_000);
check("older publish is refused", stale === "superseded", `got "${stale}"`);
const newer = await publishSnapshot(DATE, "prod", timeline, unrouted, Date.now() + 1);
check("newer publish is accepted", newer === "written", `got "${newer}"`);

// 4. THE POINT OF THE OVERLAY. A pair booked seconds ago is not in the published day —
//    that is exactly the window a cheap snapshot opens, and the window in which a twin
//    trip gets created. The overlay has to cover it, and be droppable again.
const NEW_PAIR = pscPairKey("cust-psc-d007", "cust-lab-d001");
await publishSnapshot(DATE, "prod", timeline, unrouted, Date.now());
check("a just-booked pair is absent from the published day",
  (await blockedPair(DATE, "prod", NEW_PAIR))?.hit == null);
await markPscPair(DATE, NEW_PAIR, { job_id: 900003, reference_number: "D007→D001_10:00" });
const overlay = await lookupPscPair(DATE, NEW_PAIR);
check("overlay covers it immediately", overlay?.job_id === 900003, `job ${overlay?.job_id}`);
await unmarkPscPair(DATE, NEW_PAIR);
check("overlay releases it on cancel", (await lookupPscPair(DATE, NEW_PAIR)) === null);
check("yesterday's overlay cannot block today",
  (await lookupPscPair("2026-08-10", NEW_PAIR)) === null);

// 5. invalidateSnapshot still forces a rebuild — chấm-công re-reads its list after acting,
//    so the driver must not be served the day from before their check-in.
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
