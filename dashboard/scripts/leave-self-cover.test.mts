// Run: npx tsx scripts/leave-self-cover.test.mts — fake sheet, no network.
import assert from "node:assert/strict";
import { google } from "googleapis";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/leave-status/route";
import { invalidateLeaveCache, resolveSubstitute } from "../src/lib/leave-config";
import { LEAVE_DELETED_HEADERS } from "../src/lib/leave-suppression";
import { SHEET_GID } from "../src/lib/sheets";
import { vnDate } from "../src/lib/time";
import { normalizeLeave } from "../src/lib/master-reconcile";

for (const key of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"])
  delete process.env[key];
process.env.GOOGLE_SERVICE_ACCOUNT_KEY = "{}";
delete process.env.MASTER_CLIENT_INFO_SOURCE;

const id = "00000000-0000-0000-0000-000000000001";
const name = "F - C - DC100001 Nguyễn Văn An";
const headers = [
  "driver_id", "driver", "Loại Nghỉ", "leave_from", "leave_to", "leave_from_hr", "leave_to_hr",
  "sub1_name", "sub1_from", "sub1_to", "sub1_id", "note",
];
const row = [id, name, "Thay ca", vnDate(), vnDate(), "", "", "", "", "", "", ""];
let writes = 0;
const originalSheets = google.sheets;
const originalFetch = globalThis.fetch;
google.sheets = (() => ({
  spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { sheetId: Number(SHEET_GID.nghi_phep), title: "Leave" } }] } }),
    values: {
      get: async ({ range }: { range: string }) => ({ data: { values: range.endsWith("!2:2") ? [row] : [headers, row] } }),
      batchUpdate: async ({ requestBody }: { requestBody: { data: { range: string; values: string[][] }[] } }) => {
        writes++;
        for (const cell of requestBody.data) {
          const letter = /!([A-Z])2$/.exec(cell.range)?.[1];
          assert.ok(letter, `Unexpected write: ${cell.range}`);
          row[letter.charCodeAt(0) - 65] = cell.values[0][0];
        }
        row[10] = row[7] === name ? id : "";
        return { data: {} };
      },
    },
  },
})) as unknown as typeof google.sheets;
const csv = (rows: readonly (readonly string[])[]) => rows.map((r) => r.map((c) => `"${c.replaceAll('"', '""')}"`).join(",")).join("\n");
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, "docs.google.com", `Unexpected request: ${url}`);
  if (url.searchParams.has("sheet")) return new Response(csv([LEAVE_DELETED_HEADERS]));
  switch (url.searchParams.get("gid")) {
    case SHEET_GID.drivers: return new Response(csv([["Driver", "delivery_driver_id", "is_active"], [name, id, "true"]]));
    case SHEET_GID.nghi_phep: return new Response(csv([headers, row]));
    case SHEET_GID.locations: return new Response("customer_name,customer_id\nBranch,C1");
    case SHEET_GID.mapping:
    case SHEET_GID.sunday: return new Response(csv([
      ["customer_id", "driver_id", "smart_driver_id", "Driver", "shift_start", "shift_end", "dropoff_id", "Điểm Drop-off"],
      ["C1", id, "", name, "00:00", "23:59", "", ""],
    ]));
    default: throw new Error(`Unexpected sheet: ${url}`);
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
  assert.equal(added.status, 200);
  const result = await added.json();
  assert.equal(result.ok, true);
  assert.equal(result.thayCaWarning, null, "self-cover survives reconciliation");
  assert.equal(row[10], id);
  assert.equal(writes, 1);
  assert.deepEqual(resolveSubstitute({
    driver_id: id, driver_name: name, loai_nghi: "Thay ca", leave_from: vnDate(), leave_to: vnDate(),
    gio_bat_dau: null, gio_ket_thuc: null, subs: [{ id, name, from: null, to: null }],
  }), { status: "ok", subId: id }, "assignment keeps the same driver for their own area");

  const normalized = normalizeLeave({
    source_uid: "self-cover-test", source_row: 2,
    row_data: Object.fromEntries(headers.map((h, i) => [h, row[i]])),
  }, new Set([id]));
  assert.equal(normalized.linked_driver_id, id);
  assert.equal(normalized.substitutes[0].driver_id, id, "Supabase normalization preserves self-cover");

  const edited = await post({ replace: true });
  assert.equal(edited.status, 200, "covered Thay ca can also be edited to self-cover");
  assert.equal(writes, 2);

  for (const loai_nghi of ["Nghỉ nguyên buổi", "Nghỉ nửa buổi", "Nghỉ việc", null]) {
    const rejected = await post({ loai_nghi });
    assert.equal(rejected.status, 400, `self-cover must be refused for ${loai_nghi}`);
  }
  row[2] = "Nghỉ nguyên buổi";
  const wrongType = await post({ replace: true });
  assert.equal(wrongType.status, 400, "claiming Thay ca cannot bypass an ordinary leave row");
  assert.equal(writes, 2, "rejected requests never write");
  console.log("Leave self-cover: add, edit, reconciliation, assignment and ordinary-leave guards passed.");
} finally {
  globalThis.fetch = originalFetch;
  google.sheets = originalSheets;
  await invalidateLeaveCache();
}
