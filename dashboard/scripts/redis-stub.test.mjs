import { Redis } from "@upstash/redis";
const r = new Redis({ url: "http://127.0.0.1:8079", token: "local" });
const ok = (n, c) => console.log(`${c ? "PASS" : "FAIL"}  ${n}`);

// The lock primitive: SET NX must let exactly one caller win.
const k = `create_lock:psc:A-B-${Date.now()}`;
const first = await r.set(k, "t1", { nx: true, ex: 120 });
const second = await r.set(k, "t2", { nx: true, ex: 120 });
ok("SET NX: first caller wins", first === "OK");
ok("SET NX: second caller refused", second === null);
await r.del(k);
ok("SET NX: free again after release", (await r.set(k, "t3", { nx: true, ex: 120 })) === "OK");

// Round-trip typing — the SDK JSON-encodes, so objects must survive intact.
await r.set("obj", { a: 1, b: ["x"] });
const obj = await r.get("obj");
ok("GET returns the object that was SET", JSON.stringify(obj) === JSON.stringify({ a: 1, b: ["x"] }));

// EX expiry actually expires.
await r.set("ttl", "v", { ex: 1 });
await new Promise((s) => setTimeout(s, 1200));
ok("EX: key gone after its TTL", (await r.get("ttl")) === null);

// The day-snapshot shape: multi(del+hset+expire) then hmget.
const hk = "day:v1:prod:2026-08-02";
const tx = r.multi();
tx.del(hk);
tx.hset(hk, { __built__: String(Date.now()), "x:loc": JSON.stringify({ D001: [1, 2] }), "j:1": JSON.stringify({ job_id: 1 }) });
tx.expire(hk, 900);
await tx.exec();
const head = await r.hmget(hk, "__built__", "x:loc");
ok("multi(del+hset+expire) then HMGET", !!head?.__built__ && head["x:loc"]?.D001?.length === 2);
ok("EXISTS sees the hash", (await r.exists(hk)) === 1);

// SCAN + MGET, used by the distance-cache export.
await r.set("dist:v1:a", 1); await r.set("dist:v1:b", 2);
const [cursor, keys] = await r.scan(0, { match: "dist:v1:*", count: 1000 });
ok("SCAN terminates and matches", cursor === "0" || cursor === 0);
ok("SCAN found both keys", keys.length === 2);
ok("MGET returns both values", JSON.stringify((await r.mget(...keys)).sort()) === "[1,2]");
