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
  poll_interval_seconds: number;
  job_max_age_minutes: number;
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
