/**
 * The job-admin name search reads every matching driver's day in ONE go
 * (driversJobs). It used to call driverJobs per driver and stopped at the first five
 * in roster order, so "quang" (10 drivers) missed whoever was actually on the road.
 * This checks the batch read returns each driver's jobs from the published day
 * without a rebuild, including drivers past the old cap and drivers with nothing.
 *
 *   node scripts/redis-stub.mjs &
 *   npx tsx scripts/drivers-jobs.test.mts
 */

const PORT = Number(process.env.STUB_PORT ?? 8079);
process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${PORT}`;
process.env.UPSTASH_REDIS_REST_TOKEN = "local";
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`;
process.env.KV_REST_API_TOKEN = "local";
// Fail every rebuild closed, so a cache hit is distinguishable from a live fetch.
delete process.env.CARTRACK_WEB_PASS;
delete process.env.CARTRACK_WEB_PASS_UAT;

const { publishSnapshot, driversJobs, driverJobs } = await import("../src/lib/day-snapshot");

const DATE = "2026-08-12";
const job = (id: number, driver: string) => ({
  job_id: id,
  reference_number: `R${id}`,
  job_status_id: 4,
  scheduled_delivery_ts: `${DATE} 08:15:00`,
  create_ts: `${DATE} 08:10:00`,
  last_assigned_plan_id: null,
  labels: [],
  item_tracking_numbers: [],
  delivery_driver_id: driver,
  driver: { first_name: `F - C - DC1000${id % 100} Test`, last_name: null },
  stops: [
    { stop_id: id * 10 + 1, stop_type_id: 1, stop_status_id: 1, customer_id: `p${id}`, customer_name: `Pickup ${id}`, delivery_windows: [] },
    { stop_id: id * 10 + 2, stop_type_id: 2, stop_status_id: 1, customer_id: "d", customer_name: "BRA - D001", delivery_windows: [] },
  ],
});
// Seven drivers; the working one is SEVENTH — past the old five-driver cap.
const drivers = Array.from({ length: 7 }, (_, i) => `drv-${i + 1}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const timeline = [job(910001, "drv-7"), job(910002, "drv-7"), job(910003, "drv-2")] as any[];

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  ok  " : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!pass) failures++;
}

console.log("\ndriversJobs — batch read for the name search\n");
const res = await publishSnapshot(DATE, "prod", timeline, [], Date.now());
check("publish writes", res === "written", `got "${res}"`);

const got = await driversJobs(DATE, "prod", drivers);
check("serves the published day (no rebuild)", got !== null, got === null ? "got null — it rebuilt" : "");
check("7th driver's two jobs found", (got?.get("drv-7") ?? []).map((j) => j.job_id).sort().join() === "910001,910002",
  JSON.stringify(got?.get("drv-7")?.map((j) => j.job_id)));
check("2nd driver's job found", (got?.get("drv-2") ?? []).length === 1);
check("idle drivers present and empty", (got?.get("drv-1") ?? [null]).length === 0 && got?.has("drv-5") === true);

// Same answer as the one-driver reader it replaces.
const one = await driverJobs(DATE, "prod", "drv-7");
check("matches driverJobs for the same driver",
  JSON.stringify(one?.map((j) => j.job_id).sort()) === JSON.stringify(got?.get("drv-7")?.map((j) => j.job_id).sort()));

const none = await driversJobs(DATE, "prod", ["nobody"]);
check("unknown driver → empty, not null", none !== null && (none.get("nobody") ?? [null]).length === 0);

console.log(failures ? `\n${failures} failure(s)\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
