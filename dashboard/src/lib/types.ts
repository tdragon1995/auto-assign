// config-audit.ts is a LEAF — it imports nothing at all, by design — so taking a
// type from it here is one-way and cannot cycle. The overlap shape lives there
// because that is where it is derived; it appears in Config because that is how
// it reaches the dashboard.
import type { ShiftOverlap } from "./config-audit";
export type { ShiftOverlap, OverlapSide } from "./config-audit";

export interface Mapping {
  customer_id: string;
  driver_id: string;
  smart_driver_id: string[]; // sheet col: smart_driver_id — comma-separated UUIDs; replaces fixed driver_id routing
  // sheet col: dropoff_id — the destination this row applies to. BLANK means "any
  // destination", which is what all ~1,700 legacy rows are, so a blank row keeps
  // behaving exactly as it did before this column existed.
  //
  // Filled in, the row applies ONLY to jobs going there: it is how one branch
  // sends to two places under two drivers (D014 → D001 is one driver, D014 → D007
  // is another). Selection is most-specific-wins — see mappingsForRoute().
  //
  // NOT to be confused with alt_drop_off_id, which REWRITES a job's destination
  // before assigning. This one only matches; it never changes the job.
  dropoff_id: string;
  first_name_last_name: string;
  shift_start: { hours: number; minutes: number } | null;
  shift_end: { hours: number; minutes: number } | null;
  bot_token: string;
  chat_id: string;
  alt_drop_off_id: string;
}

/**
 * A config line that names a branch but no driver — the record of a branch
 * waiting to be set up.
 *
 * This IS the to-do list, and it lives in the sheet on purpose. A row like this
 * is dropped when the config is parsed, so it can never route anything; it sits
 * there as a note to a human. Reading them back out is what turns the sheet into
 * something the dashboard can show and act on, instead of a place you have to
 * remember to go and look at.
 */
export interface UnfinishedConfigRow {
  /** 1-based row in the tab, so a save can go back to the same line. Treated as
   *  a hint and re-checked before writing, never trusted on its own. */
  row: number;
  /** The branch this row is for — what decides whether some OTHER rule already
   *  covers it, which is what makes this row redundant rather than outstanding. */
  customer_id: string;
  pickup_name: string;
  /** The destination the row is scoped to, or "" for any. */
  dropoff_name: string;
  /** "HH:MM–HH:MM" when the row carries a window, else null. */
  window: string | null;
}

/**
 * An hour a branch is configured for, except that no rule covers it — recorded
 * because a real job fell into it.
 *
 * NOT derived from the config alone. 72 branches have a hole somewhere between
 * their first and last covered minute, and those collapse into five recurring
 * windows that look like shift handovers and a lunch break: nothing in the sheet
 * says which are deliberate. So only a hole that has actually swallowed a job
 * is reported, and the evidence is the job.
 */
/** One rule as it stands in the sheet, with the row so it can be edited back. */
export interface BranchRule {
  row: number;
  driver: string;
  /** "HH:MM", or "" for a rule with no window (covers the whole day). */
  start: string;
  end: string;
}

export interface CoverageGap {
  customer_id: string;
  pickup_name: string;
  /** Where the job that fell into the hole was going, for context — shown grey
   *  beside the branch, the same as on an unfinished row. Blank when the job
   *  had no dropoff stop, when the record predates this field, or when the
   *  minutes collapsed into this hole were going to different places (in which
   *  case naming one of them would be a lie). Display only: it never scopes the
   *  rule the editor writes. */
  dropoff_name?: string;
  /** "HH:MM" — the earliest time a job needed and nobody was on. */
  at: string;
  /** Other minutes that fell into the SAME hole, earliest first. A gap is
   *  recorded per minute, so one standing hole collects a fresh minute every day
   *  it swallows a job; they are shown as one to-do with this as the tally.
   *  Optional: a snapshot written by an older deploy will not carry it. */
  also?: string[];
  /** The rule whose cover ENDS before the hole, and the one that starts after.
   *  Either can be absent at the ends of the day. Each carries its sheet row so
   *  the boundary can be moved from the dashboard. */
  before: { row: number; driver: string; window: string } | null;
  after: { row: number; driver: string; window: string } | null;
}

