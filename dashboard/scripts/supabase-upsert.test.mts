import assert from "node:assert/strict";
import { sbUpsert } from "../src/lib/supabase-rest";

const originalFetch = globalThis.fetch;
const oldUrl = process.env.SUPABASE_URL, oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.SUPABASE_URL = "https://supabase.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
const stored = new Map<number, Record<string, unknown>>([[1, { id: 1, bot_token: "preserved", detail_synced_at: "old" }]]);
const batches: Record<string, unknown>[][] = [];
globalThis.fetch = async (_url, init) => {
  const rows = JSON.parse(String(init?.body)) as Record<string, unknown>[];
  assert.ok(rows.length <= 2);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), Object.keys(rows[0]).sort());
    stored.set(Number(row.id), { ...stored.get(Number(row.id)), ...row });
  }
  batches.push(rows);
  return new Response(null, { status: 204 });
};
try {
  assert.equal(await sbUpsert("master_drivers", [
    { id: 1, cartrack: "first" }, { cartrack: "second", id: 2 },
    { id: 3, cartrack: "third", ignored: undefined },
    { id: 4, cartrack: "new", detail_synced_at: "today" },
    { id: 1, cartrack: "last" },
  ], "id", 2), 5);
  assert.deepEqual(batches.map(b => b.length), [2, 1, 1, 1]);
  assert.deepEqual(stored.get(1), { id: 1, cartrack: "last", bot_token: "preserved", detail_synced_at: "old" });
  assert.equal(await sbUpsert("master_drivers", [], "id"), 0);
  await assert.rejects(sbUpsert("master_drivers", [{ id: 1 }], "id", 0), /batch size/);
  console.log("Upsert checks passed: uniform keys, batch limit, update order and omitted credentials preserved");
} finally {
  globalThis.fetch = originalFetch;
  if (oldUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldUrl;
  if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
}
