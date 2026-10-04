import { BASE_URL, getHeaders } from "./cartrack";
import { getReceptionistToken } from "./labcenter";
import { JOB_STATUS } from "./job-filters";
import { addDays, vnDate, vnTimestamp } from "./time";
import type { Job } from "./types";

type Fields = Record<string, string | null | undefined>;
type Sample = Fields & { sample_id: string | number };
type Order = {
  lis_order_id?: string; branch_code?: string; status?: string; created_at?: string;
  created_by_employee_code?: string; client_id?: string | number; client_type?: string;
  cancel_time?: string; cancel_by?: string; cancel_reason?: string;
  order_test_details?: unknown[];
  order_payment_details?: { created_at?: string; status?: string; payment_type?: string }[];
  tat?: { logistic_detail?: { from_location?: string; to_location?: string; duration?: string }; tests_tat?: { tat?: string }[] };
};
type Batch = {
  batch_code: string; created_at?: string; updated_at?: string; created_by?: string;
  status?: string; batch_status?: string; total_sample?: number;
  source_location?: string; destination_location?: string; transferred_at?: string;
  completed_at?: string; cancelled_at?: string;
  samples?: { sample_id: string | number; order_id?: string | number }[];
};
type LookupJob = Job & { update_ts?: string; items?: { tracking_number?: string }[]; match?: "route+time" };
export type LookupEvent = {
  time: string; source: "POS" | "LIS" | "Cartrack"; label: string;
  who?: string | null; detail?: string | null; kind: "done" | "due";
  samples: string[]; since_start_min: number; since_prev_min: number | null;
};
export type LookupStep = { step: string; msg: string };
export type LookupJobRow = {
  job_id: number; reference: string; status: string; driver: string;
  match: string; start: string; end: string; kind: string; ours: boolean;
  stops: { place: string; type: string; arrived?: string | null; completed?: string | null }[];
  batches: { code: string; branch: string; created: string | null; ours: boolean }[];
};
export type BatchLookupResult = {
  vid: string; error?: string; steps: LookupStep[]; timeline: LookupEvent[];
  phases: { label: string; minutes: number; breach?: boolean }[];
  branch_batches: { code: string; branch: string; status?: string; total_samples?: number;
    created: string | null; transferred: string | null; completed: string | null; ours: boolean; cartrack_job?: string }[];
  driver_days: { driver: string; days: string[]; jobs: LookupJobRow[] }[];
  summary: null | {
    order: { vid: string; branch?: string; status?: string; created: string | null; tests: number; route?: string; expected_transport?: string };
    client: null | { code?: string; name?: string; type?: string; segment?: string; owner?: string; supervisor_email?: string };
    samples: { sample_id: string; name?: string | null; container?: string | null; status?: string | null; stat?: string | null }[];
    batches: { code: string; status?: string; total_samples?: number; orders_in_batch: number; our_samples: string[];
      created: string | null; created_by?: string; destination?: string; transferred: string | null; completed: string | null }[];
    unbatched_samples: string[]; jobs: LookupJobRow[];
  };
};
type Emit = (kind: "doing" | "step", payload: { msg: string } | LookupStep) => void;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const BATCH_RE = /^B(\d{3})(\d{6})(\d{6})$/;
const STOP_TYPE: Record<number, string> = { 1: "Pickup", 2: "Delivery", 3: "Dropoff" };
const SAMPLE_EVENTS = [
  ["sample_generated_time", "Sample barcode generated", "sample_generated_by"],
  ["sample_collected_time", "Sample collected", "sample_collected_by"],
  ["transferred_time", "Sample transferred to HQ lab", "transferred_by"],
  ["sample_arrived_time", "Sample arrived at lab", "sample_arrived_by"],
  ["sample_checked_time", "Sample checked", "sample_checked_by"],
  ["sample_sorted_time", "Sample sorted", "sample_sorted_by"],
  ["sample_received_time", "Sample received (analyser)", "sample_received_by"],
  ["sample_canceled_time", "Sample cancelled", "sample_canceled_by"],
];

