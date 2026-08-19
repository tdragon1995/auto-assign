/**
 * A 429 must be waited out, not written off.
 *
 * Both providers were treating a refusal as a permanent property of the pair: the
 * null came back, the leg was stored unpriced, and because failures are never
 * cached the same pair was re-asked and refused on the next pass too. Two separate
 * 50-day backfills were lost to that in one afternoon — first against Goong, then
 * against the fallback brought in to cover it.
 *
 * Also pins the thing that makes a fallback worth having: the two providers must
 * brake INDEPENDENTLY. Share one signal and either one going quiet silences the
 * other; give the fallback none and a rate-limited fallback gets hammered for
 * every remaining pair. Both failure modes have already happened here.
 *
 *   npx tsx scripts/distance-backoff.test.mts
 */
process.env.GOONG_API_KEY = "GOONG-KEY";
process.env.VIETMAP_API_KEY = "VIETMAP-KEY";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const okGoong = (n: number) => JSON.stringify({
  rows: [{ elements: Array.from({ length: n }, () => ({ status: "OK", distance: { value: 2000 }, duration: { value: 480 } })) }],
});

let goongHits = 0, vietmapHits = 0;
let goongFailFirst = 0;   // how many initial Goong calls answer 429
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: string | URL | Request) => {
  const url = String(u);
  if (url.includes("vietmap")) {
    vietmapHits++;
    return new Response(JSON.stringify({ code: "OK", distances: [[2000]], durations: [[480]] }), { status: 200 });
  }
  goongHits++;
  if (goongHits <= goongFailFirst) return new Response("slow down", { status: 429 });
  const n = (new URL(url).searchParams.get("destinations") ?? "").split("|").length;
  return new Response(okGoong(n), { status: 200 });
}) as typeof fetch;

const { goongMatrix, roadMatrixOneToMany } = await import("../src/lib/distance");

// ── A transient 429 is retried, not discarded ───────────────────────────────
goongHits = 0; goongFailFirst = 1;
const t0 = Date.now();
const retried = await goongMatrix(10.77, 106.66, [{ lat: 10.78, lon: 106.68 }]);
check("one 429 then success → the pair resolves", retried[0]?.distance_km === 2, JSON.stringify(retried));
check("it actually asked twice", goongHits === 2, `hits=${goongHits}`);
check("and it waited before retrying", Date.now() - t0 >= 500, `${Date.now() - t0}ms`);

// ── Persistent 429 gives up, and the fallback covers it ─────────────────────
goongHits = 0; vietmapHits = 0; goongFailFirst = 99;
const covered = await roadMatrixOneToMany(10.77, 106.66, [{ lat: 10.78, lon: 106.68 }]);
check("a provider that keeps refusing is not retried forever", goongHits <= 3, `hits=${goongHits}`);
check("the fallback answered instead", covered[0]?.distance_km === 2 && vietmapHits === 1);

// ── The two providers brake independently ───────────────────────────────────
const goongSignal = { quotaExceeded: false };
const fallbackSignal = { quotaExceeded: false };
goongHits = 0; vietmapHits = 0; goongFailFirst = 99;

await roadMatrixOneToMany(10.77, 106.66, [{ lat: 10.78, lon: 106.68 }], undefined, goongSignal, fallbackSignal);
check("a standing 429 trips the PRIMARY's signal", goongSignal.quotaExceeded === true);
check("but leaves the fallback's untouched", fallbackSignal.quotaExceeded === false);

const goongBefore = goongHits;
await roadMatrixOneToMany(10.77, 106.66, [{ lat: 10.79, lon: 106.69 }], undefined, goongSignal, fallbackSignal);
check("once tripped, the primary is not called again", goongHits === goongBefore, `${goongBefore} → ${goongHits}`);
check("while the fallback keeps answering", vietmapHits === 2, `vietmapHits=${vietmapHits}`);

// A tripped fallback must stop being asked too — the bug that lost the last run.
fallbackSignal.quotaExceeded = true;
const vmBefore = vietmapHits;
const abandoned = await roadMatrixOneToMany(10.77, 106.66, [{ lat: 10.80, lon: 106.70 }], undefined, goongSignal, fallbackSignal);
check("a tripped fallback is not hammered either", vietmapHits === vmBefore, `${vmBefore} → ${vietmapHits}`);
check("and the pair is honestly left unresolved", abandoned[0] === null);

globalThis.fetch = realFetch;
console.log(failures === 0 ? "\nAll backoff checks passed." : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
