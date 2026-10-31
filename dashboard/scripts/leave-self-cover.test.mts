// Run: npx tsx scripts/leave-self-cover.test.mts — fake Supabase, no network.
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/leave-status/route";
import { invalidateLeaveCache, resolveSubstitute } from "../src/lib/leave-config";
import { vnDate } from "../src/lib/time";

for (const key of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"])
  delete process.env[key];
Object.assign(process.env, { SUPABASE_URL: "https://supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "test" });

const id = "00000000-0000-0000-0000-000000000001";
const branch = "00000000-0000-0000-0000-0000000000c1";
const name = "Nguyễn Văn An";
// The one leave record, as master_leave_read serves it.
const leave = {
  id: 7, source_uid: "self-cover-test", source_row: 2, revision: 1,
  row_data: { "Loại Nghỉ": "Thay ca", driver: name } as Record<string, string>,
  linked_driver_id: id, starts_on: vnDate(), ends_on: vnDate(), starts_at: null, ends_at: null,
  master_leave_substitutes: [] as { selection_order: number; coverage_kind: string; driver_id: string | null; starts_at: string | null; ends_at: string | null }[],
};
const rule = { id: 1, source_row: 2, revision: 1, assignment_mode: "fixed", row_data: {}, active: true,
  pickup_customer_id: branch, dropoff_customer_id: null, alternate_dropoff_customer_id: null,
  shift_start: "00:00:00", shift_end: "23:59:00", review_issues: [], areas: [],
  master_rule_drivers: [{ driver_id: id, selection_order: 0 }] };
let writes = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, "supabase.invalid", `Unexpected request: ${url}`);
  const table = url.pathname.replace("/rest/v1/", "");
  if (table === "rpc/master_write_leave") {
    writes++;
    const [change] = JSON.parse(String(init?.body)).changes;
    leave.revision++;
    leave.master_leave_substitutes = change.substitutes ?? [];
    return Response.json([{ id: leave.id, revision: leave.revision }]);
  }
  switch (table) {
    case "master_leave_read": return Response.json([leave]);
    // The roster loader refuses a list under 100 as a bad read, so pad it.
    case "master_drivers": return Response.json([{ driver_id: id, first_name: "Nguyễn Văn", last_name: "An", is_active: true, roster: { Driver: name } },
      ...Array.from({ length: 100 }, (_, i) => ({ driver_id: `00000000-0000-0000-0000-${String(1000 + i).padStart(12, "0")}`, first_name: "Filler", last_name: String(i), is_active: true, roster: {} }))]);
    case "master_config_rules": return Response.json([rule]);
    case "master_clients": case "master_clients_read": return Response.json([{ customer_id: branch, customer_name: "Branch", is_active: true, cartrack: { customer_name: "Branch" } }]);
    default: return Response.json([]);
  }
};
const post = (extra: Record<string, unknown> = {}) => POST(new NextRequest("http://localhost/api/leave-status", {
  method: "POST", body: JSON.stringify({
    driver_id: id, leave_from: vnDate(), timeLabel: null, loai_nghi: "Thay ca",
    subs: [{ name, from: null, to: null }], ...extra,
  }),
}));

try {
  const added = await post();
  const result = await added.json();
  assert.equal(added.status, 200, JSON.stringify(result));
  assert.equal(result.ok, true);
  assert.equal(leave.master_leave_substitutes[0]?.driver_id, id, "the driver is stored as their own substitute");
  assert.equal(writes, 1);
  assert.deepEqual(resolveSubstitute({
    driver_id: id, driver_name: name, loai_nghi: "Thay ca", leave_from: vnDate(), leave_to: vnDate(),
    gio_bat_dau: null, gio_ket_thuc: null, subs: [{ id, name, from: null, to: null }],
  }), { status: "ok", subId: id }, "assignment keeps the same driver for their own area");

  const edited = await post({ replace: true });
  assert.equal(edited.status, 200, "covered Thay ca can also be edited to self-cover");
  assert.equal(writes, 2);

  for (const loai_nghi of ["Nghỉ nguyên buổi", "Nghỉ nửa buổi", "Nghỉ việc", null]) {
    const rejected = await post({ loai_nghi });
    assert.equal(rejected.status, 400, `self-cover must be refused for ${loai_nghi}`);
  }
  leave.row_data["Loại Nghỉ"] = "Nghỉ nguyên buổi";
  await invalidateLeaveCache();
  const wrongType = await post({ replace: true });
  // The leave writer finds no Thay ca record to cover and refuses (a 500 today).
  assert.notEqual(wrongType.status, 200, "claiming Thay ca cannot bypass an ordinary leave row");
  assert.equal(writes, 2, "rejected requests never write");
  console.log("Leave self-cover: add, edit, assignment and ordinary-leave guards passed.");
} finally {
  globalThis.fetch = originalFetch;
  await invalidateLeaveCache();
}
