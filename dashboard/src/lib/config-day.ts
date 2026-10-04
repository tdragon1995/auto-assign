import { vnIsSunday } from "./time";

export type ConfigDay = "weekday" | "sunday";

/** Omitted selection preserves date-aware callers such as the to-do workflow. */
export function resolveConfigDay(value?: unknown): ConfigDay {
  if (value === undefined || value === null) return vnIsSunday() ? "sunday" : "weekday";
  if (value !== "weekday" && value !== "sunday") throw new Error("Ngày cấu hình không hợp lệ");
  return value;
}
