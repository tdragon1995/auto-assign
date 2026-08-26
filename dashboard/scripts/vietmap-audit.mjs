/**
 * Re-price every distance the system has frozen, using VietMap as a second
 * opinion, and write the verdicts to Supabase.
 *
 * WHY THIS EXISTS. tat_legs freezes distance_km onto each row at archive time
 * and nothing ever re-checks it — deliberately, because retuning the target must
 * not rewrite history. The cost of that choice is that there is no path by which
 * a wrong distance is ever noticed. A leg priced at 0 km, or priced from a
 * coordinate nobody meant, grades a driver every day and never surfaces. This is
 * that path.
 *
 * IT NEVER TOUCHES tat_legs. Results land in `distance_audit`, one row per
 * distinct coordinate pair. A disagreement is a finding for a person to judge,
 * never an automatic correction — auditing must not be able to mutate the thing
 * it audits.
 *
 * WHY VIETMAP. It is the only other provider already wired into this system, so
 * it can disagree without adding a dependency. The limit that comes with that:
 * the two use different road graphs and different profiles (Goong `bike`,
 * VietMap `motorcycle`), so they will never agree to the metre. A few percent of
 * spread is normal and means nothing. What this is looking for is the error a
 * single provider cannot show you — a pair wrong by a factor, a zero that should
 * be a distance, a coordinate in the wrong province.
 *
 * The client here is written from VietMap's published docs rather than importing
 * src/lib/vietmap.ts, on purpose. That library has never run against the live API
 * — its test pins the documented response body, not a real one. An audit that
 * imported it would inherit any misreading it contains and then confirm itself.
 *
 * REQUESTS ARE THE COST, NOT PAIRS. VietMap's matrix takes a flat point list plus
 * source and destination index ranges and returns the whole sources x destinations
 * block, so one request answers up to maxSrc*maxDst pairs. `planBlocks` packs the
 * pairs into as few blocks as it can — see the comment there.
 *
 * PACING IS DELIBERATELY SLOW. One request at a time with a gap between them. A
 * 429 here costs far more than a slow run: this is the provider that exists to
 * cover Goong's gaps, and hammering it is how a rate limit turned into a lost
 * backfill once already. The run is resumable for the same reason — results are
 * appended as they arrive and `--resume` skips what is already priced, so
 * stopping it is free.
 *
 * INPUT. Either straight from Supabase, or from two staged files when no
 * service-role key is available locally:
 *   scripts/_audit-points.txt  "lat,lng;lat,lng;..."   (index = position)
 *   scripts/_audit-pairs.txt   "fromIdx>toIdx;..."
 * The indices are just positions in the point list; they exist so the results can
 * be joined back in SQL without shipping coordinates twice.
 *
 * OUTPUT.
 *   scripts/_audit-results.csv   fromIdx,toIdx,km,eta   (appended; resume reads it)
 *   scripts/_audit-update.sql    chunked UPDATE statements against distance_audit
 * With SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set, it writes to Supabase
 * directly and the .sql file is not needed.
 *
 * SETUP. dashboard/.env.audit.local (gitignored):
 *   VIETMAP_API_KEY=...
 *   SUPABASE_URL=https://<ref>.supabase.co          # optional
 *   SUPABASE_SERVICE_ROLE_KEY=...                   # optional
 *
 * RUN (from dashboard/):
 *   node scripts/vietmap-audit.mjs --plan-only    # request count, no API calls
 *   node scripts/vietmap-audit.mjs --limit 100    # smoke test
 *   node scripts/vietmap-audit.mjs                # the full pass
 *   node scripts/vietmap-audit.mjs --resume       # continue after a stop
 *
 * FLAGS
 *   --plan-only     print the request plan and exit; never calls VietMap
 *   --limit N       only the first N pairs
 *   --resume        skip pairs already in the results file
 *   --gap MS        delay between requests (default 1500)
 *   --max-src N     origins per request (default 40)
 *   --max-dst N     destinations per request (default 40)
 *   --max-calls N   safety cap on requests (default 2000)
 */

import { readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Redis } from "@upstash/redis";

// ── args ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const PLAN_ONLY = has("--plan-only");
const RESUME = has("--resume");
const LIMIT = Number(val("--limit", 0)) || 0;
const GAP_MS = Number(val("--gap", 1500));
const MAX_SRC = Number(val("--max-src", 40));
const MAX_DST = Number(val("--max-dst", 40));
const MAX_CALLS = Number(val("--max-calls", 2000));

const POINTS_FILE = "scripts/_audit-points.txt";
const PAIRS_FILE = "scripts/_audit-pairs.txt";
const RESULTS_FILE = "scripts/_audit-results.csv";
const SQL_FILE = "scripts/_audit-update.sql";

// ── env ──────────────────────────────────────────────────────────────────────

for (const file of [".env.audit.local", ".env.local"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const VIETMAP_KEY = process.env.VIETMAP_API_KEY ?? "";
const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const HAVE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_KEY);

// ── helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

/** The cache's own key rule: truncate to 5 dp, never round. Mirrored here so the
 *  audit can check that a stored value's exact coords still belong to its key,
 *  and so cache pairs line up with the leg pairs, which are cut the same way. */
export function coord(n) {
  const s = Number(n).toFixed(8);
  return s.slice(0, s.indexOf(".") + 6);
}

// ── the Redis distance cache ─────────────────────────────────────────────────

/**
 * Read every `dist:v1:*` entry and report on what is actually in there.
 *
 * WHY THE CACHE IS AUDITED SEPARATELY FROM THE LEGS. The frozen distance on a leg
 * is what already graded someone; a cache entry is what will grade someone next.
 * They overlap heavily but neither contains the other: the cache also holds pairs
 * that no leg ever used — ranking lookups, distance checks, locations since gone
 * quiet — and those are the dangerous ones, because entries are written once, kept
 * forever and never re-read for correctness. A wrong value there is silent until
 * the day it is spent.
 *
 * Strictly read-only: SCAN (cursor loop, never KEYS) plus pipelined MGET.
 */
async function loadCache() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  if (/127\.0\.0\.1|localhost/.test(url)) {
    // The stub holds a few dev keys and no distances at all. Auditing it would
    // report a clean, empty, entirely meaningless result.
    console.warn(`  skipping cache: ${url} is the local stub, not the production cache.`);
    return null;
  }

  const redis = new Redis({ url, token });
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, { match: "dist:v1:*", count: 1000 });
    keys.push(...batch);
    cursor = String(next);
  } while (cursor !== "0");

  const entries = [];
  const CHUNK = 256;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    const values = await redis.mget(...slice);
    slice.forEach((key, j) => {
      const raw = values[j];
      let v = raw;
      if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { v = null; } }
      entries.push({ key, value: v });
    });
  }
  return entries;
}

/** Pull numeric coords out of a key, for entries written before the exact coords
 *  were stored alongside the value. */
function keyCoords(key) {
  const [from = "", to = ""] = key.replace(/^dist:v1:/, "").split(">");
  const [a, b] = from.split(",");
  const [c, d] = to.split(",");
  const num = (s) => (s !== undefined && s !== "" && !isNaN(Number(s)) ? Number(s) : null);
  return { fromLat: num(a), fromLon: num(b), toLat: num(c), toLon: num(d) };
}

/**
 * Integrity pass over the cache — everything that can be judged without asking a
 * provider anything. Returns one normalised record per entry.
 */
