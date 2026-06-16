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

export interface Job {
  job_id: number;
  job_status_id?: number;
  create_ts?: string;
  scheduled_delivery_ts?: string | null;
  send_to_driver_at?: string | null;
  reference_number?: string;
  labels?: string[];
  delivery_driver_id?: string | null;
  assigned_ts?: string | null;
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

export interface TimelineStop {
  stopId: number;
  jobId: number;
  stopTypeId: number;
  stopStatusId: number;
  customerName: string;
  deliveryDriverId: string;
  referenceNumber: string;
  sendToDriverAt: string | null;
  allowedToStartAt: string | null;
  scheduledDeliveryTs: string | null;
  isPlanning: boolean;
  firstStopStatusId: number;
  deliveryDate: string;
  jobStatusId: number;
  deliveryWindows: TimelineDeliveryWindow[];
  jobLabels: string[];
  etaInSeconds: number;
  latitude: number;
  longitude: number;
  activityCompletedTs: string | null;
  activityArrivedTs: string | null;
  activityStartedTs: string | null;
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
  driver_id: string;
  driver_name: string | null;
  reason: "overdue" | "window_expiring";
  minutes_late?: number;    // overdue: minutes past 30
  window_time_to?: string;  // window_expiring: raw "HH:mm:ss+07:00"
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
  | "NO_GPS";         // pickup or all candidates missing coordinates

export interface FailedJob {
  job_id: number;
  customer: string;
  route?: string;
  reason: FailedReason;
  detail: string;
  level: "ERROR" | "WARN";
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
