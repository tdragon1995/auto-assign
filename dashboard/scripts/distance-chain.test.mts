/**
 * The provider chain: VietMap → Goong → second Goong account.
 *
 * Each link must be asked ONLY for what the previous one could not answer, and
 * each must brake independently. Both properties have already failed in practice:
 * one provider's exhaustion silencing the others, and an exhausted provider being
 * re-asked for every remaining pair until the run was lost.
 *
 * ORDER IS THE POINT OF THIS FILE. VietMap leads because the binding constraint
 * on every distance in the system is a DAILY cap, not answer quality — batching
 * cut requests per day and pacing spread them across days, and neither helped,
 * because a daily allowance does not care how politely you spend it. The roomier
 * allowance goes first so the scarce one is spent only on the remainder. The two
 * Goong accounts behind it exist for the same reason: only a separate allowance
 * adds headroom against a daily cap.
 *
 * These checks are what stops the order drifting back by accident — a chain that
 * silently reverts costs real money on the account with the tighter cap and says
 * nothing.
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
 *  moves on, so raw call order reads VIETMAP,VIETMAP,VIETMAP,PRIMARY — the
 *  retries are the backoff working, not the chain misbehaving. */
const chain = () => seen.filter((k, i) => k !== seen[i - 1]);
const O = { lat: 10.77, lon: 106.66 };
const dests = [{ lat: 10.78, lon: 106.68 }];

// ── A healthy lead means the rest are never touched ─────────────────────────
seen = []; dead = new Set();
await roadMatrixOneToMany(O.lat, O.lon, dests, undefined, undefined, newFallbackState());
check("healthy lead → only VietMap is called", chain().join(",") === "VIETMAP", chain().join(","));

// ── Lead exhausted → Goong covers it, before the second account ─────────────
seen = []; dead = new Set(["VIETMAP"]);
const viaGoong = await roadMatrixOneToMany(O.lat, O.lon, dests, undefined, undefined, newFallbackState());
check("VietMap down → Goong is tried next", chain()[1] === "PRIMARY", chain().join(","));
check("the second account is NOT reached when the primary answers",
  !seen.includes("SECOND-ACCOUNT"), seen.join(","));
check("the pair resolves", viaGoong[0]?.distance_km === 5);

// ── VietMap and primary Goong both out → the second account is the last resort
seen = []; dead = new Set(["VIETMAP", "PRIMARY"]);
const viaSecond = await roadMatrixOneToMany(O.lat, O.lon, dests, undefined, undefined, newFallbackState());
check("VietMap + primary down → the second Goong account answers",
  viaSecond[0]?.distance_km === 5, seen.join(","));
check("the chain was walked in order",
  chain().join(",") === "VIETMAP,PRIMARY,SECOND-ACCOUNT", chain().join(","));

// ── Exhaustion is remembered per link, across calls in a run ────────────────
const fb = newFallbackState();
dead = new Set(["PRIMARY"]);
seen = [];
await roadMatrixOneToMany(O.lat, O.lon, dests, undefined, { quotaExceeded: true }, fb);
check("a standing 429 trips the PRIMARY Goong account's own signal", fb.goong.quotaExceeded === true);
check("and leaves the second account's untouched", fb.goong2.quotaExceeded === false);

seen = [];
await roadMatrixOneToMany(O.lat, O.lon, dests, undefined, { quotaExceeded: true }, fb);
check("the tripped account is not asked again in the same run", !seen.includes("PRIMARY"), seen.join(","));
check("but the second account still serves the run", seen.includes("SECOND-ACCOUNT"), seen.join(","));

// ── The lead's brake is the caller's own `signal`, not the FallbackState ────
// Every caller already passes one; it is what makes a capped VietMap stop being
// asked for every remaining pair of a day rather than only every remaining pair
// of a batch.
seen = []; dead = new Set(["VIETMAP"]);
const lead = { quotaExceeded: false };
await roadMatrixOneToMany(O.lat, O.lon, dests, undefined, lead, newFallbackState());
check("a 429 from the lead trips the caller's signal", lead.quotaExceeded === true);
seen = [];
await roadMatrixOneToMany(O.lat, O.lon, dests, undefined, lead, newFallbackState());
check("and the lead is then skipped entirely", !seen.includes("VIETMAP"), seen.join(","));

// ── An unset second key must not double-ask the primary ─────────────────────
delete process.env.GOONG_API_KEY_DISTANCE;
seen = []; dead = new Set(["VIETMAP", "PRIMARY"]);
await roadMatrixOneToMany(O.lat, O.lon, dests, undefined, undefined, newFallbackState());
check("no second key → VietMap, then Goong, and no phantom third hop",
  chain().join(",") === "VIETMAP,PRIMARY", chain().join(","));

globalThis.fetch = realFetch;
console.log(failures === 0 ? "\nAll provider-chain checks passed." : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
