// Run: npx tsx scripts/config-cache.test.mts — no server or network.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Redis } from "@upstash/redis";
import { CONFIG_CACHE_WRITE_SCRIPT, invalidateConfigCache, loadConfig, unpackConfigBlob } from "../src/lib/config";
import { vnDate } from "../src/lib/time";

const { lua, lauxlib, lualib, to_luastring, to_jsstring } = createRequire(import.meta.url)("fengari");
const store = new Map<string, string>();
const KEY = "config:parsed";
let dbReads = 0;
let emptyRead = false;
process.env.KV_REST_API_URL = "https://config-cache.test";
process.env.KV_REST_API_TOKEN = "test";
process.env.SUPABASE_URL = "https://supabase.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test";

function command([name, key, ...args]: string[]): unknown {
  switch (name.toUpperCase()) {
    case "GET": return store.get(key) ?? null;
    case "SET": store.set(key, args[0]); return "OK";
    case "HGETALL": return [];
    case "EVAL": {
      const L = lauxlib.luaL_newstate();
      lualib.luaL_openlibs(L);
      const table = (name: string, values: string[]) => {
        lua.lua_newtable(L);
        values.forEach((v, i) => { lua.lua_pushstring(L, to_luastring(v)); lua.lua_rawseti(L, -2, i + 1); });
        lua.lua_setglobal(L, to_luastring(name));
      };
      const keyCount = Number(args[0]);
      table("KEYS", args.slice(1, keyCount + 1));
      table("ARGV", args.slice(keyCount + 1));
      lua.lua_newtable(L);
      lua.lua_pushjsfunction(L, (S: unknown) => {
        const argv = Array.from({ length: lua.lua_gettop(S) }, (_, i) => to_jsstring(lua.lua_tolstring(S, i + 1)));
        const result = command(argv);
        if (result == null) lua.lua_pushboolean(S, false);
        else lua.lua_pushstring(S, to_luastring(String(result)));
        return 1;
      });
      lua.lua_setfield(L, -2, to_luastring("call"));
      lua.lua_setglobal(L, to_luastring("redis"));
      assert.equal(lauxlib.luaL_loadstring(L, to_luastring(key)), lua.LUA_OK);
      assert.equal(lua.lua_pcall(L, 0, 1, 0), lua.LUA_OK);
      const result = lua.lua_tointeger(L, -1);
      lua.lua_close(L);
      return result;
    }
    default: throw new Error(`Unexpected Redis command: ${name}`);
  }
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://config-cache.test")) {
    const body = JSON.parse(String(init?.body));
    const batched = Array.isArray(body[0]);
    const encode = (v: unknown): unknown => typeof v === "string" && v !== "OK" ? Buffer.from(v).toString("base64") : v;
    const results = (batched ? body : [body]).map((c: unknown[]) => ({ result: encode(command(c.map(String))) }));
    return Response.json(batched ? results : results[0]);
  }
  assert.ok(url.startsWith("https://supabase.invalid/rest/v1/"), `Unexpected request: ${url}`);
  if (url.includes("master_rules_read")) {
    dbReads++;
    return Response.json(emptyRead ? [] : [{ id: 1, source_row: 2, revision: 1, assignment_mode: "fixed", row_data: { customer_id: "D001", driver_id: "00000000-0000-0000-0000-000000000001", Driver: "Sheet driver", shift_start: "00:00", shift_end: "23:59" },
      pickup_customer_id: "D001", dropoff_customer_id: null, alternate_dropoff_customer_id: null,
      shift_start: "00:00:00", shift_end: "23:59:00", review_issues: [],
      master_rule_drivers: [{ driver_id: "00000000-0000-0000-0000-000000000001", selection_order: 0 }] }]);
  }
  return Response.json([]);
};

const payload = (extra = {}) => ({
  version: 16, gen: "current", day: vnDate(),
  mappings: [{ customer_id: "cached", driver_id: "cached", smart_driver_id: [], first_name_last_name: "Cached driver" }],
  ...extra,
});
async function reset(value: unknown) {
  await invalidateConfigCache();
  store.set("config:gen", "current");
  store.set(KEY, JSON.stringify(value));
  dbReads = 0;
}

try {
  await reset(payload());
  assert.equal((await loadConfig())?.mappings[0].customer_id, "cached");
  assert.equal(dbReads, 0, "A cold instance reuses the shared copy");

  for (const stale of [{ gen: "previous" }, { day: "2000-01-01" }, { version: 15 }, { mappings: [] }]) {
    await reset(payload(stale));
    assert.equal((await loadConfig())?.mappings[0].customer_id, "D001");
    assert.equal(dbReads, 1, "Mismatched metadata or an empty cache requires a full read");
    const saved = unpackConfigBlob<{ version: number; gen: string; day: string; mappings: unknown[] }>(store.get(KEY))!;
    assert.equal(saved.gen, "current");
    assert.equal(saved.day, vnDate());
    assert.equal(saved.version, 16);
    assert.deepEqual([...store.keys()].filter(k => k !== "config:gen"), [KEY], "All generations replace one payload key");
  }

  await reset(payload({ inactiveLocationIds: ["inactive"] }));
  const masterConfig = await loadConfig();
  assert.equal(masterConfig?.mappings[0].customer_id, "cached");
  assert.deepEqual(masterConfig?.inactiveLocationIds, ["inactive"]);
  assert.equal(dbReads, 0, "The cache preserves inactive locations");

  const latest = store.get(KEY);
  const redis = new Redis({ url: process.env.KV_REST_API_URL!, token: "test" });
  assert.equal(await redis.eval(CONFIG_CACHE_WRITE_SCRIPT, ["config:gen", KEY], ["previous", JSON.stringify(payload({ gen: "previous" })), "172800"]), 0);
  assert.equal(store.get(KEY), latest, "A delayed old-generation writer cannot replace the current copy");

  await reset(payload({ gen: "previous" }));
  const beforeEmptyParse = store.get(KEY);
  emptyRead = true;
  assert.equal(await loadConfig(), null);
  assert.equal(store.get(KEY), beforeEmptyParse, "An empty read must not overwrite the shared cache");
  console.log("PASS: one config payload, metadata validation, stale-writer rejection and empty-read protection");
} finally {
  globalThis.fetch = originalFetch;
}
