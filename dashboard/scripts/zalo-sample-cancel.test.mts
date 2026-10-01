import assert from "node:assert/strict";
import { cancelableScheduleJobs, isNoSampleCommand } from "../src/app/api/zalo/sample-cancel/route";
import { SAMPLE_PICKUP_CUSTOMER_ID } from "../src/lib/scheduled-pickup-reminder";
import type { Job } from "../src/lib/types";

for (const text of ["/không có mẫu", "/k co mau", "/k có mẫu", "@Bot Giao nhận mẫu /không có mẫu"]) {
  assert.equal(isNoSampleCommand(text), true, text);
}
for (const text of ["/có mẫu", "không có mẫu", "/không có mẫu nữa"]) {
  assert.equal(isNoSampleCommand(text), false, text);
}

const today = "2026-10-01";
const job = (overrides: Partial<Job> = {}): Job => ({
  job_id: 1,
  job_status_id: 4,
  scheduled_delivery_ts: today + " 10:30:00",
  labels: ["📅 Lịch cố định"],
  stops: [{ stop_type_id: 1, stop_status_id: 1, customer_id: SAMPLE_PICKUP_CUSTOMER_ID }],
  ...overrides,
});
assert.deepEqual(cancelableScheduleJobs([job()], today).map((j) => j.job_id), [1]);
assert.equal(cancelableScheduleJobs([job({ labels: [] })], today).length, 0);
assert.equal(cancelableScheduleJobs([job({ scheduled_delivery_ts: "2026-10-02 10:30:00" })], today).length, 0);
assert.equal(cancelableScheduleJobs([job({ stops: [{ stop_type_id: 1, stop_status_id: 2, customer_id: SAMPLE_PICKUP_CUSTOMER_ID }] })], today).length, 0);
assert.equal(cancelableScheduleJobs([job({ stops: [{ stop_type_id: 1, stop_status_id: 1, customer_id: "other" }] })], today).length, 0);
