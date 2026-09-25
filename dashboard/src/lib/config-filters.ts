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
  starts: readonly string[];
  startOperator: ConfigTextOperator;
  startText: string;
  ends: readonly string[];
  endOperator: ConfigTextOperator;
  endText: string;
}

export type ConfigTextOperator = "contains" | "not_contains" | "is" | "is_not";

export interface ConfigFilterOptions {
  drivers: string[];
  pickups: string[];
  dropoffs: string[];
  starts: string[];
  ends: string[];
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
  starts: [],
  startOperator: "contains",
  startText: "",
  ends: [],
  endOperator: "contains",
  endText: "",
};

/** Keep punctuation literal while making names and uneven typing comparable. */
export function normalizeConfigText(value: string): string {
  return foldName(value).trim().replace(/\s+/g, " ");
}

export function usesTextInput(operator: ConfigTextOperator): boolean {
  return operator === "contains" || operator === "not_contains";
}

function matchesText(values: readonly string[], operator: ConfigTextOperator, query: string): boolean {
  if (!query) return true;
  const found = values.some((value) => normalizeConfigText(value).includes(query));
  return operator === "not_contains" ? !found : found;
}

function matchesSelection(values: readonly string[], selected: ReadonlySet<string>, operator: ConfigTextOperator): boolean {
  if (selected.size === 0) return true;
  const found = values.some((value) => selected.has(value));
  return operator === "is_not" ? !found : found;
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
  const startText = normalizeConfigText(filters.startText);
  const endText = normalizeConfigText(filters.endText);
  const selectedDrivers = new Set(filters.drivers);
  const selectedPickups = new Set(filters.pickups);
  const selectedDropoffs = new Set(filters.dropoffs);
  const selectedStarts = new Set(filters.starts);
  const selectedEnds = new Set(filters.ends);

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

    if (usesTextInput(filters.driverOperator)) {
      if (driverText) {
        // The table shows personal names, while the sheet stores routing prefixes.
        const driverLabels = rowDrivers.flatMap((name) => [name, splitDriverName(name).name]);
        if (!matchesText(driverLabels, filters.driverOperator, driverText)) return false;
      }
    } else if (!matchesSelection(rowDrivers, selectedDrivers, filters.driverOperator)) {
      return false;
    }
    if (usesTextInput(filters.pickupOperator)
      ? !matchesText([row.pickup], filters.pickupOperator, pickupText)
      : !matchesSelection([row.pickup], selectedPickups, filters.pickupOperator)) return false;
    if (usesTextInput(filters.dropoffOperator)
      ? !matchesText([row.dropoff], filters.dropoffOperator, dropoffText)
      : !matchesSelection([row.dropoff], selectedDropoffs, filters.dropoffOperator)) return false;
    if (usesTextInput(filters.startOperator)
      ? !matchesText([row.start], filters.startOperator, startText)
      : !matchesSelection([row.start], selectedStarts, filters.startOperator)) return false;
    if (usesTextInput(filters.endOperator)
      ? !matchesText([row.end], filters.endOperator, endText)
      : !matchesSelection([row.end], selectedEnds, filters.endOperator)) return false;
    return true;
  });
}

/** Stable options are derived from the complete loaded table, never the matches. */
export function configFilterOptions(rows: readonly ConfigRowView[]): ConfigFilterOptions {
  const vi = new Intl.Collator("vi", { sensitivity: "base", numeric: true });
  const timeOrder = new Intl.Collator("en", { numeric: true });
  const drivers = new Set<string>();
  const pickups = new Set<string>();
  const dropoffs = new Set<string>();
  const starts = new Set<string>();
  const ends = new Set<string>();

  for (const row of rows) {
    for (const driver of splitDriverNames(row.driver)) drivers.add(driver);
    if (row.pickup) pickups.add(row.pickup);
    dropoffs.add(row.dropoff);
    starts.add(row.start);
    ends.add(row.end);
  }

  return {
    drivers: [...drivers].sort(compareDriverNames),
    pickups: [...pickups].sort((a, b) => {
      const aInactive = /^\{inactive\}\s*/i.test(a);
      const bInactive = /^\{inactive\}\s*/i.test(b);
      return Number(aInactive) - Number(bInactive) || vi.compare(a, b);
    }),
    dropoffs: [...dropoffs].sort((a, b) => {
      if (!a) return -1;
      if (!b) return 1;
      return vi.compare(a, b);
    }),
    starts: [...starts].sort(timeOrder.compare),
    ends: [...ends].sort(timeOrder.compare),
  };
}