export interface Config {
  mappings: Mapping[];
  /** Branches with a line but no driver. Empty on a tab that has none. */
  unfinished: UnfinishedConfigRow[];
  /** Hours a job needed and no rule covered, still uncovered as of this parse. */
  gaps: CoverageGap[];
  /**
   * Pairs of fixed rules covering one branch at the same minute.
   *
   * The other half of the same fault as a gap, and it was reported for a long
   * time only as a sentence in the sheet-alarm banner — while a gap got a row
   * with a one-click fix. Both end the same way at assign time: a gap fails the
   * job as NO_DRIVER, an overlap as CLASH, and neither gets assigned.
   *
   * Unlike a gap this needs no runtime record: an overlap is fully visible in
   * the sheet, so it is derived on every parse rather than learned from a job
   * falling into it.
   */
  overlaps: ShiftOverlap[];
  /**
   * The rules each branch in those two lists already has, keyed by branch.
   *
   * Shared rather than repeated on every entry: several rows can belong to one
   * branch, and the editor needs the branch's WHOLE day — you cannot judge
   * whether a window is free without seeing everything beside it. Only branches
   * that actually appear are included, so this stays small.
   */
  branchRules: Record<string, BranchRule[]>;
  /**
   * When the sheet was last actually READ, "YYYY-MM-DD HH:MM:SS".
   *
   * Not the same as when the cycle ran. The parse is deliberately event-based —
   * re-downloading the table every cycle would cost far more than it is worth —
   * so a hand-edit to the sheet is invisible until someone presses Refresh or the
   * day turns over. Everything derived from the parse inherits that, and the
   * to-do list is where it shows most, because its whole job is to reflect what a
   * person just did in the sheet. Surfacing the time is what stops a row that has
   * already been fixed looking like a bug.
   */
  parsedAt: string;
}

// A driver read from the sheet's Driver tab (not a live Cartrack fetch), with
// deactivated accounts dropped — see loadDriversFromSheet. Used to populate the
// manual "Gán thủ công" picker in the Cần xử lý panel, and the substitute picker
// in the leave panel, without an /api/drivers call.
export interface ConfigDriver {
  driver_id: string;
  name: string;
}

export interface Stop {
  stop_id?: number;
  stop_type_id?: number;
  stop_status_id?: number;
  customer_id?: string;
  customer_name?: string;
  name?: string;
  address?: string;
  address_line_1?: string;
  latitude?: number | null;
  longitude?: number | null;
  note?: string;
  activity_started_ts?: string | null;
  activity_arrived_ts?: string | null;
  activity_completed_ts?: string | null;
  delivery_windows?: { time_from?: string; time_to?: string }[];
}

// The driver block Cartrack embeds in each job of the `GET /jobs` list response
// (verified against a 738-job prod dump). Only the fields the completed-jobs export
// reads are typed here; the real object carries many more.
export interface JobDriver {
  delivery_driver_id?: string;
  first_name?: string | null;
  last_name?: string | null;
  device_description?: string | null;
}

export interface Job {
  job_id: number;
  job_status_id?: number;
  job_type_id?: number;
  create_ts?: string;
  scheduled_delivery_ts?: string | null;
  send_to_driver_at?: string | null;
  reference_number?: string;
  labels?: string[];
  delivery_driver_id?: string | null;
  assigned_ts?: string | null;
  // Recurring-plan association (Cartrack route plans). computePickupWarnings uses it
  // to skip plan-slot jobs; also carried on timeline-derived jobs.
  last_assigned_plan_id?: number | null;
  // Embedded in `GET /jobs` list rows for assigned/completed jobs; null when the
  // job is unassigned (e.g. parked on a plan/proxy driver).
  driver?: JobDriver | null;
  // Batch IDs (Mã Batch). Present on the REST detail payload as items[].tracking_number
  // and on timeline stops as itemTrackingNumbers — so the /qr list can show them
  // without a per-job detail fetch.
  item_tracking_numbers?: string[];
  stops: Stop[];
}

export interface Driver {
  delivery_driver_id: string;
  first_name: string;
  last_name: string;
  last_login_ts?: string;
  is_online: boolean;
  is_active: boolean;
  phone_number?: string;
  latitude: number | null;
  longitude: number | null;
  driver_status_id: number;
  start_location_customer_id?: string | null;
  shift_time_start?: string | null;
}