/** ISO from LIS/POS is UTC; timestamps without an offset are Vietnam time. */
export function lookupTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const iso = value.replace(" ", "T");
  const ms = Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "+07:00");
  return Number.isFinite(ms) ? ms : null;
}
const formatted = (value?: string | null) => {
  const ms = lookupTimestamp(value);
  return ms === null ? null : vnTimestamp(new Date(ms));
};
export function batchTimestamp(code?: string): number | null {
  const m = BATCH_RE.exec(code ?? "");
  if (!m) return null;
  const [, , date, time] = m;
  const iso = `20${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4, 6)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === iso.slice(0, 19) ? ms : null;
}
const driverName = (j: Job) => [j.driver?.first_name, j.driver?.last_name].filter(Boolean).join(" ");
const trackingCodes = (j: LookupJob) => [...new Set([...(j.items ?? []).map(i => i.tracking_number ?? ""), ...(j.item_tracking_numbers ?? [])])].filter(c => batchTimestamp(c) !== null);
const homeStop = (name = "") => /^\d{4,} - /.test(name);
const stopLabel = (name = "") => homeStop(name) ? `Home collection (${name.split(" - ")[1]})` : name;
function jobSpan(j: LookupJob): [string, string] {
  const times = j.stops.flatMap(s => [s.activity_started_ts, s.activity_arrived_ts, s.activity_completed_ts]).filter((s): s is string => !!s && lookupTimestamp(s) !== null).sort();
  return [times[0] ?? j.create_ts ?? "", times.at(-1) ?? j.create_ts ?? ""];
}
function jobRow(j: LookupJob, ours: Set<number>, codes: Set<string>): LookupJobRow {
  const [start, end] = jobSpan(j);
  const batchCodes = trackingCodes(j);
  const kind = j.reference_number?.startsWith("Chấm Công - Vào") ? "clock_in"
    : j.reference_number?.startsWith("Chấm Công - Ra") ? "clock_out" : batchCodes.length ? "batch"
    : j.stops.some(s => homeStop(s.customer_name)) ? "home" : "other";
  return {
    job_id: j.job_id, reference: kind === "home" ? stopLabel(j.stops.find(s => homeStop(s.customer_name))?.customer_name) : j.reference_number ?? String(j.job_id),
    status: JOB_STATUS[j.job_status_id ?? 0] ?? String(j.job_status_id ?? ""), driver: driverName(j), match: j.match ?? "batch code",
    start, end, kind, ours: ours.has(j.job_id),
    stops: j.stops.map(s => ({ place: stopLabel(s.customer_name), type: STOP_TYPE[s.stop_type_id ?? 0] ?? "Stop", arrived: s.activity_arrived_ts, completed: s.activity_completed_ts })),
    batches: batchCodes.map(code => ({ code, branch: `D${code.slice(1, 4)}`, created: vnTimestamp(new Date(batchTimestamp(code)!)), ours: codes.has(code) })),
  };
}

// ponytail: cache 12 days per server instance; use Redis only if cross-instance reuse matters.
const daysCache = new Map<string, { expires: number; jobs: Promise<LookupJob[]> }>();
async function cartrackDay(day: string, signal: AbortSignal): Promise<LookupJob[]> {
  const hit = daysCache.get(day);
  if (hit && hit.expires > Date.now()) return hit.jobs;
  const promise = (async () => {
    const jobs = new Map<number, LookupJob>();
    for (let page = 1; page <= 20; page++) {
      // Forensic creation-day scan mirrors the supplied tool; the assign cycle still uses scheduled dates.
      const params = new URLSearchParams({ "filter[create_ts_from]": `${day} 00:00:00`, "filter[create_ts_to]": `${day} 23:59:59`, limit: "1000", page: String(page) });
      const res = await fetch(`${BASE_URL}/jobs?${params}`, { headers: getHeaders(), cache: "no-store", signal });
      if (!res.ok) throw new Error(`Cartrack jobs: HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json.data)) throw new Error("Cartrack returned an unfamiliar jobs response");
      const rows: LookupJob[] = json.data;
      let added = 0;
      for (const j of rows) {
        if (!jobs.has(j.job_id)) added++;
        // Do not cache GPS paths, patient data or unrelated API fields.
        jobs.set(j.job_id, { job_id: j.job_id, create_ts: j.create_ts, update_ts: j.update_ts, assigned_ts: j.assigned_ts,
          reference_number: j.reference_number, job_status_id: j.job_status_id, delivery_driver_id: j.delivery_driver_id,
          driver: j.driver ? { first_name: j.driver.first_name, last_name: j.driver.last_name } : null,
          stops: (j.stops ?? []).map(s => ({ stop_type_id: s.stop_type_id, customer_name: s.customer_name,
            activity_started_ts: s.activity_started_ts, activity_arrived_ts: s.activity_arrived_ts, activity_completed_ts: s.activity_completed_ts })),
          items: (j.items ?? []).map(i => ({ tracking_number: i.tracking_number })), item_tracking_numbers: j.item_tracking_numbers });
      }
      const lastPage = Number(json.meta?.last_page);
      if (lastPage > 0 ? page >= lastPage : rows.length < 1000) return [...jobs.values()];
      if (!added || page === 20) throw new Error("Cartrack pagination limit reached; the search is incomplete");
    }
    return [...jobs.values()];
  })();
  const age = Math.floor((Date.parse(vnDate() + "T00:00:00Z") - Date.parse(day + "T00:00:00Z")) / DAY);
  const entry = { expires: Date.now() + (age <= 0 ? 120_000 : age === 1 ? 600_000 : 6 * 60 * MINUTE), jobs: promise };
  daysCache.set(day, entry);
  if (daysCache.size > 12) daysCache.delete(daysCache.keys().next().value!);
  try { return await promise; } catch (e) { if (daysCache.get(day) === entry) daysCache.delete(day); throw e; }
}

