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

/** Reference-number prefix and labels of a chấm công (attendance) task — the
 *  single-stop check-in / check-out job /api/cham-cong creates, pre-assigned to
 *  the driver who tapped it. Defined here so every consumer matches the same
 *  strings; changing them means changing the POST payload in /api/cham-cong too. */
export const CHAM_CONG_PREFIX = "Chấm Công -";
export const CHAM_CONG_LABELS = ["check_in", "check_out"];

/**
 * True if this job (or timeline stop) is a chấm công task rather than real
 * delivery work. Either signal is enough: labels arrive as plain strings from
 * REST but as `{ labelId, label }` objects from JSON-RPC (both normalised here),
 * and the reference-number prefix covers payloads that carry no labels at all.
 */
export function isChamCong(job: {
  reference_number?: string | null;
  referenceNumber?: string | null;
  labels?: unknown;
  jobLabels?: unknown;
}): boolean {
  const ref = job.reference_number ?? job.referenceNumber;
  if (typeof ref === "string" && ref.startsWith(CHAM_CONG_PREFIX)) return true;
  const raw = Array.isArray(job.labels)
    ? job.labels
    : Array.isArray(job.jobLabels)
      ? job.jobLabels
      : [];
  return raw.some((l) => {
    const name = typeof l === "string" ? l : (l as { label?: unknown } | null)?.label;
    return typeof name === "string" && CHAM_CONG_LABELS.includes(name);
  });
}

/** True if this stop can still block re-booking (Created, En Route, Arrived). */
export function isActiveStop(stopStatusId: number): boolean {
  return stopStatusId === 1 || stopStatusId === 2 || stopStatusId === 3;
}

/** Canonical key for the PSC active-pickup dedup index: a `pickup|dropoff` customer
 *  pair. Shared by the assign cycle (which writes the index) and /api/psc-assign
 *  (which reads it), so the two never disagree on format. Dependency-free on purpose
 *  — both the Node assign cycle and any edge route can import it. */
export function pscPairKey(pickupCustomerId: string, dropoffCustomerId: string): string {
  return `${pickupCustomerId}|${dropoffCustomerId}`;
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