// --- delivery_timeline_route_list (JSONRPC) ---

export interface TimelineDeliveryWindow {
  stopId: number;
  timeFrom: string; // e.g. "11:00:00+07"
  timeTo: string;
}

/**
 * One stop as delivery_timeline_route_list returns it.
 *
 * This interface used to list only the fields its first caller happened to read,
 * which made it look authoritative while being incomplete — and the omission was
 * nearly costly: the morning rollover skips plan-attached jobs (rolling one
 * duplicates it, because the plan regenerates its own copy daily), and because
 * `lastAssignedPlanId` was missing here it looked as though the timeline could
 * not tell a plan job from an ad-hoc one. It can. Field presence below was
 * counted over 2196 live stops across two days (prod, 2026-08-17) rather than
 * sampled, so "optional" means genuinely sometimes-absent.
 *
 * Keys always present but observed only ever null in that census are typed
 * nullable rather than optional.
 */
export interface TimelineStop {
  stopId: number;
  jobId: number;
  stopTypeId: number;
  stopStatusId: number;
  customerId: string;
  customerName: string;
  deliveryDriverId: string;
  referenceNumber: string;
  orderId: string;
  sendToDriverAt: string | null;
  allowedToStartAt: string | null;
  scheduledDeliveryTs: string | null;
  isPlanning: boolean;
  firstStopStatusId: number;
  deliveryDate: string;
  jobStatusId: number;
  deliveryWindows: TimelineDeliveryWindow[];
  // RPC returns label OBJECTS here; the REST job shape returns plain strings.
  // Anything reading this must normalise both — see timelineRoutesToJobs and
  // isChamCong, which do.
  jobLabels: Array<{ labelId?: number; userId?: number; label?: string } | string>;
  // Present on 94% of stops — a static per-leg estimate, NOT a live ETA.
  etaInSeconds?: number;
  latitude: number;
  longitude: number;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  countryId: number | null;
  subuserId: string | null;
  clientReference: string | null;
  expectedDurationInMinutes: number | null;
  itemTrackingNumbers: string[];
  itemsWeightInKg: number | null;
  itemsVolumeInCubicCm: number | null;
  requiredCapabilities: unknown[];
  isCourierJob: boolean;
  isForceCompleted: boolean;
  activityCompletedTs: string | null;
  activityArrivedTs: string | null;
  activityStartedTs: string | null;
  activityRejectedTs: string | null;
  rejectedByName: string | null;
  // ── Plan fields. `lastAssignedPlanId` is the one the rollover's plan check
  //    reads; all four are present on 100% of stops. ────────────────────────
  planId: number | null;
  lastAssignedPlanId: number | null;
  planName: string | null;
  planOrdering: number | null;
  plannedOffsetSeconds: number | null;
  recurrence: {
    dtstart: string | null;
    freq: string | null;
    until: string | null;
    daysOfWeek?: string[] | null;
    interval?: number | null;
  } | null;
  routeName: string | null;
  routeNameCreateTs: string | null;
}

export interface TimelineRoute {
  routeId: string; // "driver_<uuid>"
  orderedStops?: TimelineStop[];
}

export interface TimelineRouteListResult {
  routes: TimelineRoute[];
  meta: { total: number; peakMemUsage: string; avgMemPerElement: string };
}

// ---

export type LogLevel = "OK" | "ERROR" | "WARN" | "INFO";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  // In-process only, never persisted: set once an entry has already been written
  // to the run log by an early flush, so the end-of-cycle write skips it instead
  // of storing it twice. Exists because a cycle killed by the 60s timeout used to
  // lose every line it had produced — the end-of-cycle write is the only one, and
  // a kill never reaches it. See the rollover flush in assign.ts.
  pushed?: boolean;
}

export interface AssignResult {
  logs: LogEntry[];
}