export function buildLookupTimeline(order: Order, samples: Sample[], batches: Batch[], jobs: LookupJob[]): LookupEvent[] {
  const events: (Omit<LookupEvent, "since_start_min" | "since_prev_min" | "time"> & { ms: number })[] = [];
  const add = (ts: string | undefined | null, source: LookupEvent["source"], label: string, who?: string | null, detail?: string | null, sample?: string, kind: "done" | "due" = "done") => {
    const ms = lookupTimestamp(ts);
    if (ms !== null) events.push({ ms, source, label, who, detail, kind, samples: sample ? [sample] : [] });
  };
  add(order.created_at, "POS", "Visit / order created", order.created_by_employee_code, `${order.branch_code ?? ""} · ${order.order_test_details?.length ?? 0} tests`);
  for (const p of order.order_payment_details ?? []) add(p.created_at, "POS", `Payment ${p.status}`, null, p.payment_type);
  add(order.cancel_time, "POS", "Order cancelled", order.cancel_by, order.cancel_reason);
  for (const s of samples) for (const [field, label, who] of SAMPLE_EVENTS) add(s[field], "LIS", label, s[who], null, String(s.sample_id));
  for (const b of batches) {
    add(b.created_at, "LIS", `Batch ${b.batch_code} created`, b.created_by, `${b.total_sample ?? "?"} samples${b.destination_location ? ` → D${b.destination_location}` : ""}`);
    add(b.transferred_at, "LIS", `Batch ${b.batch_code} transferred to HQ lab`);
    add(b.cancelled_at, "LIS", `Batch ${b.batch_code} cancelled`);
    add(b.completed_at ?? (b.batch_status === "completed" ? b.updated_at : null), "LIS", `Batch ${b.batch_code} completed`);
  }
  for (const j of jobs) {
    add(j.create_ts, "Cartrack", `Delivery job ${j.reference_number ?? j.job_id} created`, null, `Job ${j.job_id}${j.match ? " · route + time match (lower confidence)" : ""}`);
    add(j.assigned_ts, "Cartrack", "Job assigned to driver", driverName(j));
    for (const s of j.stops) {
      const type = STOP_TYPE[s.stop_type_id ?? 0] ?? "Stop";
      add(s.activity_started_ts, "Cartrack", `${type} started → ${stopLabel(s.customer_name)}`, driverName(j));
      add(s.activity_arrived_ts, "Cartrack", `Driver arrived at ${stopLabel(s.customer_name)} (${type.toLowerCase()})`, driverName(j));
      add(s.activity_completed_ts, "Cartrack", `${type} completed at ${stopLabel(s.customer_name)}`, driverName(j));
    }
  }
  const due = (order.tat?.tests_tat ?? []).map(t => lookupTimestamp(t.tat)).filter((t): t is number => t !== null);
  if (due.length) add(new Date(Math.max(...due)).toISOString(), "POS", "Results due (TAT)", null, `${due.length} test TATs`, undefined, "due");
  const merged = new Map<string, typeof events[number]>();
  for (const e of events) {
    const key = JSON.stringify([e.ms, e.source, e.label, e.who]);
    const old = merged.get(key);
    if (old) old.samples = [...new Set([...old.samples, ...e.samples])]; else merged.set(key, e);
  }
  const sorted = [...merged.values()].sort((a, b) => a.ms - b.ms || Number(a.kind === "due") - Number(b.kind === "due"));
  let previous: number | null = null;
  return sorted.map(({ ms, ...e }) => {
    const row = { ...e, time: vnTimestamp(new Date(ms)), since_start_min: Math.round((ms - sorted[0].ms) / MINUTE * 10) / 10,
      since_prev_min: previous === null ? null : Math.round((ms - previous) / MINUTE * 10) / 10 };
    if (e.kind === "done") previous = ms;
    return row;
  });
}
function durations(timeline: LookupEvent[]): BatchLookupResult["phases"] {
  const at = (prefix: string, last = false) => {
    const hits = timeline.filter(e => e.kind === "done" && e.label.startsWith(prefix));
    return lookupTimestamp((last ? hits.at(-1) : hits[0])?.time);
  };
  const ordered = at("Visit"), collected = at("Sample collected"), batched = at("Batch B"), picked = at("Pickup completed"), delivered = at("Delivery completed", true), arrived = at("Sample arrived at lab"), received = at("Sample received", true);
  const rows: [string, number | null, number | null][] = [
    ["Order → collected", ordered, collected], ["Collected → batched", collected, batched],
    ["Batched → driver pickup", batched, picked], ["Transport (pickup → drop-off)", picked, delivered],
    ["Drop-off → arrived in LIS", delivered, arrived], ["Arrived → last sample received", arrived, received],
    ["Collected → last sample received", collected, received], ["Order → last sample received", ordered, received],
  ];
  const out = rows.filter((r): r is [string, number, number] => r[1] !== null && r[2] !== null).map(([label, a, b]) => ({ label, minutes: Math.round((b - a) / MINUTE * 10) / 10, breach: false }));
  const due = lookupTimestamp(timeline.find(e => e.kind === "due")?.time);
  if (due !== null && received !== null) out.push({ label: due < received ? "TAT missed at last receipt by" : "TAT slack at last receipt", minutes: Math.round(Math.abs(due - received) / MINUTE * 10) / 10, breach: due < received });
  return out;
}

