/**
 * Runs the day snapshot's REAL compare-and-swap Lua script (fengari, a Lua VM in JS)
 * and counts every redis.call it makes — the number Upstash bills.
 *
 * The per-field HSET loop this replaced spent one command per field, 845 on a single
 * cold write of an 845-field day, and that is what filled the database. A regression
 * back to it still passes every functional test, so the count is the assertion.
 *
 * No server, no network: redis.call is a Map in this process, strict about arity the
 * way Redis is (an empty HSET/HDEL batch errors there, so it throws here).
 *
 *   npx tsx scripts/snapshot-lua.test.mts
 */
import { createRequire } from "node:module";
import { CAS_WRITE_SCRIPT, CAS_BATCH_FIELDS, casWriteArgs } from "../src/lib/day-snapshot";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = createRequire(import.meta.url)("fengari") as any;

type Store = Map<string, Map<string, string>>;
const KEY = "day:v1:prod:2026-09-13";

function exec(store: Store, [cmd, key, ...rest]: string[]): string | number | null {
  const hash = store.get(key);
  switch (cmd.toUpperCase()) {
    case "HGET": return hash?.get(rest[0]) ?? null;
    case "DEL": return store.delete(key) ? 1 : 0;
    case "HDEL": {
      if (!rest.length) throw new Error("ERR wrong number of arguments for 'hdel'");
      let n = 0;
      for (const f of rest) if (hash?.delete(f)) n++;
      return n;
    }
    case "HSET": {
      if (!rest.length || rest.length % 2) throw new Error("ERR wrong number of arguments for 'hset'");
      const h = hash ?? new Map<string, string>();
      for (let i = 0; i < rest.length; i += 2) h.set(rest[i], rest[i + 1]);
      store.set(key, h);
      return rest.length / 2;
    }
    case "EXPIRE": return hash ? 1 : 0;
    default: throw new Error(`unexpected command ${cmd}`);
  }
}

function runScript(store: Store, args: string[]): { result: number; calls: string[][] } {
  const calls: string[][] = [];
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  lua.lua_newtable(L);
  lua.lua_pushjsfunction(L, (S: unknown) => {
    const argv: string[] = [];
    for (let i = 1; i <= lua.lua_gettop(S); i++) argv.push(to_jsstring(lua.lua_tolstring(S, i)));
    calls.push(argv);
    const r = exec(store, argv);
    if (r === null) lua.lua_pushboolean(S, false); // nil bulk reply
    else if (typeof r === "number") lua.lua_pushinteger(S, r);
    else lua.lua_pushstring(S, to_luastring(r));
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring("call"));
  lua.lua_setglobal(L, to_luastring("redis"));

  const table = (name: string, values: string[]) => {
    lua.lua_newtable(L);
    values.forEach((v, i) => { lua.lua_pushstring(L, to_luastring(v)); lua.lua_rawseti(L, -2, i + 1); });
    lua.lua_setglobal(L, to_luastring(name));
  };
  table("KEYS", [KEY]);
  table("ARGV", args);

  if (lauxlib.luaL_loadstring(L, to_luastring(CAS_WRITE_SCRIPT)) !== lua.LUA_OK ||
      lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
    throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
  }
  return { result: lua.lua_tointeger(L, -1), calls };
}

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  ok  " : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!pass) failures++;
}

const fieldsOf = (n: number, tag = "v"): [string, string][] =>
  Array.from({ length: n }, (_, i) => [`j:${i}`, JSON.stringify({ i, tag, name: "Trần Thị Ánh" })]);
const count = (calls: string[][], cmd: string) => calls.filter((c) => c[0] === cmd).length;
const maxBatch = (calls: string[][], cmd: string, perField: number) =>
  Math.max(0, ...calls.filter((c) => c[0] === cmd).map((c) => (c.length - 2) / perField));

console.log("\nday-snapshot CAS script, command counts\n");