export function inspectCache(entries) {
  const out = [];
  for (const { key, value: v } of entries) {
    const k = keyCoords(key);
    const exact = v && v.from && v.to &&
      typeof v.from.lat === "number" && typeof v.to.lat === "number";
    // Prefer the exact coords the value carries — those are what the provider was
    // actually asked. The key is the same point truncated to about a metre.
    const fromLat = exact ? v.from.lat : k.fromLat;
    const fromLon = exact ? v.from.lon : k.fromLon;
    const toLat = exact ? v.to.lat : k.toLat;
    const toLon = exact ? v.to.lon : k.toLon;
    const km = typeof v?.distance_km === "number" ? v.distance_km : null;
    const eta = typeof v?.eta_mins === "number" ? v.eta_mins : null;

    const flags = [];
    if (!v || typeof v !== "object") flags.push("unparseable");
    if (km === null) flags.push("no-distance");
    if (!exact) flags.push("legacy-key-coords");

    let hav = null;
    if ([fromLat, fromLon, toLat, toLon].every((n) => typeof n === "number" && Number.isFinite(n))) {
      // The exact coords must still truncate to the key that holds them. If they
      // do not, a lookup computed from those coords would miss the entry that
      // answers it, and the pair would be re-fetched forever.
      if (exact && k.fromLat !== null &&
          (coord(fromLat) !== coord(k.fromLat) || coord(fromLon) !== coord(k.fromLon) ||
           coord(toLat) !== coord(k.toLat) || coord(toLon) !== coord(k.toLon))) {
        flags.push("key-value-coord-mismatch");
      }
      // Self-pairs are answered for free before the cache is ever consulted, so a
      // stored one is dead weight at best.
      if (coord(fromLat) === coord(toLat) && coord(fromLon) === coord(toLon)) flags.push("self-pair");
      const inVN = (la, lo) => la >= 8.0 && la <= 23.6 && lo >= 102.0 && lo <= 110.0;
      if (!inVN(fromLat, fromLon) || !inVN(toLat, toLon)) flags.push("outside-vietnam");

      hav = haversineKm(fromLat, fromLon, toLat, toLon);
      // Distances are stored rounded to 0.1 km, so only a shortfall beyond half a
      // step (0.05 km) is genuinely impossible rather than quantisation.
      if (km !== null && km < hav - 0.05) flags.push("shorter-than-crow-flies");
      if (km !== null && hav > 0.3 && km / hav > 5) flags.push("huge-detour");
    } else {
      flags.push("missing-coords");
    }
    if (km === 0 && !flags.includes("self-pair")) flags.push("zero-distance");
    // A zero here means the provider returned a distance with no travel time —
    // "unknown", not "instant" — and the leg targets read it.
    if (eta === 0 && km > 0) flags.push("zero-eta");

    out.push({ key, fromLat, fromLon, toLat, toLon, km, eta, hav, exact, flags });
  }
  return out;
}

// ── block planning ───────────────────────────────────────────────────────────

/**
 * Pack point-to-point pairs into as few sources x destinations blocks as possible.
 *
 * Two plans are built and the cheaper one wins, because neither is always right.
 *
 * GREEDY BY DESTINATION suits sparse data. These are route legs, and legs chain
 * A->B, B->C, C->lab: consecutive legs share no origin, so grouping by origin
 * degenerates to one request per pair. Destinations are where the repetition
 * lives — most legs end at the lab or a hub — so anchoring a block on the busiest
 * destination swallows a large share at once, and every other destination
 * reachable from the origins already committed rides along for free.
 *
 * TILING suits dense data. When the pairs span few enough locations, simply
 * crossing every origin tile with every destination tile covers ALL pairs in
 * ceil(origins/maxSrc) * ceil(dests/maxDst) requests and beats chasing the sparse
 * tail one anchor at a time.
 *
 * Cells nobody asked for get computed and discarded either way. That is the point:
 * the provider meters requests, not cells.
 */
export function planBlocks(pairs, { maxSrc = 40, maxDst = 40 } = {}) {
  const greedy = greedyBlocks(pairs, maxSrc, maxDst);
  const tiled = tiledBlocks(pairs, maxSrc, maxDst);
  return tiled.length < greedy.length ? tiled : greedy;
}

