import { BASE_URL, PROXY_DRIVER_ID, assignJob, createJob, getHeaders, getStopsByLabels, type Env } from "./cartrack";
import { SHEET_GID, SHEET_CONTRACT, fetchSheetRows, isSheetShapeError, noteSheetLoad } from "./sheets";
import { vnDate, vnTimestamp } from "./time";

const WEEKDAY_COLUMNS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const TZ = "Asia/Ho_Chi_Minh";

export const SCHEDULE_JOB_LABEL = "📅 Lịch cố định";

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export interface ScheduleJobRow {
  rowIndex: number;
  pickup_id: string;
  pickup_name: string;
  dropoff_id: string;
  dropoff_name: string;
  delivery_window: string;
  reference: string;
  sent_to_driver_before: number;
  days: boolean[];
  /** Pre-assigned driver (sheet `driver` / `driver_id`). Empty = no pre-assign:
   *  the released job goes through the normal assign cycle (mapping / smart). */
  driver_name: string;
  driver_id: string;
}

export interface ScheduleJobResult {
  rowIndex: number;
  pickup_id: string;
  pickup_name: string;
  dropoff_id: string;
  dropoff_name: string;
  delivery_window: string;
  reference_number: string;
  status: "OK" | "SKIPPED" | "ERROR";
  message: string;
  job_id?: number;
}

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "x" || v === "checked";
}

/** Today's weekday index in Asia/Ho_Chi_Minh: 0=Sun .. 6=Sat. */
export function vnWeekdayIndex(d: Date = new Date()): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(d);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

export async function loadScheduleJobRows(): Promise<ScheduleJobRow[]> {
  const rows = await fetchSheetRows(SHEET_GID.schedule_job, SHEET_CONTRACT.schedule_job).catch((e) => {
    if (isSheetShapeError(e)) noteSheetLoad(e.sheetLabel, e);
    throw e;
  });
  noteSheetLoad(SHEET_CONTRACT.schedule_job.label, null);
  return rows.map((r, i) => ({
    rowIndex: i + 2,
    pickup_id: (r.master_pickup_id || r.pickup_id || "").trim(),
    pickup_name: (r.pickup ?? "").trim(),
    dropoff_id: (r.master_dropoff_id || r.dropoff_id || "").trim(),
    dropoff_name: (r.dropoff ?? "").trim(),
    delivery_window: (r.delivery_windows ?? "").trim(),
    reference: (r.reference ?? "").trim(),
    sent_to_driver_before: parseInt(r.sent_to_driver_before ?? "", 10) || 60,
    days: WEEKDAY_COLUMNS.map((col) => parseBool(r[col])),
    // The sheet's header is "Driver"; a lowercase "driver" is accepted too.
    driver_name: (r.Driver || r.driver || "").trim(),
    // A Master row may deliberately clear its pre-assignment; ignore stale formulas.
    driver_id: (r.master_pickup_id ? r.master_driver_id ?? "" : r.driver_id ?? "").trim(),
  }));
}

/** Strip the `_YYYY-MM-DD` suffix buildReferenceNumber appends, giving back the
 *  sheet's `reference` value. Null when the job wasn't created by this module. */
export function scheduleReferenceBase(referenceNumber: string | null | undefined): string | null {
  const m = /^(.+)_\d{4}-\d{2}-\d{2}$/.exec(referenceNumber ?? "");
  return m ? m[1] : null;
}

/** sheet `reference` → pre-assigned driver, for rows that have one. Read live at
 *  release time, so editing the driver in the sheet/dashboard applies to jobs
 *  already parked today. */
export async function loadSchedulePreassignments(): Promise<Map<string, { driver_id: string; driver_name: string }>> {
  const rows = await loadScheduleJobRows();
  const out = new Map<string, { driver_id: string; driver_name: string }>();
  for (const r of rows) {
    if (r.reference && r.driver_id && !out.has(r.reference)) {
      out.set(r.reference, { driver_id: r.driver_id, driver_name: r.driver_name });
    }
  }
  return out;
}

export function filterRowsForToday(
  rows: ScheduleJobRow[],
  weekdayIndex: number,
): ScheduleJobRow[] {
  return rows.filter(
    (r) =>
      r.pickup_id &&
      r.dropoff_id &&
      r.delivery_window &&
      r.days[weekdayIndex] === true,
  );
}