// 1. The observed cold write: 845 fields.
{
  const store: Store = new Map([[KEY, new Map([["stale", "x"]])]]);
  const changed = fieldsOf(845);
  const { result, calls } = runScript(store, casWriteArgs("", "rev1", 900, "full", [], changed));
  const hash = store.get(KEY)!;
  check("full 845-field write applies", result === 1);
  check("field writes: 845 commands → 4", count(calls, "HSET") - 1 === 4, `${count(calls, "HSET") - 1} field HSETs`);
  check("total commands = 4 + HGET/DEL/revision/EXPIRE", calls.length === 8, `${calls.length} commands`);
  check("no batch exceeds the limit", maxBatch(calls, "HSET", 2) <= CAS_BATCH_FIELDS);
  check("full write replaces the hash", !hash.has("stale") && hash.size === 846);
  check("every value stored exactly", changed.every(([f, v]) => hash.get(f) === v));
  check("revision stamped", hash.get("__revision__") === "rev1");
}

// 2. Batch boundaries — including zero fields, which must send no empty HSET.
for (const [n, batches] of [[0, 0], [1, 1], [256, 1], [257, 2], [512, 2], [513, 3]] as const) {
  const store: Store = new Map();
  const { calls } = runScript(store, casWriteArgs("", "r", 900, "full", [], fieldsOf(n)));
  check(`${n} fields → ${batches} HSET batch(es)`, count(calls, "HSET") - 1 === batches,
    `${count(calls, "HSET") - 1}`);
  check(`${n} fields all stored`, (store.get(KEY)?.size ?? 0) === n + 1);
}

// 3. Warm delta: a few changes, many deletions.
{
  const store: Store = new Map([[KEY, new Map([["__revision__", "rev1"], ...fieldsOf(600)])]]);
  const deleted = Array.from({ length: 300 }, (_, i) => `j:${i}`);
  const changed = fieldsOf(3, "new").map(([, v], i) => [`j:${400 + i}`, v] as [string, string]);
  const { result, calls } = runScript(store, casWriteArgs("rev1", "rev2", 900, "delta", deleted, changed));
  const hash = store.get(KEY)!;
  check("delta applies", result === 1);
  check("300 deletions → 2 HDEL", count(calls, "HDEL") === 2, `${count(calls, "HDEL")}`);
  check("3 changes → 1 field HSET", count(calls, "HSET") - 1 === 1);
  check("delta never DELs the hash", count(calls, "DEL") === 0);
  check("delta total = 6 commands (HGET, 2 HDEL, HSET, revision, EXPIRE)", calls.length === 6, `${calls.length}`);
  check("deleted fields gone, others kept", !hash.has("j:0") && !hash.has("j:299") && hash.has("j:300") && hash.size === 301);
  check("changed values written", hash.get("j:400") === changed[0][1]);
}

// 4. Deletion-only delta (a job disappeared, nothing else moved).
{
  const store: Store = new Map([[KEY, new Map([["__revision__", "a"], ["j:1", "x"], ["j:2", "y"]])]]);
  const { result, calls } = runScript(store, casWriteArgs("a", "b", 900, "delta", ["j:1"], []));
  check("delete-only delta applies without an empty HSET", result === 1 && count(calls, "HSET") === 1);
  check("delete-only delta removes the field", !store.get(KEY)!.has("j:1") && store.get(KEY)!.has("j:2"));
}

// 5. Concurrent writers read the same revision; only the first may land.
{
  const store: Store = new Map([[KEY, new Map([["__revision__", "base"], ["j:1", "old"]])]]);
  const first = runScript(store, casWriteArgs("base", "w1", 900, "delta", [], [["j:1", "first"]]));
  const second = runScript(store, casWriteArgs("base", "w2", 900, "full", [], fieldsOf(845, "second")));
  const hash = store.get(KEY)!;
  check("first writer applies", first.result === 1);
  check("second writer refused", second.result === 0);
  check("refused write costs one command", second.calls.length === 1 && second.calls[0][0] === "HGET",
    `${second.calls.length}`);
  check("refused full write leaves the hash intact", hash.get("j:1") === "first" && hash.get("__revision__") === "w1" && hash.size === 2);
}

console.log(failures === 0 ? "\nall passed\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
