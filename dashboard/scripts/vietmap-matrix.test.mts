/**
 * VietMap Matrix v4 client: URL shape and response parsing.
 *
 * This is pinned against the request and response VietMap's own docs publish,
 * because the client was written from documentation rather than from a live call
 * — the API key belongs in the environment, not in a test. Everything here that
 * could silently be wrong is a shape: which points are sources, which are
 * destinations, whether rows are origins, and what units come back.
 *
 * The units matter most. Distances arrive in METRES and durations in SECONDS,
 * while the rest of the system speaks kilometres and minutes; getting that
 * backwards would not throw, it would quietly price every leg by a factor of a
 * thousand and hand drivers targets nobody could question.
 *
 *   npx tsx scripts/vietmap-matrix.test.mts
 */

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

// The exact response body from https://maps.vietmap.vn/docs/map-api/matrix-version/matrix-v4/
const DOC_RESPONSE = {
  code: "OK",
  messages: null,
  durations: [[230, 201, 386, 193], [126, 188, 435, 108]],
  distances: [[1766.3, 1374.3, 1952.2, 1113.5], [507.5, 1152.4, 2101.8, 399.4]],
};

let lastUrl = "";
let calls = 0;
const realFetch = globalThis.fetch;
function stubFetch(body: unknown, status = 200) {
  globalThis.fetch = (async (u: string | URL | Request) => {
    lastUrl = String(u); calls++;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const { vietmapMatrix, vietmapMatrixOneToMany } = await import("../src/lib/vietmap");

const origins = [{ lat: 10.768897, lon: 106.678505 }, { lat: 10.765496, lon: 106.67626 }];
const dests = [
  { lat: 10.7627936, lon: 106.6750729 }, { lat: 10.7616745, lon: 106.6792425 },
  { lat: 10.765605, lon: 106.685383 }, { lat: 10.766843, lon: 106.674029 },
];

// ── Request shape ───────────────────────────────────────────────────────────
stubFetch(DOC_RESPONSE);
const m = await vietmapMatrix(origins, dests, "TEST-KEY");

check("all six points are sent, origins first", (lastUrl.match(/point=/g) ?? []).length === 6);
check("sources index the origins", lastUrl.includes("sources=0;1"), lastUrl);
check("destinations index the rest", lastUrl.includes("destinations=2;3;4;5"), lastUrl);
check("asks for the motorcycle profile", lastUrl.includes("vehicle=motorcycle"));
check("no annotation param, so both arrays come back", !lastUrl.includes("annotation="));
check("hits matrix v4", lastUrl.startsWith("https://maps.vietmap.vn/api/matrix/v4?"));

// ── Units and orientation ───────────────────────────────────────────────────
check("matrix is origins × destinations", m.length === 2 && m[0].length === 4);
// 1766.3 m → 1.8 km, 230 s → 4 min
check("metres → km", m[0][0]?.distance_km === 1.8, String(m[0][0]?.distance_km));
check("seconds → minutes", m[0][0]?.eta_mins === 4, String(m[0][0]?.eta_mins));
// Second row, last column: 399.4 m → 0.4 km, 108 s → 2 min. Catches a transposed matrix.
check("row 1 col 3 is not transposed", m[1][3]?.distance_km === 0.4 && m[1][3]?.eta_mins === 2,
  JSON.stringify(m[1][3]));

// ── Failure paths ───────────────────────────────────────────────────────────
stubFetch({ code: "OVER_DAILY_LIMIT", messages: "quota" });
const overLimit = await vietmapMatrix(origins, dests, "TEST-KEY");
check("a non-OK code yields all nulls", overLimit.every((r) => r.every((c) => c === null)));

stubFetch({ code: "OK", durations: [[100]], distances: [[null]] });
const noDist = await vietmapMatrix([origins[0]], [dests[0]], "TEST-KEY");
check("a duration with no distance is not usable", noDist[0][0] === null);

stubFetch(DOC_RESPONSE, 429);
const rate = await vietmapMatrix(origins, dests, "TEST-KEY");
check("HTTP 429 yields all nulls", rate.every((r) => r.every((c) => c === null)));

calls = 0;
const noKey = await vietmapMatrix(origins, dests, "");
check("no key → nulls and NO request fired", calls === 0 && noKey[0][0] === null);

// ── The 1→N convenience wrapper ─────────────────────────────────────────────
stubFetch({ code: "OK", durations: [[230, 201]], distances: [[1766.3, 1374.3]] });
const one = await vietmapMatrixOneToMany(10.768897, 106.678505, [dests[0], dests[1]], "TEST-KEY");
check("1→N returns a flat row", one.length === 2 && one[0]?.distance_km === 1.8);
check("1→N sends a single source", lastUrl.includes("sources=0") && lastUrl.includes("destinations=1;2"), lastUrl);

globalThis.fetch = realFetch;
console.log(failures === 0 ? "\nAll VietMap matrix checks passed." : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
