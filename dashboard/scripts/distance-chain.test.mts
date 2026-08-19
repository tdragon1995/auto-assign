/**
 * The provider chain: Goong → second Goong account → VietMap.
 *
 * Each link must be asked ONLY for what the previous one could not answer, and
 * each must brake independently. Both properties have already failed in practice:
 * one provider's exhaustion silencing the others, and an exhausted provider being
 * re-asked for every remaining pair until the run was lost.
 *
 * The second Goong account exists because these are DAILY caps. Batching cut
 * requests per day and pacing spread them across days; neither helped, because a
 * daily allowance does not care how politely you spend it. Only a separate
 * allowance adds headroom.
 *
 *   npx tsx scripts/distance-chain.test.mts
 */
process.env.GOONG_API_KEY = "PRIMARY";
process.env.GOONG_API_KEY_DISTANCE = "SECOND-ACCOUNT";
process.env.VIETMAP_API_KEY = "VIETMAP";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

/** Which key each call used, in order, so the chain's shape is observable. */
let seen: string[] = [];
/** Keys that should answer 429. */
let dead = new Set<string>();

const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: string | URL | Request) => {
  const url = new URL(String(u));
  const isVietmap = url.hostname.includes("vietmap");
  const key = isVietmap ? "VIETMAP" : (url.searchParams.get("api_key") ?? "?");
  seen.push(key);
  if (dead.has(key)) return new Response("nope", { status: 429 });

  if (isVietmap) {
    const n = (url.searchParams.get("destinations") ?? "").split(";").filter(Boolean).length;
    return new Response(JSON.stringify({
      code: "OK", distances: [Array.from({ length: n }, () => 5000)],
      durations: [Array.from({ length: n }, () => 600)],
    }), { status: 200 });
  }
  const n = (url.searchParams.get("destinations") ?? "").split("|").filter(Boolean).length;
  return new Response(JSON.stringify({
    rows: [{ elements: Array.from({ length: n }, () => ({ status: "OK", distance: { value: 5000 }, duration: { value: 600 } })) }],
  }), { status: 200 });
}) as typeof fetch;

const { roadMatrixOneToMany, newFallbackState } = await import("../src/lib/distance");

/** Providers in the order they were reached, collapsing the retry attempts each
 *  one legitimately makes. A 429 is retried up to three times before the chain
 *  moves on, so raw call order reads PRIMARY,PRIMARY,PRIMARY,SECOND-ACCOUNT —
 *  the retries are the backoff working, not the chain misbehaving. */
const chain = () => seen.filter((k, i) => k !== seen[i - 1]);
const O = { lat: 10.77, lon: 106.66 };
const dests = [{ lat: 10.78, lon: 106.68 }];

// ── A healthy primary means the rest are never touched ──────────────────────
seen = []; dead = new Set();
await roadMatrixOneToMany(O.lat, O.lon, dests, undefined, undefined, newFallbackState());
check("healthy primary → only the primary is called", chain().join(",") === "PRIMARY", chain().join(","));

// ── Primary exhausted → the SECOND ACCOUNT covers it, before VietMap ────────
seen = []; dead = new Set(["PRIMARY"]);
const viaSecond = await roadMatrixOneToMany(O.lat, O.lon, dests, undefined, undefined, newFallbackState());
check("primary down → second Goong account is tried next", chain()[1] === "SECOND-ACCOUNT", chain().join(","));
check("VietMap is NOT reached when the second account answers", !seen.includes("VIETMAP"), seen.join(","));
check("the pair resolves", viaSecond[0]?.distance_km === 5);

// ── Both Goong accounts exhausted → VietMap is the last resort ──────────────
seen = []; dead = new Set(["PRIMARY", "SECOND-ACCOUNT"]);
const viaVietmap = await roadMatrixOneToMany(O.lat, O.lon, dests, undefined, undefined, newFallbackState());
check("both Goong keys down → VietMap answers", viaVietmap[0]?.distance_km === 5, seen.join(","));
check("the chain was walked in order", chain().join(",") === "PRIMARY,SECOND-ACCOUNT,VIETMAP", chain().join(","));

// ── Exhaustion is remembered per link, across calls in a run ────────────────
const fb = newFallbackState();
dead = new Set(["SECOND-ACCOUNT"]);
seen = [];
await roadMatrixOneToMany(O.lat, O.lon, dests, undefined, { quotaExceeded: true }, fb);
check("a standing 429 trips the SECOND account's own signal", fb.goong2.quotaExceeded === true);
check("and leaves VietMap's untouched", fb.vietmap.quotaExceeded === false);

seen = [];
await roadMatrixOneToMany(O.lat, O.lon, dests, undefined, { quotaExceeded: true }, fb);
check("the tripped account is not asked again in the same run", !seen.includes("SECOND-ACCOUNT"), seen.join(","));
check("but VietMap still serves the run", seen.includes("VIETMAP"), seen.join(","));

// ── An unset second key must not double-ask the primary ─────────────────────
delete process.env.GOONG_API_KEY_DISTANCE;
seen = []; dead = new Set(["PRIMARY"]);
await roadMatrixOneToMany(O.lat, O.lon, dests, undefined, undefined, newFallbackState());
check("no second key → primary, then straight to VietMap (no second Goong hop)",
  chain().join(",") === "PRIMARY,VIETMAP", chain().join(","));

globalThis.fetch = realFetch;
console.log(failures === 0 ? "\nAll provider-chain checks passed." : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