/** Every origin tile against every destination tile; empty tiles dropped. */
function tiledBlocks(pairs, maxSrc, maxDst) {
  const srcPts = [...new Set(pairs.map((p) => p.s))];
  const dstPts = [...new Set(pairs.map((p) => p.d))];
  const byCell = new Map();
  pairs.forEach((p, i) => {
    const k = `${p.s}>${p.d}`;
    const list = byCell.get(k);
    if (list) list.push(i); else byCell.set(k, [i]);
  });

  const blocks = [];
  for (let a = 0; a < srcPts.length; a += maxSrc) {
    const srcs = srcPts.slice(a, a + maxSrc);
    for (let b = 0; b < dstPts.length; b += maxDst) {
      const dests = dstPts.slice(b, b + maxDst);
      const pairIdx = [];
      for (const s of srcs) for (const d of dests) {
        const list = byCell.get(`${s}>${d}`);
        if (list) pairIdx.push(...list);
      }
      if (pairIdx.length > 0) blocks.push({ srcs, dests, pairIdx });
    }
  }
  return blocks;
}

function greedyBlocks(pairs, maxSrc, maxDst) {
  const remainingByDest = new Map();
  pairs.forEach((p, i) => {
    let set = remainingByDest.get(p.d);
    if (!set) remainingByDest.set(p.d, (set = new Set()));
    set.add(i);
  });

  const blocks = [];
  while (remainingByDest.size > 0) {
    // The destination that still owes the most pairs anchors the block.
    let anchor = null, anchorSize = -1;
    for (const [d, set] of remainingByDest) {
      if (set.size > anchorSize) { anchor = d; anchorSize = set.size; }
    }

    // Its origins, capped, define the block's source axis.
    const srcs = [];
    const srcSet = new Set();
    for (const i of remainingByDest.get(anchor)) {
      const s = pairs[i].s;
      if (!srcSet.has(s)) {
        srcSet.add(s);
        srcs.push(s);
        if (srcs.length >= maxSrc) break;
      }
    }

    // Every destination reachable from those origins, best first. One that
    // harvests nothing is skipped — it would widen the matrix and retire no pair.
    const gain = [];
    for (const [d, set] of remainingByDest) {
      let n = 0;
      for (const i of set) if (srcSet.has(pairs[i].s)) n++;
      if (n > 0) gain.push([d, n]);
    }
    gain.sort((a, b) => b[1] - a[1]);
    const dests = gain.slice(0, maxDst).map(([d]) => d);

    const harvested = [];
    for (const d of dests) {
      const set = remainingByDest.get(d);
      for (const i of [...set]) {
        if (srcSet.has(pairs[i].s)) { harvested.push(i); set.delete(i); }
      }
      if (set.size === 0) remainingByDest.delete(d);
    }

    // The anchor always contributes at least one pair — its own origins seeded the
    // source set — so the loop always shrinks and cannot spin.
    blocks.push({ srcs, dests, pairIdx: harvested });
  }
  return blocks;
}

// ── VietMap ──────────────────────────────────────────────────────────────────

const VIETMAP_MATRIX = "https://maps.vietmap.vn/api/matrix/v4";
// Goong is asked for `bike`; VietMap's nearest equivalent is `motorcycle`. Same
// choice src/lib/vietmap.ts makes — a car profile would disagree with the stored
// values for a legitimate reason and drown out the disagreements worth seeing.
const VEHICLE = "motorcycle";
const HARD_STOP = new Set(["OVER_DAILY_LIMIT", "OVER_QUERY_LIMIT", "REQUEST_DENIED", "INVALID_API_KEY"]);

let calls = 0;

/**
 * One matrix request. Returns { distances, durations } in metres/seconds, or
 * throws; `err.stop` marks a limit the caller must not push past.
 *
 * Sources and destinations are listed as separate points even when the same
 * location appears on both axes — matching the documented request shape. Reusing
 * one index on both axes would be smaller, but an audit is the wrong place to be
 * the first caller to try something undocumented.
 */
