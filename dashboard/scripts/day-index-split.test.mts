// Run: npx tsx scripts/day-index-split.test.mts — fake Upstash in memory, no network.
// The day copy stores one index field per branch ("l:<id>") and per driver ("d:<id>").
// Publishes a day through the real write path (Lua included) and reads it back through
// the real readers, checking each read asks only for its own entry.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

process.env.KV_REST_API_URL = "https://day-split.test";
process.env.KV_REST_API_TOKEN = "t";
delete process.env.CARTRACK_WEB_PASS; // a rebuild would fail closed: every hit below is the cache

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = createRequire(import.meta.url)("fengari") as any;
const hashes = new Map<string, Map<string, string>>();
const asked: string[][] = [];

function exec([cmd, key, ...rest]: string[]): string | number | null | (string | null)[] {
  const h = hashes.get(key);
  switch (cmd.toUpperCase()) {
    case "HGET": return h?.get(rest[0]) ?? null;
    case "HMGET": asked.push(rest); return rest.map((f) => h?.get(f) ?? null);
    case "DEL": return hashes.delete(key) ? 1 : 0;
    case "HDEL": { let n = 0; for (const f of rest) if (h?.delete(f)) n++; return n; }
    case "HSET": { const m = h ?? new Map(); for (let i = 0; i < rest.length; i += 2) m.set(rest[i], rest[i + 1]); hashes.set(key, m); return rest.length / 2; }
    case "EXPIRE": return 1;
    case "SET": return "OK";
    case "EVAL": {
      const [script, nkeys, ...more] = [key, ...rest];
      const keys = more.slice(0, Number(nkeys)), argv = more.slice(Number(nkeys));
      const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
      lua.lua_newtable(L);
      lua.lua_pushjsfunction(L, (S: unknown) => {
        const a: string[] = []; for (let i = 1; i <= lua.lua_gettop(S); i++) a.push(to_jsstring(lua.lua_tolstring(S, i)));
        const r = exec(a) as string | number | null;
        if (r === null) lua.lua_pushboolean(S, false); else if (typeof r === "number") lua.lua_pushinteger(S, r); else lua.lua_pushstring(S, to_luastring(r));
        return 1;
      });
      lua.lua_setfield(L, -2, to_luastring("call")); lua.lua_setglobal(L, to_luastring("redis"));
      for (const [name, vals] of [["KEYS", keys], ["ARGV", argv]] as const) {
        lua.lua_newtable(L); vals.forEach((v, i) => { lua.lua_pushstring(L, to_luastring(v)); lua.lua_rawseti(L, -2, i + 1); });
        lua.lua_setglobal(L, to_luastring(name));
      }
      assert.equal(lauxlib.luaL_loadstring(L, to_luastring(script)), lua.LUA_OK);
      assert.equal(lua.lua_pcall(L, 0, 1, 0), lua.LUA_OK, to_jsstring(lua.lua_tostring(L, -1)));
      return lua.lua_tointeger(L, -1);
    }
    default: throw new Error(`unexpected ${cmd}`);
  }
}

globalThis.fetch = async (input, init) => {
  assert.ok(String(input).startsWith("https://day-split.test"), `unexpected request ${input}`);
  const body = JSON.parse(String(init?.body));
  const batched = Array.isArray(body[0]);
  const enc = (v: unknown): unknown => typeof v === "string" ? Buffer.from(v).toString("base64")
    : Array.isArray(v) ? v.map(enc) : v;
  const results = (batched ? body : [body]).map((c: unknown[]) => ({ result: enc(exec(c.map(String))) }));
  return Response.json(batched ? results : results[0]);
};

const { publishSnapshot, locationJobs, driverJobs, driversJobs } = await import("../src/lib/day-snapshot");
const DATE = "2026-10-14";
const job = (id: number, from: string, to: string, driver: string | null) => ({
  job_id: id, reference_number: `${id}`, job_status_id: driver ? 4 : 2, scheduled_delivery_ts: `${DATE} 08:00:00`,
  create_ts: `${DATE} 07:00:00`, last_assigned_plan_id: null, labels: [], item_tracking_numbers: [],
  delivery_driver_id: driver, driver: driver ? { first_name: `DC1 ${driver}`, last_name: null } : null,
  stops: [
    { stop_id: id * 10 + 1, stop_type_id: 1, stop_status_id: 1, customer_id: from, customer_name: from, delivery_windows: [] },
    { stop_id: id * 10 + 2, stop_type_id: 2, stop_status_id: 1, customer_id: to, customer_name: to, delivery_windows: [] },
  ],
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const day = [job(1, "D006", "D001", "tan"), job(2, "D006", "D001", "bao"), job(3, "D007", "D001", "tan")] as any[];

assert.equal(await publishSnapshot(DATE, "prod", day, [], Date.now()), "written");
const stored = [...hashes.get(`day:v2:prod:${DATE}`)!.keys()];
assert.ok(stored.includes("l:D006") && stored.includes("d:tan"), "one index field per branch and per driver");
assert.ok(!stored.includes("x:loc") && !stored.includes("x:drv"), "no whole-network index maps");

asked.length = 0;
assert.deepEqual((await locationJobs(DATE, "prod", "D006"))?.map((j) => j.job_id).sort(), [1, 2]);
assert.ok(asked[0].includes("l:D006") && !asked[0].some((f) => f.startsWith("l:D007")), "a branch reads only its own entry");

asked.length = 0;
assert.deepEqual((await driverJobs(DATE, "prod", "tan"))?.map((j) => j.job_id).sort(), [1, 3]);
assert.ok(asked[0].includes("d:tan") && !asked[0].includes("d:bao"), "a driver reads only their own entry");

const many = await driversJobs(DATE, "prod", ["tan", "bao", "nobody"]);
assert.deepEqual(many?.get("bao")?.map((j) => j.job_id), [2]);
assert.deepEqual(many?.get("nobody"), []);

// A later publish where Bảo's trip moved to Tân: Bảo's entry is gone, not left stale.
day[1] = job(2, "D006", "D001", "tan");
assert.equal(await publishSnapshot(DATE, "prod", day, [], Date.now() + 1000), "written");
assert.deepEqual((await driverJobs(DATE, "prod", "bao"))?.length ?? 0, 0, "an emptied entry is removed");
assert.deepEqual((await driverJobs(DATE, "prod", "tan"))?.map((j) => j.job_id).sort(), [1, 2, 3]);

console.log("PASS: per-entry index — each read asks for its own entry, moves and removals publish correctly");
