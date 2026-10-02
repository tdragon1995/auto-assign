// Run: npx tsx scripts/config-cache.test.mts — no server or network.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Redis } from "@upstash/redis";
import { CONFIG_CACHE_WRITE_SCRIPT, invalidateConfigCache, loadConfigFromSheets } from "../src/lib/config";
import { vnDate } from "../src/lib/time";

const { lua, lauxlib, lualib, to_luastring, to_jsstring } = createRequire(import.meta.url)("fengari");
const store = new Map<string, string>();
const KEY = "config:parsed";
let sheetReads = 0;
let emptySheet = false;
process.env.KV_REST_API_URL = "https://config-cache.test";
process.env.KV_REST_API_TOKEN = "test";
process.env.MASTER_CLIENT_INFO_SOURCE = "sheet";

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
  assert.ok(url.startsWith("https://docs.google.com/spreadsheets/"), `Unexpected request: ${url}`);
  if (url.includes("gid=232994825")) return new Response("customer_name,customer_id\nBranch,D001");
  sheetReads++;
  const header = "customer_id,driver_id,smart_driver_id,Driver,shift_start,shift_end,dropoff_id,Điểm Drop-off";
  return new Response(`${header}\n${emptySheet ? ",,,,,,," : "D001,00000000-0000-0000-0000-000000000001,,Sheet driver,00:00,23:59,,"}`);
};

const payload = (extra = {}) => ({
  version: 12, gen: "current", day: vnDate(),
  mappings: [{ customer_id: "cached", driver_id: "cached", smart_driver_id: [], first_name_last_name: "Cached driver" }],
  ...extra,
});
async function reset(value: unknown) {
  await invalidateConfigCache();
  store.set("config:gen", "current");
  store.set(KEY, JSON.stringify(value));
  sheetReads = 0;
}

try {
  await reset(payload());
  assert.equal((await loadConfigFromSheets())?.mappings[0].customer_id, "cached");
  assert.equal(sheetReads, 0, "A cold instance reuses the shared copy");

  for (const stale of [{ gen: "previous" }, { day: "2000-01-01" }, { version: 11 }, { mappings: [] }]) {
    await reset(payload(stale));
    assert.equal((await loadConfigFromSheets())?.mappings[0].customer_id, "D001");
    assert.equal(sheetReads, 1, "Mismatched metadata or an empty cache requires a sheet read");
    const saved = JSON.parse(store.get(KEY)!);
    assert.equal(saved.gen, "current");
    assert.equal(saved.day, vnDate());
    assert.equal(saved.version, 12);
    assert.deepEqual([...store.keys()].filter(k => k !== "config:gen"), [KEY], "All generations replace one payload key");
  }

  await reset(payload({ version: 14, inactiveLocationIds: ["inactive"] }));
  process.env.MASTER_CLIENT_INFO_SOURCE = "supabase";
  const masterConfig = await loadConfigFromSheets();
  assert.equal(masterConfig?.mappings[0].customer_id, "cached");
  assert.deepEqual(masterConfig?.inactiveLocationIds, ["inactive"]);
  assert.equal(sheetReads, 0, "The master-source cache preserves inactive locations");
  process.env.MASTER_CLIENT_INFO_SOURCE = "sheet";
  await reset(payload({ version: 14 }));
  assert.equal((await loadConfigFromSheets())?.mappings[0].customer_id, "D001");
  assert.equal(sheetReads, 1, "A sheet reader cannot reuse the master-source payload");

  const latest = store.get(KEY);
  const redis = new Redis({ url: process.env.KV_REST_API_URL!, token: "test" });
  assert.equal(await redis.eval(CONFIG_CACHE_WRITE_SCRIPT, ["config:gen", KEY], ["previous", JSON.stringify(payload({ gen: "previous" })), "172800"]), 0);
  assert.equal(store.get(KEY), latest, "A delayed old-generation writer cannot replace the current copy");

  await reset(payload({ gen: "previous" }));
  const beforeEmptyParse = store.get(KEY);
  emptySheet = true;
  assert.equal(await loadConfigFromSheets(), null);
  assert.equal(store.get(KEY), beforeEmptyParse, "An empty sheet must not overwrite the shared cache");
  console.log("PASS: one config payload, metadata validation, stale-writer rejection and empty-sheet protection");
} finally {
  globalThis.fetch = originalFetch;
}
