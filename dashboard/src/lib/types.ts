export interface Mapping {
  customer_id: string;
  driver_id: string;
  smart_driver_id: string[]; // sheet col: smart_driver_id — comma-separated UUIDs; replaces fixed driver_id routing
  first_name_last_name: string;
  shift_start: { hours: number; minutes: number } | null;
  shift_end: { hours: number; minutes: number } | null;
  bot_token: string;
  chat_id: string;
  alt_drop_off_id: string;
}

export interface Config {
  mappings: Mapping[];
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
}

// A spreadsheet tab the engine REFUSED to read, because a column it cannot work
// without was missing or the response was not CSV at all. The last good copy of
// that tab keeps being served, so the engine carries on — but it is now working
// from something older than the sheet, which is a thing a person has to be told.
//
// Not a FailedJob: no job has failed, and by design none will. This is the tab
// itself reporting that it has been edited into a state the engine cannot read.
export interface SheetAlarm {
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