export interface PickupWarning {
  job_id: number;
  reference_number: string | null;
  pickup_customer_name: string | null;
  dropoff_customer_name: string | null;
  driver_id: string;
  driver_name: string | null;
  reason: "overdue" | "window_expiring";
  minutes_late?: number;    // overdue: minutes past 90
  window_time_to?: string;  // windowed pickup: raw window end "HH:mm:ss+07:00"
  window_time_from?: string; // windowed pickup: raw window start "HH:mm:ss+07:00"
  create_ts?: string | null; // ASAP pickup (no window): job creation time, raw Cartrack ts
  // Set ("HH:mm") only when the job's own anchor fell before the working day
  // started and the clock was floored there instead — overnight bookings and
  // rolled-over jobs. Displays take precedence over create_ts / the window so the
  // delay shown is measured against the time it was actually counted from.
  clock_from?: string;
}

// A job the last full cycle could not assign for a deterministic, per-job reason
// that recurs every cycle (no driver on duty, no mapping, driver clash, …). Kept
// as a live snapshot — replaced each cycle — so the dashboard "Cần xử lý" panel
// shows the current set instead of the live log re-printing the same error every
// 3 minutes. `detail` is the human-readable specifics; `ts` is when last seen.
export type FailedReason =
  | "NO_MAPPING"      // customer not configured in the sheet
  | "NO_DROPOFF_RULE" // customer IS configured, but no row covers this destination
  | "NO_DRIVER"       // no driver / candidate on duty for this shift
  | "CLASH"           // multiple fixed drivers on duty — ambiguous
  | "SUB_CLASH"       // multiple substitutes cover the on-leave driver
  | "ON_LEAVE"        // assigned driver on leave, no substitute covers now
  | "INVALID_DRIVER"  // broken driver_id in the sheet (#REF!, …)
  | "UNAVAILABLE"     // all ranked smart candidates on-break/offline
  | "DEACTIVATED"     // driver account deactivated in Cartrack (left the company)
  | "NO_GPS";         // pickup or all candidates missing coordinates

export interface FailedJob {
  job_id: number;
  // Full route label "<pickup> → <dropoff>" (matches the log-line convention in
  // api/admin/search-jobs). Falls back to the pickup customer when no route.
  customer: string;
  reason: FailedReason;
  detail: string;
  level: "ERROR" | "WARN";
  ts: string;
  // Pickup delivery window as "HH:mm–HH:mm" (or just "HH:mm" when the job carries
  // only a start), when the job has one. The supervisor picking a driver by hand
  // needs the appointment time to judge urgency; absent for ASAP jobs.
  delivery_window?: string;
  /**
   * Pickup and destination coordinates as "lat,lng;lat,lng", so the row can
   * offer a real route rather than a link into Cartrack's own map.
   *
   * A compact string rather than four numbers because this is republished with
   * every cycle: ~28 characters per failing job, against a store already close
   * to its monthly allowance. Absent when either stop has no coordinates, which
   * is what makes the link conditional rather than broken.
   */
  route_gps?: string;
}

// A spreadsheet tab the engine REFUSED to read, because a column it cannot work
// without was missing or the response was not CSV at all. The last good copy of
// that tab keeps being served, so the engine carries on — but it is now working
// from something older than the sheet, which is a thing a person has to be told.
//
// Not a FailedJob: no job has failed, and by design none will. This is the tab
// itself reporting that it has been edited into a state the engine cannot read.
export interface SheetAlarm {
  /**
   * What KIND of trouble, because the two need opposite words.
   *
   * "refused" — the tab could not be read. The engine is serving its last good
   *   copy, so every edit since is being ignored and the fix is urgent.
   * "data"    — the tab read perfectly; some of its ROWS are wrong. Nothing is
   *   stale, edits take effect normally, and the fix is to the rows.
   *
   * Optional for old snapshots, which only ever carried refusals; absent is
   * read as "refused".
   */
  kind?: "refused" | "data";
  /** Human name of the tab, e.g. "config (mapping)". */
  label: string;
  /** Why it was refused, in Vietnamese, e.g. "thiếu cột driver_id". */
  reason: string;
  ts: string;
}

export const DRIVER_STATUS_CONFIG: Record<
  number,
  { name: string; color: string }
> = {
  1: { name: "Online", color: "#27ae60" },
  2: { name: "On Route", color: "#3498db" },
  3: { name: "Not Active", color: "#95a5a6" },
  4: { name: "Offline", color: "#e74c3c" },
  5: { name: "On Break", color: "#f39c12" },
};