async function vietmapBlock(points, srcs, dests) {
  const list = [...srcs.map((i) => points[i]), ...dests.map((i) => points[i])];
  const qs = list.map((p) => `point=${p.lat},${p.lon}`).join("&");
  const srcIdx = srcs.map((_, i) => i).join(";");
  const dstIdx = dests.map((_, i) => srcs.length + i).join(";");
  const url = `${VIETMAP_MATRIX}?apikey=${encodeURIComponent(VIETMAP_KEY)}&${qs}` +
              `&vehicle=${VEHICLE}&sources=${srcIdx}&destinations=${dstIdx}`;

  // Long, patient backoff. Sub-second retries are right inside a 60-second
  // serverless archive; here there is no deadline, so a rate limit should be
  // waited out rather than turned into a hole in the report.
  const waits = [15_000, 45_000, 120_000, 300_000];
  for (let attempt = 0; ; attempt++) {
    calls++;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      if (attempt >= waits.length) throw new Error(`network: ${e?.message ?? e}`);
      await sleep(waits[attempt]);
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= waits.length) {
        const err = new Error(`HTTP ${res.status} after ${waits.length} retries`);
        err.stop = res.status === 429;
        throw err;
      }
      console.warn(`\n  HTTP ${res.status} — waiting ${waits[attempt] / 1000}s before retry ${attempt + 1}`);
      await sleep(waits[attempt]);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const data = await res.json().catch(() => null);
    if (data?.code && data.code !== "OK") {
      const err = new Error(`code=${data.code} ${data.messages ?? ""}`);
      err.stop = HARD_STOP.has(data.code);
      throw err;
    }
    return { distances: data?.distances, durations: data?.durations };
  }
}

// ── Supabase (optional direct write) ─────────────────────────────────────────

