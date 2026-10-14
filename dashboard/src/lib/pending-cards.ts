/**
 * The branch's own bookings, kept on this device for the day. /qr asks the day copy for
 * them by id on every refresh; until it carries one, the booking shows as a waiting card.
 * The id rule below is shared by hiding those cards and by a cancel.
 *
 * Ids are compared as NUMBERS. The feed's job ids arrive as numbers; a booking response's
 * id is whatever Cartrack put in the JSON, and the RPC and REST create paths do not agree
 * about that — nor does an entry written to localStorage by an older build. A string that
 * never matches leaves the placeholder standing beside the real trip, and one booking
 * renders as two cards: the branch reads that as a double booking and either rings the
 * office or cancels the real one.
 */
export interface PendingReq {
  job_id: number;
  reference: string;
  /** "HH:mm" */
  created_ts: string;
  /** YYYY-MM-DD it was created on */
  date: string;
  /** Comes back on the booking response — the trip is created with its driver already
   *  attached. The published day will not carry this trip for minutes, so the response is
   *  the only place the name can arrive from in time to be worth showing. */
  driver_name?: string;
}

/** Everything in `list` that is not one of `done` (ids now loaded, or cancelled). */
export function retirePending(
  list: readonly PendingReq[],
  done: readonly (number | string | null | undefined)[],
): PendingReq[] {
  const known = new Set(done.map(Number).filter(Number.isInteger));
  return list.filter((p) => !known.has(Number(p.job_id)));
}
