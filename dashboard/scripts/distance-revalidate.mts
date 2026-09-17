/**
 * Re-ask VietMap for every cached distance pair and propose the SHORTER figure.
 * READ-ONLY: reads a cache export, calls VietMap, writes a proposal. Nothing in
 * Redis or Supabase changes here.
 *
 *   curl -s https://diag-logistics.vercel.app/api/distance-checking -o reports/distance-revalidate/cache-backup.json
 *   VIETMAP_API_KEY=... npx tsx scripts/distance-revalidate.mts [--max-requests 400]
 *
 * Guards on "take the shorter":
 *   - a VietMap answer below the straight-line distance is impossible → rejected;
 *   - one under 60% of the cached figure is taken only into `review`, not `accept`
 *     (the known failure is a route that is wildly wrong, in either direction).
 *
 * Batching: pairs are packed into matrix requests of ≤ MAX_POINTS points. Every
 * cell of a sources×destinations matrix is returned in one request, so a hub
 * destination with many origins costs one call.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { haversineKm } from "../src/lib/distance";

const DIR = "reports/distance-revalidate";
const argv = process.argv.slice(2);
const MAX_REQ = Number(argv[argv.indexOf("--max-requests") + 1]) || 400;
const MAX_POINTS = 50;
const KEY = process.env.VIETMAP_API_KEY;
if (!KEY) throw new Error("VIETMAP_API_KEY not set");

interface Rec { key: string; fromLat: number; fromLon: number; toLat: number; toLon: number; distance_km: number; eta_mins: number | null }
const recs: Rec[] = JSON.parse(readFileSync(`${DIR}/cache-backup.json`, "utf8")).records;
const pt = (lat: number, lon: number) => `${lat},${lon}`;

// Resumable: answers already fetched are kept.
const answersFile = `${DIR}/vietmap-answers.json`;
const answers: Record<string, { km: number | null; mins: number | null }> =
  existsSync(answersFile) ? JSON.parse(readFileSync(answersFile, "utf8")) : {};

// Pack pairs by destination: a batch is a set of dests plus their origins.
const byDest = new Map<string, Rec[]>();
for (const r of recs) {
  if (answers[r.key]) continue;
  const d = pt(r.toLat, r.toLon);
  const l = byDest.get(d); if (l) l.push(r); else byDest.set(d, [r]);
}
const batches: Rec[][] = [];
let cur: Rec[] = []; let curPts = new Set<string>();
const flush = () => { if (cur.length) batches.push(cur); cur = []; curPts = new Set(); };
for (const list of [...byDest.values()].sort((a, b) => b.length - a.length)) {
  for (let i = 0; i < list.length; ) {
    const need = new Set([pt(list[i].toLat, list[i].toLon)]);
    const take: Rec[] = [];
    while (i < list.length) {
      const o = pt(list[i].fromLat, list[i].fromLon);
      const extra = [o, ...need].filter((p) => !curPts.has(p));
      if (curPts.size + new Set(extra).size > MAX_POINTS) break;
      need.add(o); take.push(list[i]); i++;
    }
    if (take.length === 0) { flush(); continue; }
    for (const p of need) curPts.add(p);
    cur.push(...take);
  }
  if (curPts.size >= MAX_POINTS - 2) flush();
}
flush();
console.log(`${recs.length} pairs, ${Object.keys(answers).length} already answered, ${batches.length} requests needed (cap ${MAX_REQ})`);

let requests = 0;
for (const batch of batches) {
  if (requests >= MAX_REQ) { console.log("request cap reached — re-run to continue"); break; }
  const origins = [...new Set(batch.map((r) => pt(r.fromLat, r.fromLon)))];
  const dests = [...new Set(batch.map((r) => pt(r.toLat, r.toLon)))];
  const points = [...origins, ...dests];
  const url = `https://maps.vietmap.vn/api/matrix/v4?apikey=${encodeURIComponent(KEY)}&` +
    points.map((p) => `point=${p}`).join("&") + `&vehicle=motorcycle` +
    `&sources=${origins.map((_, i) => i).join(";")}&destinations=${dests.map((_, i) => origins.length + i).join(";")}`;
  requests++;
  const res = await fetch(url);
  const lmtd = res.headers.get("x-lmtd");
  if (!res.ok) {
    console.log(`HTTP ${res.status} ${lmtd ?? ""} ${(await res.text()).slice(0, 120)} — stopping`);
    break;
  }
  const j = await res.json() as { code: string; distances?: (number | null)[][]; durations?: (number | null)[][] };
  if (j.code !== "OK") { console.log(`VietMap code ${j.code} — stopping`); break; }
  for (const r of batch) {
    const m = j.distances?.[origins.indexOf(pt(r.fromLat, r.fromLon))]?.[dests.indexOf(pt(r.toLat, r.toLon))];
    const s = j.durations?.[origins.indexOf(pt(r.fromLat, r.fromLon))]?.[dests.indexOf(pt(r.toLat, r.toLon))];
    answers[r.key] = { km: m == null ? null : Math.round(m / 10) / 100, mins: s == null ? null : Math.round(s / 60) };
  }
  if (requests % 20 === 0) { writeFileSync(answersFile, JSON.stringify(answers)); console.log(`${requests} requests${lmtd ? ` (${lmtd})` : ""}`); }
  await new Promise((r) => setTimeout(r, 300));
}
writeFileSync(answersFile, JSON.stringify(answers));

// Proposal.
const accept: unknown[] = []; const review: unknown[] = []; const rejected: unknown[] = [];
let unanswered = 0, keep = 0, savedKm = 0;
for (const r of recs) {
  const a = answers[r.key];
  if (!a || a.km == null) { unanswered++; continue; }
  const straight = haversineKm(r.fromLat, r.fromLon, r.toLat, r.toLon);
  const line = { key: r.key, cached_km: r.distance_km, vietmap_km: a.km, straight_km: Math.round(straight * 100) / 100, cached_mins: r.eta_mins, vietmap_mins: a.mins };
  if (a.km >= r.distance_km) { keep++; continue; }
  if (a.km < straight * 0.98) { rejected.push({ ...line, why: "shorter than straight line" }); continue; }
  if (a.km < r.distance_km * 0.6) { review.push(line); continue; }
  accept.push(line); savedKm += r.distance_km - a.km;
}
const summary = { pairs: recs.length, requests_this_run: requests, unanswered, keep_cached: keep, accept_shorter: accept.length, review_much_shorter: review.length, rejected: rejected.length, accept_km_saved_per_trip_sum: Math.round(savedKm * 100) / 100 };
writeFileSync(`${DIR}/proposal.json`, JSON.stringify({ summary, accept, review, rejected }, null, 2));
console.log(summary);
