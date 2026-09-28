import { sbDelete, sbInsert, sbPatch, sbSelect, sbSelectAll } from "./supabase-rest";
import type { ConfigCells } from "./unmapped-row";
import { timeToMins } from "./time";

export type MasterRule = {
  id: number;
  source_row: number;
  row_data: Record<string, string>;
  smart_driver_id: string | null;
  smart_driver_id_manual: string | null;
  updated_at: string;
};
export type MasterClient = { customer_id: string; cartrack: Record<string, unknown>; client_code: string | null; new_ward: string | null; nearest_psc_id: string | null; nearest_psc_name: string | null; nearest_psc_km: number | null; labcenter_location_id: number | null; default_dropoff_id: string | null; default_dropoff_name: string | null; eta_minutes: number | null; sales_name: string | null; sales_email: string | null; supervisor_name: string | null; supervisor_email: string | null };
export type MasterDriver = { driver_id: string; cartrack: Record<string, unknown>; roster: Record<string, string>; driver_zalo_id: string | null; bot_token: string | null; phone_number_update: string | null };

export const masterEnabled = () => process.env.MASTER_CLIENT_INFO_SOURCE === "supabase";

export async function masterRules(day: "weekday" | "sunday"): Promise<MasterRule[]> {
  return sbSelectAll<MasterRule>("master_config_rules", `select=id,source_row,row_data,smart_driver_id,smart_driver_id_manual,updated_at&day_type=eq.${day}`, "source_row.asc");
}

/** Keep the old parser's row +2 accounting while Supabase row ids stay stable. */
export async function masterRuleRows(day: "weekday" | "sunday"): Promise<Record<string, string>[]> {
  const rules = await masterRules(day);
  const out: Record<string, string>[] = [];
  for (const rule of rules) out[rule.source_row - 2] = { ...rule.row_data, smart_driver_id: rule.smart_driver_id ?? "" };
  for (let i = 0; i < out.length; i++) out[i] ??= {};
  return out;
}

export async function masterClients(): Promise<MasterClient[]> {
  return sbSelectAll<MasterClient>("master_clients", "select=*", "customer_id.asc");
}

export async function masterDrivers(): Promise<MasterDriver[]> {
  return sbSelectAll<MasterDriver>("master_drivers", "select=*", "driver_id.asc");
}

export type RuleInput = {
  customer_id: string;
  driver_ids: string[];
  dropoff_id: string;
  shift_start: string;
  shift_end: string;
  bot_token?: string;
  chat_id?: string;
  alt_drop_off_id?: string;
};

export async function saveMasterRule(input: RuleInput, row?: number, version?: string): Promise<number> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!input || !uuid.test(input.customer_id) || !Array.isArray(input.driver_ids) ||
      input.driver_ids.some((id) => typeof id !== "string" || !uuid.test(id)) ||
      (input.dropoff_id && !uuid.test(input.dropoff_id)) ||
      (input.alt_drop_off_id && !uuid.test(input.alt_drop_off_id)) ||
      typeof input.shift_start !== "string" || typeof input.shift_end !== "string" ||
      (!!input.shift_start !== !!input.shift_end) ||
      (input.shift_start && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.shift_start) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.shift_end) ||
        timeToMins(input.shift_start) === timeToMins(input.shift_end)))) {
    throw new Error("Quy tắc không hợp lệ");
  }
  if ([input.bot_token, input.chat_id, input.alt_drop_off_id].some((v) => v !== undefined && typeof v !== "string")) throw new Error("Trường quy tắc không hợp lệ");
  const [customers, drivers, rules] = await Promise.all([masterClients(), masterDrivers(), masterRules("weekday")]);
  const byClient = new Map(customers.map((c) => [c.customer_id, c]));
  const byDriver = new Map(drivers.map((d) => [d.driver_id, d]));
  const pickup = byClient.get(input.customer_id);
  if (!pickup) throw new Error("Điểm lấy mẫu không có trong Master Client Info");
  const dropoff = input.dropoff_id ? byClient.get(input.dropoff_id) : null;
  if (input.dropoff_id && !dropoff) throw new Error("Điểm giao không có trong Master Client Info");
  if (input.driver_ids.length > 20 || new Set(input.driver_ids).size !== input.driver_ids.length) throw new Error("Danh sách tài xế không hợp lệ");
  const names = input.driver_ids.map((id) => {
    const d = byDriver.get(id);
    if (!d || d.cartrack.is_active === false) throw new Error(`Tài xế ${id} không hoạt động`);
    return `${d.cartrack.first_name ?? ""} ${d.cartrack.last_name ?? ""}`.trim();
  });
  const rosterNames = input.driver_ids.map((id, index) => byDriver.get(id)?.roster?.Driver || names[index]);
  const old = row === undefined ? undefined : rules.find((r) => r.source_row === row);
  if (row !== undefined && (!old || old.updated_at !== version)) throw new Error("Dòng đã thay đổi — tải lại trước khi lưu");
  const useSmart = input.driver_ids.length > 1 || (!!old?.smart_driver_id && input.driver_ids.length > 0);
  const selectedSmart = useSmart ? input.driver_ids.join(",") : null;
  const manualSmart = old?.smart_driver_id === selectedSmart
    ? old.smart_driver_id_manual : selectedSmart;
  const data: Record<string, string> = {
    ...(old?.row_data ?? {}),
    customer_id: input.customer_id,
    "Điểm Pick-up": String(pickup.cartrack.customer_name ?? ""),
    driver_id: useSmart ? "" : (input.driver_ids[0] ?? ""),
    smart_driver_id: selectedSmart ?? "",
    Driver: rosterNames.join(", "),
    first_name_last_name: names.join(", "),
    dropoff_id: input.dropoff_id,
    "Điểm Drop-off": String(dropoff?.cartrack.customer_name ?? ""),
    shift_start: input.shift_start,
    shift_end: input.shift_end,
  };
  if (input.bot_token !== undefined) data.bot_token = input.bot_token;
  if (input.chat_id !== undefined) data.chat_id = input.chat_id;
  if (input.alt_drop_off_id !== undefined) data.alt_drop_off_id = input.alt_drop_off_id;
  if (old) {
    const filter = `id=eq.${old.id}&updated_at=eq.${encodeURIComponent(old.updated_at)}`;
    const changed = await sbPatch<MasterRule>("master_config_rules", filter, {
      row_data: data, smart_driver_id_manual: manualSmart, updated_at: new Date().toISOString(),
    });
    if (changed.length !== 1) throw new Error("Dòng đã thay đổi — tải lại trước khi lưu");
    return old.source_row;
  }
  const nextRow = Math.max(1, ...rules.map((r) => r.source_row)) + 1;
  await sbInsert("master_config_rules", [{ day_type: "weekday", source_row: nextRow, row_data: data, smart_driver_id_manual: manualSmart }]);
  return nextRow;
}

