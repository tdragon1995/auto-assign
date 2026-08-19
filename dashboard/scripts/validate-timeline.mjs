// One-off: validate delivery_timeline_route_list stop shape before the fetch refactor.
// Confirms customerId + the other fields the adapter maps are actually present.
import { readFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const JSONRPC_URL = "https://fleetweb-vn.cartrack.com/jsonrpc/index.php";
const auth = env.CARTRACK_AUTH;
const password = env.CARTRACK_WEB_PASS;
const account = atob(auth.replace(/^Basic\s+/, "")).split(":")[0];

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
console.log("account:", account, "date:", today);

const login = await fetch(JSONRPC_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: auth },
  body: JSON.stringify({ version: "2.0", method: "ct_login", id: 1, params: { x: "x", account, username: "", password, locale: "en-ZA", otp: "", browserName: "", version: "3.9.1", environment: "live", thirdParty: false } }),
});
const setCookies = login.headers.getSetCookie?.() ?? [];
const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
console.log("login ok:", login.ok, "cookie len:", cookie.length);

const res = await fetch(JSONRPC_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: auth, Cookie: cookie },
  body: JSON.stringify({ version: "2.0", method: "delivery_timeline_route_list", id: 1, params: { data: { scheduleType: "scheduled", filter: { from: `${today}T00:00:00+07:00`, to: `${today}T23:59:59+07:00` } } } }),
});
const data = await res.json();
const routes = data.result?.routes ?? [];
const allStops = routes.flatMap((r) => r.orderedStops ?? []);
console.log("routes:", routes.length, "total stops:", allStops.length, "error:", JSON.stringify(data.error ?? null));

// Status partition (jobs, deduped by jobId)
const byJob = new Map();
for (const s of allStops) {
  if (!byJob.has(s.jobId)) byJob.set(s.jobId, s.jobStatusId);
}
const statusCount = {};
for (const st of byJob.values()) statusCount[st] = (statusCount[st] ?? 0) + 1;
console.log("distinct jobs:", byJob.size, "by jobStatusId:", JSON.stringify(statusCount));

// Field presence — the adapter critically needs customerId per stop.
const sample = allStops.find((s) => s.stopTypeId === 1) ?? allStops[0];
if (sample) {
  console.log("\nSAMPLE STOP keys:", JSON.stringify(Object.keys(sample)));
  console.log("customerId present:", "customerId" in sample, "value:", sample.customerId);
  console.log("customerName:", sample.customerName, "| stopTypeId:", sample.stopTypeId, "| stopStatusId:", sample.stopStatusId);
  console.log("latitude:", sample.latitude, "longitude:", sample.longitude);
  console.log("deliveryWindows:", JSON.stringify(sample.deliveryWindows));
  console.log("jobLabels:", JSON.stringify(sample.jobLabels), "| referenceNumber:", sample.referenceNumber);
  console.log("scheduledDeliveryTs:", sample.scheduledDeliveryTs, "| activityCompletedTs:", sample.activityCompletedTs);
  console.log("deliveryDriverId:", sample.deliveryDriverId);
}
const missingCid = allStops.filter((s) => !s.customerId).length;
console.log("\nstops missing customerId:", missingCid, "/", allStops.length);
