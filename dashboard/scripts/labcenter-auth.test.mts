// Run: npx tsx scripts/labcenter-auth.test.mts. No live requests.
import assert from "node:assert/strict";
import { getAdminToken, labcenterFetch, LabcenterAuthenticationError } from "../src/lib/labcenter";

Object.assign(process.env, { LABCENTER_EMAIL: "test@example.invalid", LABCENTER_PASSWORD: "test-only" });
let logins = 0, requests = 0, rejectAll = false, status = 200;
globalThis.fetch = async (input, init) => {
  if (String(input).endsWith("/auth/login")) {
    logins++;
    return Response.json({ token: `test-token-${logins}` });
  }
  assert.ok(String(input).startsWith("https://api.labcenter.vn/"), "No live requests");
  requests++;
  const auth = new Headers(init?.headers).get("Authorization");
  return new Response(null, { status: rejectAll || auth === "Bearer test-token-1" ? 401 : status });
};
const first = await getAdminToken();
assert.equal(logins, 1);
const read = () => labcenterFetch("https://api.labcenter.vn/spc-delivery/api/pick-drop-locations", { headers: { Authorization: `Bearer ${first}` } });
assert.ok((await Promise.all([read(),read(),read(),read()])).every(r => r.ok));
assert.equal(logins, 2, "Concurrent rejected reads share one renewed login");
await read();
assert.equal(logins, 2, "Later calls use the renewed cached token");
rejectAll = true;
const before = requests;
await assert.rejects(read(), LabcenterAuthenticationError);
assert.equal(requests - before, 2, "Retry a persistent 401 only once");
rejectAll = false;
for (status of [403,429]) {
  const before = logins;
  assert.equal((await read()).status, status);
  assert.equal(logins,before,"Permission and rate limit errors do not trigger new logins");
}
console.log("Labcenter session renewal, concurrent recovery, bounded retries and unchanged 403/429 behavior passed.");
