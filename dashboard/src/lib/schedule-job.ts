import { BASE_URL, PROXY_DRIVER_ID, assignJob, createJob, getHeaders, type Env } from "./cartrack";
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

const SCHEDULE_JOB_LABEL = "📅 Lịch cố định";

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
    pickup_id: (r.pickup_id ?? "").trim(),
    pickup_name: (r.pickup ?? "").trim(),
    dropoff_id: (r.dropoff_id ?? "").trim(),
    dropoff_name: (r.dropoff ?? "").trim(),
    delivery_window: (r.delivery_windows ?? "").trim(),
    reference: (r.reference ?? "").trim(),
    sent_to_driver_before: parseInt(r.sent_to_driver_before ?? "", 10) || 60,
    days: WEEKDAY_COLUMNS.map((col) => parseBool(r[col])),
  }));
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

/** Look for an existing job with the same reference_number created today. */
async function findExistingJob(
  referenceNumber: string,
  dateStr: string,
  env: Env,
): Promise<number | null> {
  const params = new URLSearchParams({
    "filter[create_ts_from]": `${dateStr} 00:00:00`,
    "filter[create_ts_to]": `${dateStr} 23:59:59`,
    "filter[reference_number]": referenceNumber,
    limit: "10",
  });
  const res = await fetch(`${BASE_URL}/jobs?${params}`, {
    headers: getHeaders(env),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  const jobs = data.data ?? [];
  const match = jobs.find(
    (j: { reference_number?: string; job_id?: number }) =>
      j.reference_number === referenceNumber,
  );
  return match?.job_id ?? null;
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
    const existingId = await findExistingJob(refNumber, dateStr, env);
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

    // Park in proxy driver — driver receives it at send_to_driver_at
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
      message: `Created Job #${jobId} · parked until ${sendToDriverAt}`,
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
  const date = vnDate();
  const weekday = vnWeekdayIndex();

  // Always re-fetch fresh rows from the sheet and filter by today.
  // Retry re-runs the same set — findExistingJob inside createScheduleJob
  // returns SKIPPED for jobs already created, so only true failures get retried.
  const allRows = await loadScheduleJobRows();
  const targets = filterRowsForToday(allRows, weekday);

  const results: ScheduleJobResult[] = [];
  for (const row of targets) {
    results.push(await createScheduleJob(row, date, env));
  }

  return { date, weekday, results };
}