/** Add `minutes` to a "HH:MM" time, clamped to 23:59. */
function addMinutes(hhmm: string, minutes: number): string {
  const m = TIME_RE.exec(hhmm);
  if (!m) return hhmm;
  let total = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + minutes;
  if (total >= 24 * 60) total = 24 * 60 - 1;
  if (total < 0) total = 0;
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function buildReferenceNumber(
  row: ScheduleJobRow,
  dateStr: string,
): string {
  const base = row.reference || `schedule_${row.pickup_id.slice(0, 8)}_${row.delivery_window}`;
  return `${base}_${dateStr}`;
}

type ScheduleLookup = {
  known: Map<string, number>;
  pending: Map<string, Promise<ScheduleJobResult>>;
  restSearches: number;
};

/** A positive RPC hit is sufficient; a miss is checked against REST because the
 * stop list is scoped to today's schedule and can omit a re-dated job. */
async function loadScheduleLookup(date: string, env: Env): Promise<ScheduleLookup> {
  const known = new Map<string, number>();
  const stops = await getStopsByLabels(date, [SCHEDULE_JOB_LABEL], env).catch(() => null);
  if (stops) for (const stop of stops) {
    if (typeof stop.reference_number === "string" && Number.isSafeInteger(stop.job_id) && stop.job_id > 0)
      known.set(stop.reference_number, stop.job_id);
  }
  console.log(`[schedule-job] shared RPC ${stops ? "ready" : "unavailable"}; positive references=${known.size}`);
  return { known, pending: new Map(), restSearches: 0 };
}

/** Cartrack's filter may return similar references; equality is checked locally.
 * A failed or incomplete search must never authorize creating another job. */
export async function findScheduledJobByReference(referenceNumber: string, env: Env): Promise<number | null> {
  const limit = 100;
  for (let page = 1; page <= 100; page++) {
    const params = new URLSearchParams({ "filter[reference_number]": referenceNumber, page: String(page), limit: String(limit), per_page: String(limit) });
    const res = await fetch(`${BASE_URL}/jobs?${params}`, { headers: getHeaders(env), cache: "no-store" });
    if (!res.ok) throw new Error(`Reference search failed (HTTP ${res.status})`);
    const body = await res.json();
    if (!body || !Array.isArray(body.data)) throw new Error("Malformed reference search response");
    for (const job of body.data) {
      if (!job || typeof job.reference_number !== "string") throw new Error("Malformed reference search job");
      if (job.reference_number === referenceNumber) {
        if (!Number.isSafeInteger(job.job_id) || job.job_id <= 0) throw new Error("Reference match has no valid job ID");
        return job.job_id;
      }
    }
    const rawLastPage = body.meta?.last_page ?? body.pagination?.last_page;
    if (rawLastPage != null) {
      const lastPage = Number(rawLastPage);
      if (!Number.isSafeInteger(lastPage) || lastPage < 0 || (lastPage === 0 && body.data.length > 0) || (lastPage > 0 && lastPage < page))
        throw new Error("Malformed reference search pagination");
      if (page >= lastPage) return null;
    } else if (body.data.length < limit) return null;
  }
  throw new Error("Reference search exceeded pagination limit");
}

function buildJobPayload(
  row: ScheduleJobRow,
  refNumber: string,
  sendToDriverAt: string,
) {
  const pickupTo = addMinutes(row.delivery_window, 30);
  return {
    job_type_id: 1,
    schedule_type_id: 1,
    reference_number: refNumber,
    labels: [SCHEDULE_JOB_LABEL],
    send_to_driver_at: sendToDriverAt,
    stops: [
      {
        stop_type_id: 1,
        customer_id: row.pickup_id,
        duration: 5,
        delivery_windows: [
          {
            time_from: `${row.delivery_window}:00+07:00`,
            time_to: `${pickupTo}:00+07:00`,
          },
        ],
        todos: [
          {
            todo_type_id: 2,
            description:
              "Chụp rõ số lượng và thông tin của mẫu/giấy tờ/vật tư nhận",
          },
          {
            todo_type_id: 5,
            description:
              "Ghi rõ số lượng và loại mẫu/giấy tờ/vật tư nhận",
          },
        ],
      },
      {
        stop_type_id: 2,
        customer_id: row.dropoff_id,
        duration: 5,
        todos: [
          {
            todo_type_id: 2,
            description:
              "Chụp rõ số lượng và thông tin của mẫu/giấy tờ/vật tư giao tại khu vực bàn giao",
          },
        ],
      },
    ],
  };
}

export async function createScheduleJob(
  row: ScheduleJobRow,
  dateStr: string,
  env: Env,
  lookup?: ScheduleLookup,
): Promise<ScheduleJobResult> {
  const refNumber = buildReferenceNumber(row, dateStr);
  const base: Omit<ScheduleJobResult, "status" | "message"> = {
    rowIndex: row.rowIndex,
    pickup_id: row.pickup_id,
    pickup_name: row.pickup_name,
    dropoff_id: row.dropoff_id,
    dropoff_name: row.dropoff_name,
    delivery_window: row.delivery_window,
    reference_number: refNumber,
  };

  if (!row.reference) {
    return {
      ...base,
      status: "ERROR",
      message: `Missing reference value in sheet row ${row.rowIndex}`,
    };
  }

  if (!TIME_RE.test(row.delivery_window)) {
    return {
      ...base,
      status: "ERROR",
      message: `Invalid delivery_windows time: "${row.delivery_window}" (expected HH:MM)`,
    };
  }

  try {
    let existingId = lookup?.known.get(refNumber);
    if (!existingId) {
      if (lookup) lookup.restSearches++;
      existingId = await findScheduledJobByReference(refNumber, env) ?? undefined;
    }
    if (existingId) {
      return {
        ...base,
        status: "SKIPPED",
        message: `Already exists today (Job #${existingId})`,
        job_id: existingId,
      };
    }

    // send_to_driver_at = delivery_window - sent_to_driver_before minutes
    const windowDate = new Date(`${dateStr}T${row.delivery_window}:00+07:00`);
    const sendAt = new Date(windowDate.getTime() - row.sent_to_driver_before * 60 * 1000);
    const sendToDriverAt = vnTimestamp(sendAt);

    const payload = buildJobPayload(row, refNumber, sendToDriverAt);

    const res = await createJob(payload, env);

    if (!res.ok) {
      return {
        ...base,
        status: "ERROR",
        message: `HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 240)}`,
      };
    }

    const created = res.body ?? {};
    const jobId = created?.data?.job_id;

    if (!jobId) {
      return { ...base, status: "ERROR", message: "Job created but no job_id returned" };
    }

    // Record the create before parking; a park failure still means the job exists.
    lookup?.known.set(refNumber, jobId);

    // Park in proxy driver — driver receives it at send_to_driver_at. A
    // pre-assigned driver is applied at release (releaseDueProxyJobs), not here:
    // Cartrack re-stamps send_to_driver_at on reassignment, so assigning the real
    // driver now would push the job to their app hours early.
    const parkRes = await assignJob(PROXY_DRIVER_ID, jobId, env);
    if (parkRes.status !== 200) {
      return {
        ...base,
        status: "ERROR",
        message: `Created Job #${jobId} but proxy assign failed (HTTP ${parkRes.status})`,
        job_id: jobId,
      };
    }

    return {
      ...base,
      status: "OK",
      message: `Created Job #${jobId} · parked until ${sendToDriverAt}${row.driver_id ? ` · pre-assigned ${row.driver_name || row.driver_id}` : ""}`,
      job_id: jobId,
    };
  } catch (e) {
    return {
      ...base,
      status: "ERROR",
      message: String(e),
    };
  }
}

export async function runScheduleJobCycle(
  env: Env,
): Promise<{ date: string; weekday: number; results: ScheduleJobResult[] }> {
  const start = Date.now();
  const date = vnDate();
  const weekday = vnWeekdayIndex();

  // Always re-fetch fresh rows from the sheet and filter by today.
  // Retry re-runs the same set — findExistingJob inside createScheduleJob
  // returns SKIPPED for jobs already created, so only true failures get retried.
  const allRows = await loadScheduleJobRows();
  const targets = filterRowsForToday(allRows, weekday);
  const lookup = await loadScheduleLookup(date, env);

  // Batched, not one-at-a-time: each row is a lookup + create + park (three REST
  // calls), and on a slow Cartrack morning 13 rows in sequence overran the 60s
  // function limit — the kill (2026-09-18 05:41) left the last 4 rows uncreated
  // and saved no run record. Rows have distinct references, so they are
  // independent. Ten matches the rollover and proxy-release batches.
  const BATCH = 10;
  // Don't stop until every row has its job: rows that failed without a job being
  // made are tried again (createScheduleJob looks the reference up first, so a
  // create that landed despite an error comes back SKIPPED, not duplicated).
  // Bounded by a deadline under the 60s limit so the run always reaches its own
  // end and saves a record — a kill saves nothing and says nothing.
  const deadline = start + 45_000;
  const byRow = new Map<number, ScheduleJobResult>();
  const needsRun = (r: ScheduleJobRow) => {
    const res = byRow.get(r.rowIndex);
    // A job_id means it exists (e.g. park failed) — re-running would only
    // find it and report SKIPPED, hiding the real error.
    return !res || (res.status === "ERROR" && !res.job_id);
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const pending = targets.filter(needsRun);
    if (!pending.length) break;
    for (let i = 0; i < pending.length && Date.now() < deadline; i += BATCH) {
      const batch = await Promise.all(
        pending.slice(i, i + BATCH).map(async (row) => {
          const ref = buildReferenceNumber(row, date);
          const existing = lookup.pending.get(ref);
          if (existing) {
            const result = await existing;
            return { ...result, rowIndex: row.rowIndex, status: result.job_id ? "SKIPPED" as const : result.status };
          }
          const task = createScheduleJob(row, date, env, lookup);
          lookup.pending.set(ref, task);
          try { return await task; } finally { lookup.pending.delete(ref); }
        }),
      );
      for (const r of batch) byRow.set(r.rowIndex, r);
    }
    if (Date.now() >= deadline) break;
  }

  const results = targets.map((row) => byRow.get(row.rowIndex) ?? {
    rowIndex: row.rowIndex,
    pickup_id: row.pickup_id,
    pickup_name: row.pickup_name,
    dropoff_id: row.dropoff_id,
    dropoff_name: row.dropoff_name,
    delivery_window: row.delivery_window,
    reference_number: buildReferenceNumber(row, date),
    status: "ERROR" as const,
    message: "Not attempted — out of time this run; use Retry",
  });

  console.log(`[schedule-job] rows=${targets.length} REST reference searches=${lookup.restSearches}`);

  return { date, weekday, results };
}
