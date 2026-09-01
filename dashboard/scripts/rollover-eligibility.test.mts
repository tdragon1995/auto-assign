/**
 * What may the morning rollover carry into today?
 *
 * The rollover reclaims yesterday's unfinished work: it strips any stale driver
 * and re-dates the job to today so the same cycle assigns it. That is right for
 * a client request nobody got to. It is wrong for the engine's OWN return and
 * via legs, and the way it is wrong is permanent:
 *
 *   - cleanupStaleTrips removes yesterday's leftover legs by looking for ones
 *     still dated YESTERDAY. The rollover runs at the top of the cycle and that
 *     sweep at the end, so a rolled leg is already dated today when it looks.
 *   - the roll strips the driver, and every same-day cleanup rule only considers
 *     legs that still have one. Nothing can reach it again.
 *   - so it rolls afresh every morning, for ever.
 *
 * Job 34433562 on 2026-08-29 is the case: a D001→D007 return created 21:48,
 * six minutes before the 21:54 end-of-day sweep — which spares anything under
 * 20 minutes old, on the understanding that the morning sweep finishes the job.
 * The morning sweep never saw it.
 *
 * All three engine legs are treated alike: an outbound left overnight cannot be
 * delivered today under yesterday's date either, and its route re-creates it.
 * The morning sweep now collects all three labels.
 */
import { isRollable } from "../src/lib/assign";
import { PSC_RETURN_LABEL, PSC_OUTBOUND_LABEL } from "../src/lib/return-trips";
import { PSC_VIA_LABEL } from "../src/lib/job-filters";
import type { Job } from "../src/lib/types";

let failures = 0;
function ok(label: string, cond: boolean) {
  console.log(`  ${cond ? "ok  " : "FAIL"}   ${label}`);
  if (!cond) failures++;
}

/** An ordinary leftover: pickup not yet collected, no plan, no engine label. */
function job(over: Partial<Job> = {}): Job {
  return {
    job_id: 1,
    job_status_id: 2,
    stops: [
      { stop_type_id: 1, stop_status_id: 1, customer_id: "pick" },
      { stop_type_id: 2, stop_status_id: 1, customer_id: "drop" },
    ],
    ...over,
  } as Job;
}

console.log("\nRollover eligibility\n");

ok("an untouched client job rolls", isRollable(job()));

ok(
  "a return leg does NOT roll (job 34433562, D001→D007 of 29/08)",
  !isRollable(job({ labels: [PSC_RETURN_LABEL] })),
);
ok("a via leg does NOT roll", !isRollable(job({ labels: [PSC_VIA_LABEL] })));
ok("an outbound leg does NOT roll", !isRollable(job({ labels: [PSC_OUTBOUND_LABEL] })));
ok(
  "an outbound whose pickup was collected does not roll either — the morning sweep takes it",
  !isRollable(
    job({
      labels: [PSC_OUTBOUND_LABEL],
      stops: [
        { stop_type_id: 1, stop_status_id: 4, customer_id: "pick" },
        { stop_type_id: 2, stop_status_id: 1, customer_id: "drop" },
      ],
    }),
  ),
);
ok(
  "a job with no engine label is unaffected — an ordinary Diag-to-Diag bag run still rolls",
  isRollable(job({ labels: ["🚨 Gấp"] })),
);
ok(
  "a return leg is refused even mid-ride (started stops are no exemption)",
  !isRollable(
    job({
      labels: [PSC_RETURN_LABEL],
      stops: [
        { stop_type_id: 1, stop_status_id: 2, customer_id: "pick" },
        { stop_type_id: 2, stop_status_id: 1, customer_id: "drop" },
      ],
    }),
  ),
);
ok(
  "an engine leg among several labels is still refused",
  !isRollable(job({ labels: ["🚨 Gấp", PSC_RETURN_LABEL] })),
);

// The pre-existing rules, so this refactor cannot have quietly dropped one.
ok(
  "a plan slot does not roll — it regenerates itself",
  !isRollable(job({ last_assigned_plan_id: 99 } as Partial<Job>)),
);
ok(
  "a chấm công task does not roll",
  !isRollable(job({ reference_number: "Chấm Công - Nguyễn Văn A" })),
);
ok(
  "a job whose pickup is already collected does not roll",
  !isRollable(
    job({
      stops: [
        { stop_type_id: 1, stop_status_id: 4, customer_id: "pick" },
        { stop_type_id: 2, stop_status_id: 1, customer_id: "drop" },
      ],
    }),
  ),
);
ok(
  "a job whose every stop is terminal does not roll",
  !isRollable(
    job({
      stops: [
        { stop_type_id: 1, stop_status_id: 5, customer_id: "pick" },
        { stop_type_id: 2, stop_status_id: 4, customer_id: "drop" },
      ],
    }),
  ),
);

console.log(failures === 0 ? "\nAll passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
