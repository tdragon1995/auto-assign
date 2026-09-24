import type { ConfigRowView } from "@/app/api/config/rows/route";
import { foldName, splitDriverNames } from "./driver-cell";
import { compareDriverNames, splitDriverName } from "./driver-label";

export interface ConfigFilters {
  query: string;
  drivers: readonly string[];
  driverOperator: ConfigTextOperator;
  driverText: string;
  pickups: readonly string[];
  pickupOperator: ConfigTextOperator;
  pickupText: string;
  dropoffs: readonly string[];
  dropoffOperator: ConfigTextOperator;
  dropoffText: string;
}

export type ConfigTextOperator = "contains" | "not_contains" | "is" | "is_not";

export interface ConfigFilterOptions {
  drivers: string[];
  pickups: string[];
  dropoffs: string[];
}

export const EMPTY_CONFIG_FILTERS: ConfigFilters = {
  query: "",
  drivers: [],
  driverOperator: "contains",
  driverText: "",
  pickups: [],
  pickupOperator: "contains",
  pickupText: "",
  dropoffs: [],
  dropoffOperator: "contains",
  dropoffText: "",
};

/** Keep punctuation literal while making names and uneven typing comparable. */
export function normalizeConfigText(value: string): string {
  return foldName(value).trim().replace(/\s+/g, " ");
}

function matchesText(values: readonly string[], operator: ConfigTextOperator, query: string): boolean {
  if (!query) return true;
  const equal = operator === "is" || operator === "is_not";
  const found = values.some((value) => {
    const normalized = normalizeConfigText(value);
    return equal ? normalized === query : normalized.includes(query);
  });
  return operator === "not_contains" || operator === "is_not" ? !found : found;
}

/**
 * Dashboard-only filtering. The general query must occur as one consecutive
 * phrase in one field (or one driver name), so words cannot be assembled from
 * unrelated columns or from two drivers in a smart row.
 */
export function filterConfigRows(
  rows: readonly ConfigRowView[],
  filters: ConfigFilters,
): ConfigRowView[] {
  const query = normalizeConfigText(filters.query);
  const driverText = normalizeConfigText(filters.driverText);
  const pickupText = normalizeConfigText(filters.pickupText);
  const dropoffText = normalizeConfigText(filters.dropoffText);
  const selectedDrivers = new Set(filters.drivers);
  const selectedPickups = new Set(filters.pickups);
  const selectedDropoffs = new Set(filters.dropoffs);

  return rows.filter((row) => {
    const rowDrivers = splitDriverNames(row.driver);
    if (query) {
      const fields = [
        row.pickup,
        row.customer_id,
        ...rowDrivers,
        row.dropoff,
        row.start,
        row.end,
        row.start && row.end ? `${row.start}–${row.end}` : "",
      ];
      if (!fields.some((field) => normalizeConfigText(field).includes(query))) return false;
    }

    if (selectedDrivers.size && !rowDrivers.some((name) => selectedDrivers.has(name))) return false;
    // The table shows personal names, while the sheet stores routing prefixes.
    // Accept either spelling for exact driver comparisons.
    if (driverText) {
      const driverLabels = rowDrivers.flatMap((name) => [name, splitDriverName(name).name]);
      if (!matchesText(driverLabels, filters.driverOperator, driverText)) return false;
    }
    if (selectedPickups.size && !selectedPickups.has(row.pickup)) return false;
    if (!matchesText([row.pickup], filters.pickupOperator, pickupText)) return false;
    if (selectedDropoffs.size && !selectedDropoffs.has(row.dropoff)) return false;
    if (!matchesText([row.dropoff], filters.dropoffOperator, dropoffText)) return false;
    return true;
  });
}

/** Stable options are derived from the complete loaded table, never the matches. */
export function configFilterOptions(rows: readonly ConfigRowView[]): ConfigFilterOptions {
  const vi = new Intl.Collator("vi", { sensitivity: "base", numeric: true });
  const drivers = new Set<string>();
  const pickups = new Set<string>();
  const dropoffs = new Set<string>();

  for (const row of rows) {
    for (const driver of splitDriverNames(row.driver)) drivers.add(driver);
    if (row.pickup) pickups.add(row.pickup);
    dropoffs.add(row.dropoff);
  }

  return {
    drivers: [...drivers].sort(compareDriverNames),
    pickups: [...pickups].sort(vi.compare),
    dropoffs: [...dropoffs].sort((a, b) => {
      if (!a) return -1;
      if (!b) return 1;
      return vi.compare(a, b);
    }),
  };
}
