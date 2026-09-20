/**
 * What the PSC duplicate guard treats as "a batch still sitting at the branch".
 *
 * The guard's whole question is whether an uncollected pickup at this branch is already
 * going to this destination. A CARTRACK PLAN SLOT answers yes for the wrong reason: the
 * plan materialises the branch's entire day at 05:00, so an 18:30 shuttle exists from
 * dawn with its pickup untouched. The branch was refused its own ad-hoc bookings all day
 * over a trip due nine hours later — and the /qr feed hides uncollected plan jobs, so
 * there was nothing on screen to explain the refusal.
 *
 * Measured on 2026-09-19: 226 uncollected plan pickups across the network, 203 of them
 * carrying no pickup window at all — so no window-based escape hatch can reach them.
 * The exemption has to be the plan itself.
 *
 * The rows that must keep blocking matter as much as the ones that must not: this guard
 * is the only thing standing between a branch and two drivers collecting one box.
 *
 *   npx tsx scripts/psc-pair-plan.test.mts
 */

const { isPlanJob, pscPairKey, PSC_VIA_LABEL } = await import("../src/lib/job-filters");
const { assembleSnapshot } = await import("../src/lib/day-snapshot");

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const BRANCH = "cust-bra-d003";
const LAB = "cust-bra-d001";
const PAIR = pscPairKey(BRANCH, LAB);

/** One branch→lab trip whose pickup nobody has touched: exactly what the guard blocks on. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function trip(jobId: number, extra: Record<string, unknown> = {}): any {
  return {
    job_id: jobId,
    reference_number: `D003→D001_${jobId}`,
    job_status_id: 4,
    scheduled_delivery_ts: "2026-09-19 18:30:00",
    create_ts: "2026-09-19 05:33:00",
    labels: [],
    stops: [
      { stop_id: jobId * 10, stop_type_id: 1, stop_status_id: 1, customer_id: BRANCH, customer_name: "BRA - D003" },
      { stop_id: jobId * 10 + 1, stop_type_id: 2, stop_status_id: 1, customer_id: LAB, customer_name: "BRA - D001" },
    ],
    ...extra,
  };
}

const pairsOf = (jobs: unknown[]) => assembleSnapshot(jobs as never[], null, Date.now()).pairs;

// ── 1. the predicate itself ──────────────────────────────────────────────────
check("last_assigned_plan_id marks a plan job", isPlanJob(trip(1, { last_assigned_plan_id: 2811481 })));
check("a populated plans array marks one too (REST's shape)", isPlanJob(trip(2, { plans: [{ plan_id: 9 }] })));
check("an ad-hoc request is not a plan job", !isPlanJob(trip(3)));
check("an empty plans array is not a plan job", !isPlanJob(trip(4, { plans: [] })));

// ── 2. the pair index the guard reads ────────────────────────────────────────
check("an uncollected ad-hoc pickup still blocks its pair",
  pairsOf([trip(10)])[PAIR]?.job_id === 10);

check("a plan slot does not block the branch's own bookings",
  pairsOf([trip(11, { last_assigned_plan_id: 2811481 })])[PAIR] === undefined);

// The regression that started this: the plan slot must not shadow a real one, and a real
// one must still be found when both are on the day.
check("a real request beside a plan slot is the one named",
  pairsOf([trip(12, { last_assigned_plan_id: 2811481 }), trip(13)])[PAIR]?.job_id === 13);

// Collected samples never blocked; the plan exemption must not be what does the work here.
check("a collected pickup still clears the pair",
  pairsOf([{ ...trip(14), stops: [
    { stop_id: 140, stop_type_id: 1, stop_status_id: 4, customer_id: BRANCH, customer_name: "BRA - D003",
      activity_completed_ts: "2026-09-19 09:19:00" },
    { stop_id: 141, stop_type_id: 2, stop_status_id: 1, customer_id: LAB, customer_name: "BRA - D001" },
  ] }])[PAIR] === undefined);

// The exemptions that were already there stay there.
check("a cancelled trip still clears the pair",
  pairsOf([trip(15, { job_status_id: 7 })])[PAIR] === undefined);
check("a via-leg still clears the pair",
  pairsOf([trip(16, { labels: [PSC_VIA_LABEL] })])[PAIR] === undefined);

console.log(failures === 0 ? "\nall passed\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
