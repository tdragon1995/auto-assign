import { config as _d } from "dotenv"; _d({ path: ".env.local" });
import { getAllAssignedDriverJobs, PROXY_DRIVER_ID } from "../src/lib/cartrack";
import { vnTimestamp } from "../src/lib/time";

const parked = await getAllAssignedDriverJobs(PROXY_DRIVER_ID, "prod");
const now = Date.now();
const nowStr = vnTimestamp(new Date());
console.log(`Queue driver holds ${parked.length} job(s) — now ${nowStr}\n`);

const parse = (ts?: string | null) => {
  if (!ts) return null;
  const d = new Date(ts.trim().replace(" ", "T").replace(/\+(\d{2})$/, "+$1:00"));
  return isNaN(d.getTime()) ? null : d;
};

const noTime: any[] = [], overdue: any[] = [], ok: any[] = [];
for (const j of parked as any[]) {
  const p = (j.stops ?? []).find((s: any) => s.stop_type_id === 1);
  const win = p?.delivery_windows?.[0]?.time_from;
  const row = {
    id: j.job_id,
    ref: j.reference_number,
    day: String(j.scheduled_delivery_ts ?? "").slice(0, 10),
    win: win ? String(win).slice(0, 5) : "—",
    send: j.send_to_driver_at ?? null,
    who: p?.customer_name ?? "—",
  };
  const d = parse(j.send_to_driver_at);
  if (!d) noTime.push(row);
  else if (d.getTime() <= now) overdue.push(row);
  else ok.push(row);
}

const show = (title: string, rows: any[]) => {
  console.log(`${title}: ${rows.length}`);
  for (const r of rows.sort((a, b) => String(a.send).localeCompare(String(b.send))))
    console.log(`   ${r.id}  day ${r.day}  window ${r.win}  release ${r.send ?? "*** NONE ***"}  |  ${r.ref}  |  ${r.who}`);
  console.log();
};
show("NO RELEASE TIME (stuck forever)", noTime);
show("RELEASE TIME PASSED, still parked", overdue);
show("Waiting normally", ok);