export async function deleteMasterRule(row: number, version: string): Promise<void> {
  const rules = await masterRules("weekday");
  const target = rules.find((r) => r.source_row === row);
  if (!target || target.updated_at !== version) throw new Error("Dòng đã thay đổi — tải lại trước khi xoá");
  await sbDelete("master_config_rules", `id=eq.${target.id}&updated_at=eq.${encodeURIComponent(version)}`);
}

export async function masterClient(id: string): Promise<MasterClient | null> {
  return (await sbSelect<MasterClient>("master_clients", `select=*&customer_id=eq.${id}`))[0] ?? null;
}

export async function masterDriver(id: string): Promise<MasterDriver | null> {
  return (await sbSelect<MasterDriver>("master_drivers", `select=*&driver_id=eq.${id}`))[0] ?? null;
}

export async function createMasterConfigRows(cells: ConfigCells[]): Promise<number[]> {
  if (!cells.length) return [];
  const [clients, drivers, rules] = await Promise.all([masterClients(), masterDrivers(), masterRules("weekday")]);
  const idsByName = new Map<string, string[]>();
  for (const c of clients) {
    const name = String(c.cartrack.customer_name ?? "").trim();
    idsByName.set(name, [...(idsByName.get(name) ?? []), c.customer_id]);
  }
  const driverByName = new Map(drivers.map((d) => [`${d.cartrack.first_name ?? ""} ${d.cartrack.last_name ?? ""}`.trim(), d.driver_id]));
  let nextRow = Math.max(1, ...rules.map((r) => r.source_row));
  const inserts = cells.map((c) => {
    const pickupIds = idsByName.get(c.pickup.trim()) ?? [];
    if (pickupIds.length !== 1) throw new Error(`Điểm lấy mẫu "${c.pickup}" không xác định duy nhất trong Master Client Info`);
    const dropoffIds = c.dropoff ? idsByName.get(c.dropoff.trim()) ?? [] : [];
    if (c.dropoff && dropoffIds.length !== 1) throw new Error(`Điểm giao "${c.dropoff}" không xác định duy nhất`);
    const driverNames = c.driver?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
    const driverIds = driverNames.map((name) => {
      const id = driverByName.get(name);
      if (!id) throw new Error(`Tài xế "${name}" không có trong Master Client Info`);
      return id;
    });
    const copied = rules.find((r) => r.source_row === c.copyFromRow)?.row_data ?? {};
    return {
      day_type: "weekday", source_row: ++nextRow,
      smart_driver_id_manual: driverIds.length > 1 ? driverIds.join(",") : null,
      row_data: {
        ...copied,
        customer_id: pickupIds[0], "Điểm Pick-up": c.pickup,
        dropoff_id: dropoffIds[0] ?? "", "Điểm Drop-off": c.dropoff,
        driver_id: driverIds.length === 1 ? driverIds[0] : "",
        smart_driver_id: driverIds.length > 1 ? driverIds.join(",") : "",
        Driver: c.driver ?? "", shift_start: c.start, shift_end: c.end,
      },
    };
  });
  await sbInsert("master_config_rules", inserts);
  return inserts.map((r) => r.source_row);
}
