/** Vietnamese labels for Cartrack stop statuses (stop_status_id). */
export const STOP_STATUS: Record<number, { label: string; color: string }> = {
  1: { label: "Chờ lấy",    color: "slate"  },
  2: { label: "Đang đến",   color: "blue"   },
  3: { label: "Đã đến",     color: "indigo" },
  4: { label: "Hoàn thành", color: "green"  },
  5: { label: "Từ chối",    color: "red"    },
};

/** Vietnamese labels for Cartrack job statuses (job_status_id). */
export const JOB_STATUS: Record<number, string> = {
  2: "Chờ phân công",
  3: "Thất bại",
  4: "Đã phân công",
  5: "Hoàn thành",
  7: "Đã huỷ",
};

/** The mark "Giao ngay" stamps on a stop note to clear a held job past the note
 *  gate. Plain UTF-8 — verified to round-trip through Cartrack's note field. Lives
 *  here (dependency-free) so edge routes can import it without the assign.ts graph. */
export const NOTE_APPROVED_MARK = "✅";

/** True if any stop note carries the supervisor-approved mark. */
export function isNoteApproved(job: { stops?: { note?: string | null }[] | null }): boolean {
  return (job.stops ?? []).some((s) => s.note?.includes(NOTE_APPROVED_MARK));
}

/** True if this stop can still block re-booking (Created, En Route, Arrived). */
export function isActiveStop(stopStatusId: number): boolean {
  return stopStatusId === 1 || stopStatusId === 2 || stopStatusId === 3;
}

/** True if this stop is terminal — no more work expected (Completed or Rejected). */
export function isCompletedOrRejectedStop(stopStatusId: number): boolean {
  return stopStatusId === 4 || stopStatusId === 5;
}

/**
 * True if the driver has touched this stop in any way.
 * Used to guard job-cancellation: status may still read 1 (Created) while Cartrack
 * has recorded an activity timestamp, so both checks are required.
 */
export function isStopStarted(stop: {
  stop_status_id?: number | null;
  activity_started_ts?: string | null;
  activity_arrived_ts?: string | null;
  activity_completed_ts?: string | null;
}): boolean {
  return (
    (stop.stop_status_id != null && stop.stop_status_id !== 1) ||
    !!stop.activity_started_ts ||
    !!stop.activity_arrived_ts ||
    !!stop.activity_completed_ts
  );
}