export async function lookupBatch(vid: string, emit: Emit = () => {}, signal = AbortSignal.timeout(240_000)): Promise<BatchLookupResult> {
  const out: BatchLookupResult = { vid, summary: null, timeline: [], phases: [], driver_days: [], branch_batches: [], steps: [] };
  const log = (step: string, msg: string) => { const row = { step, msg }; out.steps.push(row); emit("step", row); };
  const doing = (msg: string) => emit("doing", { msg });
  try {
    if (!/^\d{8,20}$/.test(vid)) throw new Error("VID phải gồm 8–20 chữ số.");
    const token = process.env.LABCENTER_LOOKUP_TOKEN?.trim() || await getReceptionistToken();
    if (!token) throw new Error("Labcenter lookup access is not configured. Ask an administrator to configure a POS/LIS account or lookup token.");
    async function lab<T>(path: string, params: URLSearchParams): Promise<{ data: T; pagination?: { last_page?: number; total_pages?: number } }> {
      const res = await fetch(`https://api.labcenter.vn${path}?${params}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", Origin: "https://labcenter.vn", Referer: "https://labcenter.vn/" }, cache: "no-store", signal });
      if (res.status === 404 && path.endsWith("/orders")) throw new Error(`No order found for VID ${vid}`);
      if (!res.ok) throw new Error(`Labcenter ${path}: HTTP ${res.status}${res.status === 403 ? " — this account needs POS/LIS access; configure an authorized lookup token" : res.status === 401 ? " — the lookup token has expired or is invalid" : ""}`);
      return res.json();
    }
    doing("Looking up the order and samples in Labcenter");
    const order = (await lab<Order>("/spc-pos/api/orders", new URLSearchParams({ visit_number: vid }))).data;
    if (!order || Array.isArray(order)) throw new Error(`No order found for VID ${vid}`);
    const samples = (await lab<Sample[]>("/spc-lis/api/v1/test-results/order-sample-details", new URLSearchParams({ order_id: vid }))).data;
    if (!Array.isArray(samples)) throw new Error("LIS returned an unfamiliar samples response");
    const lg = order.tat?.logistic_detail;
    out.summary = {
      order: { vid: order.lis_order_id ?? vid, branch: order.branch_code, status: order.status, created: formatted(order.created_at), tests: order.order_test_details?.length ?? 0,
        route: lg ? `${lg.from_location ?? "?"} → ${lg.to_location ?? "?"}` : undefined, expected_transport: lg?.duration },
      client: order.client_id ? { code: String(order.client_id), type: order.client_type } : null,
      samples: samples.map(s => ({ sample_id: String(s.sample_id), name: s.sample_name, container: s.sample_container_name, status: s.sample_status, stat: s.stat_sid })),
      batches: [], unbatched_samples: samples.map(s => String(s.sample_id)), jobs: [],
    };
    log("order", `${order.branch_code ?? "?"} · ${samples.length} sample(s)`);
    if (order.client_id) {
      try {
        const data = (await lab<(Fields & { code?: string })[] | Fields>("/spc-pos/api/client", new URLSearchParams({ q: String(order.client_id) }))).data;
        const rows = Array.isArray(data) ? data : data ? [data] : [];
        const c = rows.find(c => String(c.code) === String(order.client_id)) ?? (rows.length === 1 ? rows[0] : null);
        if (c) out.summary.client = { code: String(c.code ?? order.client_id), name: c.client_legal_name ?? undefined, type: c.client_type ?? undefined, segment: c.customer_segment ?? undefined, owner: c.owner ?? undefined, supervisor_email: c.supervisor_email ?? undefined };
      } catch { log("client", "Client details unavailable; continuing with the sample timeline"); }
    }
    out.timeline = buildLookupTimeline(order, samples, [], []);
    if (!samples.length) { out.phases = durations(out.timeline); log("samples", "No samples yet"); return out; }
    const collected = samples.map(s => lookupTimestamp(s.sample_collected_time)).filter((n): n is number => n !== null);
    const left = samples.map(s => lookupTimestamp(s.transferred_time) ?? lookupTimestamp(s.sample_arrived_time)).filter((n): n is number => n !== null);
    const start = collected.length ? Math.min(...collected) : lookupTimestamp(order.created_at);
    if (start === null) throw new Error("Order and samples have no valid collection/creation timestamp");
    const lo = start - 5 * MINUTE, hi = (left.length ? Math.max(...left) : lo + DAY) + 5 * MINUTE;
    if (hi < lo || hi - lo > 7 * DAY) throw new Error("The sample window is invalid or exceeds the seven-day search limit");
    const first = vnDate(new Date(lo)), last = vnDate(new Date(hi));
    const branches = [...new Set([order.branch_code, lg?.from_location].filter((b): b is string => !!b && /^D\d{3}$/.test(b)).map(b => b.slice(1)))];
    const lisRows: Batch[] = [];
    if (branches.length) {
      doing("Listing the branch's LIS batches");
      const params = new URLSearchParams({ batch_code: "", status: "", created_at_from: new Date(`${addDays(first, -1)}T00:00:00+07:00`).toISOString(), created_at_to: new Date(`${addDays(last, 1)}T23:59:59.999+07:00`).toISOString(), per_page: "100", order_direction: "asc" });
      branches.forEach(b => params.append("source_location[]", b));
      for (let page = 1; page <= 50; page++) {
        params.set("page", String(page));
        const data = await lab<Batch[]>("/spc-lis/api/v1/batch", params);
        if (!Array.isArray(data.data)) throw new Error("LIS returned an unfamiliar batch list");
        lisRows.push(...data.data);
        const total = Number(data.pagination?.last_page ?? data.pagination?.total_pages);
        if (total > 0 ? page >= total : data.data.length < 100) break;
        if (page === 50) throw new Error("LIS pagination limit reached; the search is incomplete");
      }
      log("batches", `${lisRows.length} LIS batches in the branch search window`);
    }
    const jobs = new Map<number, LookupJob>();
    const days = new Set<string>();
    async function scan(day: string) {
      if (days.has(day) || day > vnDate()) return;
      doing(`Reading Cartrack jobs for ${day}`);
      for (const j of await cartrackDay(day, signal)) {
        const old = jobs.get(j.job_id);
        if (!old || (j.update_ts ?? "") >= (old.update_ts ?? "")) jobs.set(j.job_id, j);
      }
      days.add(day); log("cartrack", `${day}: ${jobs.size} jobs across scanned days`);
    }
    for (let day = first; day <= last; day = addDays(day, 1)) await scan(day);
    const checked = new Set<string>(), confirmed: Batch[] = [];
    const missing = new Set(samples.map(s => String(s.sample_id)));
    async function verify() {
      const lisCodes = lisRows.filter(b => { const t = lookupTimestamp(b.created_at); return t !== null && t >= lo && t <= hi && b.status !== "cancelled"; }).sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "")).map(b => b.batch_code);
      const ctCodes = [...new Set([...jobs.values()].flatMap(trackingCodes))].filter(c => { const t = batchTimestamp(c)!; return t >= lo && t <= hi; }).sort((a, b) => batchTimestamp(a)! - batchTimestamp(b)!);
      const candidates = [...new Set([...lisCodes, ...ctCodes.filter(c => branches.includes(c.slice(1, 4))), ...ctCodes])];
      for (const code of candidates) {
        if (!missing.size || checked.size >= 10) break;
        if (checked.has(code)) continue;
        checked.add(code); doing(`Checking batch ${code} for this visit's samples`);
        const b = (await lab<Batch>("/spc-lis/api/v1/batch/details", new URLSearchParams({ batch_code: code }))).data;
        if (!b || !Array.isArray(b.samples)) throw new Error("LIS returned an unfamiliar batch detail");
        const inside = b.samples.map(s => String(s.sample_id)).filter(id => missing.has(id));
        log("verify", `${code}: ${inside.length ? `contains ${inside.join(", ")}` : "none of this visit's samples"}`);
        if (inside.length) {
          const row = lisRows.find(r => r.batch_code === code);
          confirmed.push({ ...b, batch_code: code, created_by: row?.created_by ?? b.created_by, source_location: row?.source_location ?? b.source_location, destination_location: row?.destination_location ?? b.destination_location, transferred_at: row?.transferred_at ?? b.transferred_at, completed_at: row?.completed_at ?? b.completed_at, cancelled_at: row?.cancelled_at ?? b.cancelled_at });
          inside.forEach(id => missing.delete(id));
        }
      }
    }
    await verify();
    if (missing.size) for (const day of [addDays(first, -1), addDays(last, 1)]) { await scan(day); await verify(); if (!missing.size) break; }
    if (missing.size) log("warning", `Batch not confirmed for ${[...missing].join(", ")}${checked.size >= 10 ? "; reached the 10-candidate verification limit" : " in the scanned window"}`);
    const codes = new Set(confirmed.map(b => b.batch_code));
    const carrying = () => [...jobs.values()].filter(j => trackingCodes(j).some(c => codes.has(c))).sort((a, b) => (a.create_ts ?? "").localeCompare(b.create_ts ?? ""));
    let batchJobs = carrying();
    if (codes.size && !batchJobs.length) {
      // A confirmed LIS batch can ride a Cartrack job created before collection.
      await scan(addDays(first, -1)); await scan(addDays(last, 1)); batchJobs = carrying();
    }
    const reaches = () => batchJobs.some(j => j.stops.some(s => s.stop_type_id !== 1 && !!lg?.to_location && s.customer_name?.includes(lg.to_location)));
    if (batchJobs.length && lg?.to_location && !reaches()) {
      const created = batchJobs.map(j => j.create_ts?.slice(0, 10)).filter((s): s is string => !!s).sort().at(-1);
      if (created) { await scan(addDays(created, 1)); batchJobs = carrying(); }
    }
    if (confirmed.length && !batchJobs.length && /^D\d{3}$/.test(order.branch_code ?? "")) {
      const word = new RegExp(`(?<![A-Z0-9])${order.branch_code}(?![0-9])`);
      const starts = confirmed.map(b => lookupTimestamp(b.created_at)).filter((n): n is number => n !== null);
      const ends = [...confirmed.map(b => lookupTimestamp(b.completed_at)), ...samples.map(s => lookupTimestamp(s.sample_arrived_time))].filter((n): n is number => n !== null);
      if (starts.length) {
        const from = Math.min(...starts), to = (ends.length ? Math.max(...ends) : from + DAY) + 15 * MINUTE;
        batchJobs = [...jobs.values()].filter(j => {
          const stops = j.stops;
          if (!stops.length || !stops.some(s => s.activity_completed_ts || s.activity_arrived_ts)) return false;
          if (word.test(stops.at(-1)?.customer_name ?? "") && !word.test(stops[0].customer_name ?? "")) return false;
          if (!word.test(j.reference_number ?? "") && !stops.some(s => s.stop_type_id === 1 && word.test(s.customer_name ?? ""))) return false;
          const [a, b] = jobSpan(j), start = lookupTimestamp(a), end = lookupTimestamp(b);
          return start !== null && end !== null && start >= from - 10 * MINUTE && end <= to;
        }).map(j => ({ ...j, match: "route+time" as const })).sort((a, b) => jobSpan(a)[0].localeCompare(jobSpan(b)[0]));
        if (batchJobs.length) log("warning", "Delivery matched by route + time only (lower confidence); no batch tracking number in Cartrack");
      }
    }
    const ours = new Set(batchJobs.map(j => j.job_id));
    out.summary.batches = confirmed.map(b => ({ code: b.batch_code, status: b.batch_status ?? b.status, total_samples: b.total_sample,
      orders_in_batch: new Set((b.samples ?? []).map(s => s.order_id)).size,
      our_samples: (b.samples ?? []).map(s => String(s.sample_id)).filter(id => samples.some(s => String(s.sample_id) === id)),
      created: formatted(b.created_at), created_by: b.created_by, destination: b.destination_location ? `D${b.destination_location}` : undefined,
      transferred: formatted(b.transferred_at), completed: formatted(b.completed_at) }));
    out.summary.unbatched_samples = [...missing];
    out.summary.jobs = batchJobs.map(j => jobRow(j, ours, codes));
    const carried = new Map([...jobs.values()].flatMap(j => trackingCodes(j).map(code => [code, j.reference_number] as const)));
    out.branch_batches = lisRows.filter(b => { const t = lookupTimestamp(b.created_at); return t !== null && vnDate(new Date(t)) >= first && vnDate(new Date(t)) <= last; }).map(b => ({
      code: b.batch_code, branch: `D${b.source_location ?? b.batch_code.slice(1, 4)}`, status: b.status, total_samples: b.total_sample,
      created: formatted(b.created_at), transferred: formatted(b.transferred_at), completed: formatted(b.completed_at), ours: codes.has(b.batch_code), cartrack_job: carried.get(b.batch_code) }));
    for (const did of new Set(batchJobs.map(j => j.delivery_driver_id).filter((s): s is string => !!s))) {
      const mine = batchJobs.filter(j => j.delivery_driver_id === did);
      const driverDays = [...new Set(mine.map(j => jobSpan(j)[0].slice(0, 10)))].sort();
      out.driver_days.push({ driver: driverName(mine[0]), days: driverDays,
        jobs: [...jobs.values()].filter(j => j.delivery_driver_id === did && driverDays.includes(jobSpan(j)[0].slice(0, 10))).sort((a, b) => jobSpan(a)[0].localeCompare(jobSpan(b)[0])).map(j => jobRow(j, ours, codes)) });
    }
    out.timeline = buildLookupTimeline(order, samples, confirmed, batchJobs);
    out.phases = durations(out.timeline);
    log("timeline", `${out.timeline.length} events · ${batchJobs.length} delivery job(s) · days scanned: ${[...days].sort().join(", ")}`);
  } catch (e) {
    out.error = signal.aborted ? "Lookup timed out or was cancelled. Please retry." : e instanceof Error ? e.message : "Lookup failed";
    log("error", out.error);
  }
  return out;
}
