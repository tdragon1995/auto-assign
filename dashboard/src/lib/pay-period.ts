/** A payroll month covers the previous month's 15th through its own 14th, inclusive. */
export function payrollPeriod(month: string): { from: string; to: string } {
  const previous = new Date(`${month}-01T00:00:00Z`);
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  return { from: `${previous.toISOString().slice(0, 7)}-15`, to: `${month}-14` };
}