async function supabaseUpdate(rows, points) {
  // PostgREST has no multi-row conditional update, so this goes through an RPC-free
  // path: one PATCH per pair would be 4.5k requests. Instead upsert on the pair's
  // natural key, which merges into the seeded row.
  const body = rows.map((r) => ({
    from_lat: points[r.s].lat, from_lng: points[r.s].lon,
    to_lat: points[r.d].lat,   to_lng: points[r.d].lon,
    provider: "vietmap",
    audit_km: r.km, audit_eta_mins: r.eta,
  }));
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/distance_audit?on_conflict=provider,from_lat,from_lng,to_lat,to_lng`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`supabase ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** What the cache holds, judged without asking any provider anything. */
function reportCache(records) {
  const n = (f) => records.filter((r) => r.flags.includes(f)).length;
  const locations = new Set();
  for (const r of records) {
    if (r.flags.includes("missing-coords")) continue;
    locations.add(`${coord(r.fromLat)},${coord(r.fromLon)}`);
    locations.add(`${coord(r.toLat)},${coord(r.toLon)}`);
  }
  const ratios = records
    .filter((r) => r.km !== null && r.hav > 0.3)
    .map((r) => r.km / r.hav)
    .sort((a, b) => a - b);

  console.log(`\n── what the Redis cache holds ──────────────────────────────`);
  console.log(`  entries                        ${records.length}`);
  console.log(`  distinct locations             ${locations.size}`);
  console.log(`  unparseable value              ${n("unparseable")}`);
  console.log(`  no distance stored             ${n("no-distance")}`);
  console.log(`  legacy (no exact coords)       ${n("legacy-key-coords")}`);
  console.log(`  missing/invalid coords         ${n("missing-coords")}`);
  console.log(`  key/value coord mismatch       ${n("key-value-coord-mismatch")}`);
  console.log(`  self-pairs stored              ${n("self-pair")}`);
  console.log(`  zero distance (not self)       ${n("zero-distance")}`);
  console.log(`  zero eta with a distance       ${n("zero-eta")}`);
  console.log(`  coords outside Vietnam         ${n("outside-vietnam")}`);
  console.log(`  shorter than the straight line ${n("shorter-than-crow-flies")}`);
  console.log(`  detour over 5x                 ${n("huge-detour")}`);
  if (ratios.length) {
    console.log(`  median road/straight ratio     ${ratios[Math.floor(ratios.length / 2)].toFixed(2)}`);
  }

  const worst = records
    .filter((r) => r.km !== null && r.hav > 0.3)
    .sort((a, b) => (b.km / b.hav) - (a.km / a.hav))
    .slice(0, 8);
  if (worst.length) {
    console.log(`  worst detours (stored km / straight line km):`);
    for (const r of worst) {
      console.log(`    ${String(r.km).padStart(8)} / ${r.hav.toFixed(2).padStart(8)}  ` +
                  `= ${(r.km / r.hav).toFixed(1)}x  ${r.key.replace(/^dist:v1:/, "")}`);
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

function loadInputs() {
  if (!existsSync(POINTS_FILE) || !existsSync(PAIRS_FILE)) {
    throw new Error(`Missing ${POINTS_FILE} / ${PAIRS_FILE}. Stage them from Supabase first.`);
  }
  const points = readFileSync(POINTS_FILE, "utf8").trim().split(";").map((s) => {
    const [lat, lon] = s.split(",");
    return { lat: Number(lat), lon: Number(lon) };
  });
  const pairs = readFileSync(PAIRS_FILE, "utf8").trim().split(";").map((s) => {
    const [a, b] = s.split(">");
    return { s: Number(a), d: Number(b) };
  });
  for (const p of pairs) {
    if (!points[p.s] || !points[p.d]) throw new Error(`pair references a missing point: ${p.s}>${p.d}`);
  }
  return { points, pairs };
}

async function main() {
  if (!VIETMAP_KEY && !PLAN_ONLY) {
    throw new Error("Missing VIETMAP_API_KEY (dashboard/.env.audit.local), or pass --plan-only.");
  }

  const { points, pairs: legPairs } = loadInputs();
  // Anything past this index is a location the cache introduced. The helper table
  // in Supabase only knows the staged ones, so the new tail has to travel with the
  // results or the update matches nothing.
  const stagedPointCount = points.length;
  console.log(`${legPairs.length} pairs from tat_legs over ${points.length} locations.`);

  // One shared point index for both sources. Identity is the coordinate TRUNCATED
  // to 5 dp — the cache's own key rule, and about a metre on the ground, which
  // cannot move a road distance. Without collapsing them, the same clinic would
  // enter the plan twice and be asked about twice.
  const pointIdx = new Map();
  points.forEach((p, i) => pointIdx.set(`${coord(p.lat)},${coord(p.lon)}`, i));
  const idOf = (lat, lon) => {
    const k = `${coord(lat)},${coord(lon)}`;
    let i = pointIdx.get(k);
    if (i === undefined) {
      i = points.length;
      points.push({ lat: Number(coord(lat)), lon: Number(coord(lon)) });
      pointIdx.set(k, i);
    }
    return i;
  };

  const bySource = new Map();
  for (const p of legPairs) bySource.set(`${p.s}>${p.d}`, { ...p, source: "legs" });

  let cacheRecords = null;
  if (!has("--skip-cache")) {
    const entries = await loadCache();
    if (entries) {
      cacheRecords = inspectCache(entries);
      reportCache(cacheRecords);

      let shared = 0, cacheOnly = 0, unusable = 0;
      for (const r of cacheRecords) {
        if (r.flags.includes("missing-coords")) { unusable++; continue; }
        const key = `${idOf(r.fromLat, r.fromLon)}>${idOf(r.toLat, r.toLon)}`;
        const existing = bySource.get(key);
        if (existing) { existing.source = "both"; shared++; }
        else {
          const [s, d] = key.split(">").map(Number);
          bySource.set(key, { s, d, source: "cache" });
          cacheOnly++;
        }
      }
      const legsOnly = [...bySource.values()].filter((p) => p.source === "legs").length;
      console.log(`\n  cache vs legs:`);
      console.log(`    in both                      ${shared}`);
      console.log(`    cache only (never yet a leg) ${cacheOnly}`);
      console.log(`    legs only (not in cache)     ${legsOnly}`);
      if (unusable) console.log(`    cache rows with no usable coords ${unusable}`);

      // Cache-only pairs have no row in distance_audit yet — nothing in tat_legs
      // ever used them. Seed them so the table is the whole picture rather than
      // only the part that has already graded somebody.
      const seeded = new Set(legPairs.map((p) => `${p.s}>${p.d}`));
      const rows = [];
      for (const r of cacheRecords) {
        if (r.flags.includes("missing-coords")) continue;
        const key = `${idOf(r.fromLat, r.fromLon)}>${idOf(r.toLat, r.toLon)}`;
        if (seeded.has(key)) continue;
        const q = (x) => (x === null || x === undefined ? "null" : x);
        rows.push(`(${coord(r.fromLat)},${coord(r.fromLon)},${coord(r.toLat)},${coord(r.toLon)},` +
                  `${q(r.km)},${q(r.eta)},${r.hav === null ? "null" : r.hav.toFixed(3)},0,` +
                  `${r.flags.length ? `'${r.flags.join("|")}'` : "null"})`);
      }
      if (rows.length) {
        writeFileSync("scripts/_audit-cache-only.sql",
          `insert into distance_audit (from_lat,from_lng,to_lat,to_lng,stored_km,stored_eta_mins,` +
          `haversine_km,legs_affected,flags,source) values\n` +
          rows.map((r) => r.slice(0, -1) + ",'cache')").join(",\n") +
          `\non conflict on constraint distance_audit_pair_unique do nothing;\n`, "utf8");
        console.log(`    wrote scripts/_audit-cache-only.sql (${rows.length} rows)`);
      }
    }
  }

  const allPairs = [...bySource.values()];
  console.log(`\n${allPairs.length} distinct pairs to verify over ${points.length} locations.`);

  let done = new Set();
  if (RESUME && existsSync(RESULTS_FILE)) {
    for (const line of readFileSync(RESULTS_FILE, "utf8").split(/\r?\n/)) {
      const [a, b] = line.split(",");
      if (a && b) done.add(`${a}>${b}`);
    }
    console.log(`--resume: ${done.size} already priced, skipping them.`);
  } else if (!PLAN_ONLY) {
    writeFileSync(RESULTS_FILE, "", "utf8");
  }

  let pairs = allPairs.filter((p) => !done.has(`${p.s}>${p.d}`));
  if (LIMIT > 0 && pairs.length > LIMIT) {
    pairs = pairs.slice(0, LIMIT);
    console.log(`--limit ${LIMIT}: ${pairs.length} pairs this run.`);
  }
  if (pairs.length === 0) { console.log("Nothing left to price."); return; }

  const blocks = planBlocks(pairs, { maxSrc: MAX_SRC, maxDst: MAX_DST });
  console.log(`Packed into ${blocks.length} requests (max ${MAX_SRC}x${MAX_DST} each).`);
  console.log(`Pacing ${GAP_MS}ms apart — about ${((blocks.length * GAP_MS) / 60000).toFixed(1)} min of waiting plus response time.`);
  if (blocks.length > MAX_CALLS) {
    throw new Error(`plan needs ${blocks.length} requests, over --max-calls ${MAX_CALLS}.`);
  }
  if (PLAN_ONLY) { console.log("--plan-only: no requests made."); return; }

  const results = [];
  let priced = 0, unanswered = 0, stopped = null;

  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (bi > 0) await sleep(GAP_MS);

    let matrix = null;
    try {
      matrix = await vietmapBlock(points, b.srcs, b.dests);
    } catch (err) {
      console.warn(`\n  block ${bi + 1}/${blocks.length} failed: ${err.message}`);
      if (err.stop) {
        // A standing limit, not a burst. Everything written stays valid and
        // --resume picks up exactly here once the allowance returns.
        stopped = err.message;
        break;
      }
    }

    const srcPos = new Map(b.srcs.map((s, i) => [s, i]));
    const dstPos = new Map(b.dests.map((d, i) => [d, i]));
    const batch = [];

    for (const pi of b.pairIdx) {
      const p = pairs[pi];
      const dRow = matrix?.distances?.[srcPos.get(p.s)];
      const tRow = matrix?.durations?.[srcPos.get(p.s)];
      const metres = Array.isArray(dRow) ? dRow[dstPos.get(p.d)] : undefined;
      const seconds = Array.isArray(tRow) ? tRow[dstPos.get(p.d)] : undefined;

      // Distance is the load-bearing value — a duration with no distance cannot
      // price a leg, so that cell counts as unanswered. Null must stay
      // distinguishable from zero all the way into the database.
      const km = typeof metres === "number" && Number.isFinite(metres)
        ? Math.round(metres / 100) / 10 : null;
      const eta = typeof seconds === "number" && Number.isFinite(seconds)
        ? Math.round(seconds / 60) : null;
      if (km === null) unanswered++; else priced++;

      const rec = { s: p.s, d: p.d, km, eta };
      results.push(rec);
      batch.push(rec);
      // Appended per block so an interrupted run keeps its work.
      appendFileSync(RESULTS_FILE, `${p.s},${p.d},${km ?? ""},${eta ?? ""}\n`, "utf8");
    }

    if (HAVE_SUPABASE && batch.length) {
      try { await supabaseUpdate(batch, points); }
      catch (e) { console.warn(`\n  supabase write failed for block ${bi + 1}: ${e.message}`); }
    }

    process.stdout.write(`\r  request ${bi + 1}/${blocks.length} — ${priced} priced, ${unanswered} unanswered`);
  }
  process.stdout.write("\n");

  // Chunked UPDATE statements for the case where no service-role key is present
  // locally. Keyed by point index against a helper table, so the payload stays
  // small enough to paste — coordinates are already in the database.
  if (!HAVE_SUPABASE) {
    const CHUNK = 1200;
    let sql = "";
    // Teach the helper table the locations the cache added, or every result that
    // references one silently updates nothing.
    if (points.length > stagedPointCount) {
      const extra = points.slice(stagedPointCount)
        .map((p, i) => `(${p.lat},${p.lon},${stagedPointCount + i})`).join(",");
      sql += `insert into _audit_points (lat,lng,idx) values ${extra} on conflict (idx) do nothing;\n`;
    }
    for (let i = 0; i < results.length; i += CHUNK) {
      const vals = results.slice(i, i + CHUNK)
        .map((r) => `(${r.s},${r.d},${r.km ?? "null"},${r.eta ?? "null"})`)
        .join(",");
      sql += `update distance_audit a set audit_km=v.km, audit_eta_mins=v.eta, checked_at=now() ` +
             `from (values ${vals}) as v(s,d,km,eta), _audit_points p1, _audit_points p2 ` +
             `where p1.idx=v.s and p2.idx=v.d and a.from_lat=p1.lat and a.from_lng=p1.lng ` +
             `and a.to_lat=p2.lat and a.to_lng=p2.lng;\n`;
    }
    writeFileSync(SQL_FILE, sql, "utf8");
    console.log(`Wrote ${SQL_FILE} (${Math.ceil(results.length / CHUNK)} statements).`);
  }

  console.log(`\nrequests made      ${calls}`);
  console.log(`priced by VietMap  ${priced}`);
  console.log(`no answer          ${unanswered}`);
  if (stopped) console.log(`\nSTOPPED EARLY: ${stopped}\n  Re-run with --resume once the limit clears.`);
  console.log("\ntat_legs was not modified.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
