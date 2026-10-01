/** Cartrack names carry status so manual profile refreshes preserve it. */
export const isInactiveLocation = (name: unknown) => /\{(?:inactive|inacttiv)\}/i.test(String(name ?? ""));
export function locationName(name: string, active: boolean): string {
  const clean = name.replace(/\{(?:inactive|inacttiv)\}/gi, "").trim();
  return active ? clean : `${clean} {inacttiv}`;
}
export function activeLocationRules(rows: readonly Record<string,string>[], inactiveIds: readonly string[]): Record<string,string>[] {
  const inactive = new Set(inactiveIds);
  return rows.map(row => [row.customer_id,row.dropoff_id,row.alt_drop_off_id].some(id => inactive.has(id))
    || isInactiveLocation(row["Điểm Pick-up"]) || isInactiveLocation(row["Điểm Drop-off"]) ? {} : row);
}
export const hasInactiveStop = (stops: readonly {customer_id?:string|null}[], inactive: ReadonlySet<string>) =>
  stops.some(stop => !!stop.customer_id && inactive.has(stop.customer_id));
