/**
 * A 429 must be waited out, not written off.
 *
 * Both providers were treating a refusal as a permanent property of the pair: the
 * null came back, the leg was stored unpriced, and because failures are never
 * cached the same pair was re-asked and refused on the next pass too. Two separate
 * 50-day backfills were lost to that in one afternoon — first against Goong, then
 * against the fallback brought in to cover it.
 *
 * Also pins the thing that makes a fallback worth having: the providers must
 * brake INDEPENDENTLY. Share one signal and either one going quiet silences the
 * other; give a link none and a rate-limited link gets hammered for every
 * remaining pair. Both failure modes have already happened here.
 *
 * The chain now leads with VIETMAP and falls back to Goong, so the `signal` every
 * caller passes brakes VietMap and FallbackState brakes the Goong accounts. The
 * retry behaviour below is a property of `fetchRetrying` and is the same whichever
 * provider is in front — but which one the caller's signal belongs to is not, and
 * getting it backwards would silently leave the lead unbraked.
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
let goongFailFirst = 0;        // how many initial Goong calls answer 429
let vietmapFailAlways = false; // the lead is capped for the whole run
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: string | URL | Request) => {
  const url = String(u);
  if (url.includes("vietmap")) {
    vietmapHits++;
    if (vietmapFailAlways) return new Response("slow down", { status: 429 });
    return new Response(JSON.stringify({ code: "OK", distances: [[2000]], durations: [[480]] }), { status: 200 });
  }
  goongHits++;
  if (goongHits <= goongFailFirst) return new Response("slow down", { status: 429 });
  const n = (new URL(url).searchParams.get("destinations") ?? "").split("|").length;
  return new Response(okGoong(n), { status: 200 });
}) as typeof fetch;

const { goongMatrix, roadMatrixOneToMany, newFallbackState } = await import("../src/lib/distance");

// ── A transient 429 is retried, not discarded ───────────────────────────────
// Driven against goongMatrix directly, below the chain, so this measures the
// retry itself rather than which provider happens to lead today.
goongHits = 0; goongFailFirst = 1; vietmapFailAlways = false;
const t0 = Date.now();
const retried = await goongMatrix(10.77, 106.66, [{ lat: 10.78, lon: 106.68 }]);
check("one 429 then success → the pair resolves", retried[0]?.distance_km === 2, JSON.stringify(retried));
check("it actually asked twice", goongHits === 2, `hits=${goongHits}`);
check("and it waited before retrying", Date.now() - t0 >= 500, `${Date.now() - t0}ms`);

// ── Persistent 429 on the LEAD gives up, and Goong covers it ────────────────
goongHits = 0; vietmapHits = 0; goongFailFirst = 0; vietmapFailAlways = true;
const covered = await roadMatrixOneToMany(10.77, 106.66, [{ lat: 10.78, lon: 106.68 }]);
check("a provider that keeps refusing is not retried forever", vietmapHits <= 3, `hits=${vietmapHits}`);
check("Goong answered instead", covered[0]?.distance_km === 2 && goongHits === 1,
  `km=${covered[0]?.distance_km} goongHits=${goongHits}`);

// ── The links brake independently ───────────────────────────────────────────
// `signal` is the LEAD's brake now, so a standing VietMap 429 must trip it and
// leave the Goong accounts free to answer. Getting this pairing backwards is the
// failure the flip could most easily have introduced.
const leadSignal = { quotaExceeded: false };
const fallback = newFallbackState();
goongHits = 0; vietmapHits = 0; vietmapFailAlways = true;

await roadMatrixOneToMany(10.77, 106.66, [{ lat: 10.78, lon: 106.68 }], undefined, leadSignal, fallback);
check("a standing 429 trips the LEAD's signal", leadSignal.quotaExceeded === true);
check("but leaves the Goong accounts' untouched",
  fallback.goong.quotaExceeded === false && fallback.goong2.quotaExceeded === false);

const vmBefore0 = vietmapHits;
await roadMatrixOneToMany(10.77, 106.66, [{ lat: 10.79, lon: 106.69 }], undefined, leadSignal, fallback);
check("once tripped, the lead is not called again", vietmapHits === vmBefore0, `${vmBefore0} → ${vietmapHits}`);
check("while Goong keeps answering", goongHits === 2, `goongHits=${goongHits}`);

// A tripped fallback must stop being asked too — the bug that lost the last run.
fallback.goong.quotaExceeded = true; fallback.goong2.quotaExceeded = true;
const goongBefore = goongHits;
const abandoned = await roadMatrixOneToMany(10.77, 106.66, [{ lat: 10.80, lon: 106.70 }], undefined, leadSignal, fallback);
check("a tripped fallback is not hammered either", goongHits === goongBefore, `${goongBefore} → ${goongHits}`);
check("and the pair is honestly left unresolved", abandoned[0] === null);

globalThis.fetch = realFetch;
console.log(failures === 0 ? "\nAll backoff checks passed." : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
