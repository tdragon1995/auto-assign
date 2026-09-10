/**
 * Cached Intl formatters must preserve the exact output of the former per-call
 * formatters across date, day-of-week and midnight boundaries.
 *
 *   node scripts/time-formatters.test.mts
 */

const { vnDate, vnHoursMinutes, vnIsSunday, vnTimestamp } =
  await import("../src/lib/time");

const TZ = "Asia/Ho_Chi_Minh";
const dates = [
  new Date("2024-02-29T16:59:59.999Z"),
  new Date("2024-02-29T17:00:00.000Z"),
  new Date("2026-09-12T16:59:59.000Z"),
  new Date("2026-09-12T17:00:00.000Z"),
  new Date("2026-12-31T16:59:59.000Z"),
  new Date("2026-12-31T17:00:00.000Z"),
];

function partsValue(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((part) => part.type === type)?.value ?? "00";
}

function oldTimestamp(d: Date): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  return `${partsValue(parts, "year")}-${partsValue(parts, "month")}-${partsValue(parts, "day")} ` +
    `${partsValue(parts, "hour")}:${partsValue(parts, "minute")}:${partsValue(parts, "second")}`;
}

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  ok  " : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

console.log("\ncached Vietnam time formatters\n");
for (const d of dates) {
  const iso = d.toISOString();
  const oldDate = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(d).slice(0, 10);
  const oldWeekday = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" }).format(d);
  const oldHmParts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(d);
  const expectedHm = {
    hours: Number(partsValue(oldHmParts, "hour")),
    minutes: Number(partsValue(oldHmParts, "minute")),
  };
  const actualHm = vnHoursMinutes(d);

  check(`${iso} date`, vnDate(d) === oldDate, `${vnDate(d)} vs ${oldDate}`);
  check(`${iso} timestamp`, vnTimestamp(d) === oldTimestamp(d));
  check(`${iso} weekday`, vnIsSunday(d) === (oldWeekday === "Sunday"));
  check(`${iso} hours/minutes`,
    actualHm.hours === expectedHm.hours && actualHm.minutes === expectedHm.minutes);
}

check("Vietnam midnight advances the date", vnDate(dates[5]) === "2027-01-01");
check("Saturday-to-Sunday boundary", !vnIsSunday(dates[2]) && vnIsSunday(dates[3]));

console.log(failures === 0 ? "\nall passed\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
