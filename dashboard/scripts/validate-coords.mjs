// One-off: validate the exact-coords fix against the live cache. Read-only.
// Counts dist:v1:* entries whose VALUE carries from/to (written post-fix).
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const keys = [];
let cursor = "0";
do {
  const [next, batch] = await redis.scan(cursor, { match: "dist:v1:*", count: 500 });
  keys.push(...batch);
  cursor = String(next);
} while (cursor !== "0");

let total = 0, withCoords = 0, example = null, exampleOld = null;
const CHUNK = 256;
for (let i = 0; i < keys.length; i += CHUNK) {
  const slice = keys.slice(i, i + CHUNK);
  const vals = await redis.mget(...slice);
  slice.forEach((k, j) => {
    total++;
    const raw = vals[j];
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (v && v.from && v.to) {
      withCoords++;
      if (!example) example = { key: k, value: v };
    } else if (!exampleOld) {
      exampleOld = { key: k, value: v };
    }
  });
}

console.log("total dist:v1:* entries:        ", total);
console.log("WITH exact coords (post-fix):   ", withCoords);
console.log("WITHOUT (old / pre-fix):        ", total - withCoords);
if (example)    console.log("\nexample NEW entry:", example.key, "\n  =>", JSON.stringify(example.value));
if (exampleOld) console.log("\nexample OLD entry:", exampleOld.key, "\n  =>", JSON.stringify(exampleOld.value));
