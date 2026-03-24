export interface Mapping {
  customer_id: string;
  driver_id: string;
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
  latitude?: number | null;
  longitude?: number | null;
  note?: string;
}

export interface Job {
  job_id: number;
  job_status_id?: number;
  reference_number?: string;
  create_ts?: string;
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
}

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
