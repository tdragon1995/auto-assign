import fs from "node:fs";
import path from "node:path";
for (const line of fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { getDrivers } = await import("../src/lib/cartrack");
const ds = (await getDrivers()) as unknown as Record<string, unknown>[];

/** Last 9 digits: strips a leading 0, a 84 country code, and the single
 *  disambiguating character that used to be prefixed to duplicate numbers. */
const core = (p: unknown) => {
  const digits = String(p ?? "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : "";
};

const groups = new Map<string, Record<string, unknown>[]>();
for (const d of ds) {
  const k = core(d.phone_number);
  if (!k) continue;
  groups.set(k, [...(groups.get(k) ?? []), d]);
}

const dupes = [...groups.entries()].filter(([, v]) => v.length > 1);
console.log(`drivers: ${ds.length}   phone groups: ${groups.size}   groups sharing a number: ${dupes.length}`);
let collide = 0;
const ids: string[] = [];
for (const [k, v] of dupes) {
  const anyActive = v.some((d) => d.is_active);
  const anyDead = v.some((d) => !d.is_active);
  if (anyActive && anyDead) collide++;
  console.log(`\n…${k}  (${v.length} accounts)${anyActive && anyDead ? "   << active + deactivated share this number" : ""}`);
  for (const d of v) {
    ids.push(String(d.delivery_driver_id));
    console.log(`   ${d.is_active ? "ACTIVE  " : "disabled"}  ${String(d.delivery_driver_id).slice(0, 8)}  ${String(d.first_name)} ${String(d.last_name)}  raw=${String(d.phone_number)}  lastLogin=${d.last_login_ts ?? "never"}`);
  }
}
console.log(`\ngroups where a deactivated account shares a number with an active one: ${collide}`);
fs.writeFileSync("scripts/_dupe_ids.json", JSON.stringify(ids));
