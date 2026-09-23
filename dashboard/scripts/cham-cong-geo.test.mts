/**
 * One-tap chấm công: when does a tap complete itself?
 *
 * The rule decides whether a payroll punch is written without the driver touching the
 * Cartrack app, so the failure worth pinning is the silent YES: a vague reading, a
 * malformed body or a (0, 0) failed fix must never read as "at the branch". Every
 * "no" is harmless — the task is simply created open, as it always was.
 *
 *   npx tsx scripts/cham-cong-geo.test.mts
 */
const { checkPresence, parsePosition, CHAM_CONG_RADIUS_M, CHAM_CONG_MAX_ACCURACY_M } =
  await import("../src/lib/cham-cong-geo");

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

// D001, Cao Thắng — roughly. The numbers only need to be self-consistent.
const branch = { lat: 10.7725, lon: 106.6795 };
// One metre of latitude is ~1/111_320 degrees.
const north = (m: number) => ({ lat: branch.lat + m / 111_320, lng: branch.lon });

const at = (m: number, accuracy: number) => checkPresence({ ...north(m), accuracy }, branch);

check("constants are what the page promises", CHAM_CONG_RADIUS_M === 200 && CHAM_CONG_MAX_ACCURACY_M === 100);

let p = at(0, 15);
check("standing on the branch → near", p.verdict === "near" && p.distance_m === 0, JSON.stringify(p));
p = at(150, 20);
check("150m, good fix → near", p.verdict === "near" && Math.abs((p.distance_m ?? 0) - 150) <= 1, JSON.stringify(p));
p = at(199, 20);
check("199m → near", p.verdict === "near", JSON.stringify(p));
p = at(260, 20);
check("260m → far, with the distance to show the driver", p.verdict === "far" && Math.abs((p.distance_m ?? 0) - 260) <= 1, JSON.stringify(p));
p = at(5_000, 10);
check("wrong branch picked (5km) → far", p.verdict === "far", JSON.stringify(p));

p = at(0, 150);
check("on the spot but ±150m → inaccurate, not near", p.verdict === "inaccurate" && p.accuracy_m === 150, JSON.stringify(p));
p = at(50, 100);
check("accuracy exactly at the limit still counts", p.verdict === "near", JSON.stringify(p));
p = checkPresence(north(0), branch);
check("no accuracy figure → inaccurate, never assumed exact", p.verdict === "inaccurate", JSON.stringify(p));

check("no position → no_position", checkPresence(null, branch).verdict === "no_position");
check("empty object → no_position", checkPresence({}, branch).verdict === "no_position");
check("strings → no_position", checkPresence({ lat: "10.77", lng: "106.67", accuracy: 5 }, branch).verdict === "no_position");
check("(0, 0) failed fix → no_position", checkPresence({ lat: 0, lng: 0, accuracy: 5 }, branch).verdict === "no_position");
check("out-of-range lat → no_position", checkPresence({ lat: 91, lng: 106, accuracy: 5 }, branch).verdict === "no_position");
check("NaN → no_position", checkPresence({ lat: NaN, lng: 106, accuracy: 5 }, branch).verdict === "no_position");

p = checkPresence({ ...north(0), accuracy: 5 }, null);
check("branch without coordinates → no_branch", p.verdict === "no_branch", JSON.stringify(p));

check("lon is accepted as well as lng", parsePosition({ lat: 10.7, lon: 106.6, accuracy: 5 })?.lon === 106.6);
check("negative accuracy is dropped", parsePosition({ lat: 10.7, lng: 106.6, accuracy: -1 })?.accuracy === null);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall ok");
