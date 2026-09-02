// time.ts is pure date arithmetic (no Redis, no fetch), so importing it keeps
// this module edge-safe — the property the note gate and the PSC guards rely on.
import { vnMinutesSinceMidnight } from "./time";

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

/**
 * A stop note reduced to its comparable form: approved mark removed, trimmed,
 * runs of whitespace collapsed, lowercased, trailing sentence punctuation
 * dropped. So "GIAO GIỜ HÀNH CHÍNH." and "giao  giờ hành chính" are one note.
 *
 * Diacritics are deliberately KEPT. Folding them merges Vietnamese words that
 * genuinely differ, and this list decides whether a human gets to read a note
 * before a driver is sent — too blunt a comparison is the one mistake that
 * cannot be walked back. A branch that types a sentence both with and without
 * accents gets both spellings on the list.
 */
export function normalizeNote(note?: string | null): string {
  return (note ?? "")
    .split(NOTE_APPROVED_MARK).join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[.,;:!…]+$/u, "")
    .trim();
}

/**
 * Notes that never hold a job, at ANY hour. Exactly the one exemption the gate
 * has always had — Cartrack's own boilerplate, which carries no instruction.
 * Evening jobs relied on this too, so it must stay outside the clock guard.
 */
const ALWAYS_NON_BLOCKING: ReadonlySet<string> = new Set([
  "call before delivery",
]);

/**
 * Notes proven harmless by history — sentences a supervisor has repeatedly
 * approved as-is and never once turned into a scheduled job. Normalized form,
 * matched WHOLE: a listed sentence buried inside a longer note does not count.
 *
 * Each entry carries the counts it was admitted on, so a later reader can weigh
 * it without re-running anything. Those counts are evidence, not the decision:
 * the automatic test proposed a set, and a supervisor then kept, dropped and
 * added by hand — three entries here were rescheduled once each, and two were
 * admitted on local knowledge rather than on their numbers.
 *
 * Re-derive with `scripts/note-scan.mts`; price a change with
 * `scripts/note-simulate.mts` before making it, because coverage is not the sum
 * of these counts — a job is released only when EVERY note on it is listed.
 */
export const DAYTIME_NON_BLOCKING: ReadonlySet<string> = new Set([
  // Seeded 2026-08-29 from scripts/note-scan.mts over the 45 days to 2026-08-28,
  // then reviewed by the supervisor. Almost all of these are a branch saying
  // "there is a sample here" — the reason the job exists, not a change to it —
  // or an on-site direction (which gate, which block) the driver needs on
  // arrival and nobody needs to approve first.
  "khẩn",                                       // seen 231× at 27 branches, approved 55×, rescheduled 1×
  "pk có mẫu ạ",                                // seen 70× at 15 branches, approved 23×, rescheduled 1×
  "bv có mẫu ạ",                                // seen 48× at 4 branches, approved 15×, rescheduled 1×
  "mẫu không gấp",                              // seen 39× at 4 branches, approved 9×, rescheduled 0×
  "lấy sớm giúp em",                            // seen 36× at 6 branches, approved 8×, rescheduled 0×
  "giao nhận mẫu",                              // seen 31× at 7 branches, approved 8×, rescheduled 0×
  "khu b vi sinh",                              // seen 29× at 1 branch, approved 7×, rescheduled 0×
  "cổng 3",                                     // seen 27× at 1 branch, approved 5×, rescheduled 0×
  "khu b",                                      // seen 23× at 2 branches, approved 5×, rescheduled 0×
  "thu mẫu san",                                // seen 22× at 1 branch, approved 11×, rescheduled 0×
  "quang",                                      // seen 22× at 2 branches, approved 2×, rescheduled 0×
  "bv có mẫu",                                  // seen 20× at 3 branches, approved 1×, rescheduled 0×
  "thu mẫu máu",                                // seen 20× at 1 branch, approved 6×, rescheduled 0×
  "ghé pk song quân lấy mẫu",                   // seen 20× at 1 branch, approved 6×, rescheduled 0×
  "pk có mẫu",                                  // seen 18× at 7 branches, approved 4×, rescheduled 0×
  "lấy mẫu",                                    // seen 17× at 6 branches, approved 5×, rescheduled 0×
  "có mẫu , điag ơi",                           // seen 13× at 1 branch, approved 4×, rescheduled 0×
  "mẫu đông máu",                               // seen 12× at 1 branch, approved 5×, rescheduled 0×
  "ntvt có mẫu đông máu khẩn ạ",                // seen 12× at 1 branch, approved 3×, rescheduled 0×
  "lấy mẫu giun",                               // seen 11× at 1 branch, approved 6×, rescheduled 0×
  "khoa vi sinh",                               // seen 10× at 2 branches, approved 2×, rescheduled 0×
  "mẫu",                                        // seen 9× at 3 branches, approved 3×, rescheduled 0×
  "mau khan",                                   // seen 9× at 4 branches, approved 4×, rescheduled 0×
  "pk có mẫu nhé",                              // seen 8× at 1 branch, approved 6×, rescheduled 0×
  "d1 gửi mẫu lần 3",                           // seen 7× at 1 branch, approved 6×, rescheduled 0×
  "qua lấy mẫu , điag ơi",                      // seen 5× at 1 branch, approved 3×, rescheduled 0×
  "bv có mẫu khẩn",                             // seen 4× at 2 branches, approved 4×, rescheduled 0×
  "ntvt có mẫu ạ",                              // seen 3× at 1 branch, approved 2×, rescheduled 0×
  "về nhà chị huệ",                             // seen 3× at 3 branches, approved 3×, rescheduled 0×
  // DELIBERATELY NOT HERE, though the automatic test proposed them: "19h" and
  // "lấy mẫu trước 5 giờ giúp e ạ". Both name a TIME. They passed only because
  // nobody happened to reschedule them, and a note that sets an hour is exactly
  // what the gate exists to put in front of a human.
]);

/**
 * Past this hour a harmless note stops being harmless: the working day is over,
 * shifts have ended, and a job released now would be offered to a driver who has
 * gone home. Jobs booked after it wait for a human exactly as they always have.
 *
 * 19:30 is the hour the supervisor already works to by hand — no rule in the
 * system enforced it before this one; the engine itself runs until 22:00.
 */
export const NOTE_RELEASE_CUTOFF_MIN = 19 * 60 + 30;

/** True while the daytime list is allowed to release jobs. */
export function isNoteReleaseHour(now: Date = new Date()): boolean {
  return vnMinutesSinceMidnight(now) < NOTE_RELEASE_CUTOFF_MIN;
}

/**
 * Does this note hold the job back?
 *
 * Blank never blocks. The always-list never blocks. The measured daytime list
 * blocks unless `now` is supplied AND falls inside the working day — callers
 * that only want to DISPLAY or stamp a note (the "Cần xử lý" panel) omit `now`
 * and so see the gate exactly as it was before the list existed.
 */
export function isBlockingNote(
  note?: string | null,
  opts?: { now?: Date; daytimeList?: ReadonlySet<string> },
): boolean {
  const n = normalizeNote(note);
  if (!n) return false;
  if (ALWAYS_NON_BLOCKING.has(n)) return false;
  const list = opts?.daytimeList ?? DAYTIME_NON_BLOCKING;
  if (opts?.now && isNoteReleaseHour(opts.now) && list.has(n)) return false;
  return true;
}

/**
 * Every note on the job that still holds it — as the branch typed it (trimmed),
 * not normalized, so all existing log and panel text is unchanged.
 *
 * One unlisted sentence anywhere on the job holds the WHOLE job: the caller sees
 * a non-empty list and stops, exactly as it did when any note at all stopped it.
 */
export function blockingNotes(
  job: { stops?: { note?: string | null }[] | null },
  opts?: { now?: Date; daytimeList?: ReadonlySet<string> },
): string[] {
  const out: string[] = [];
  for (const stop of job.stops ?? []) {
    if (isBlockingNote(stop.note, opts)) out.push((stop.note ?? "").trim());
  }
  return out;
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

/** Label marking a via-leg — a deliberate second pickup at the same place on the same
 *  run, so it must never count as a duplicate of the trip it accompanies. Declared here
 *  rather than in via-legs.ts because the duplicate guard and the day snapshot both
 *  need it on the edge runtime, and via-legs pulls in the assign graph. Changing the
 *  string means changing it in Cartrack too — it is a real label. */
export const PSC_VIA_LABEL = "🛵 Vận chuyển mẫu PSC (ghé)";

/** The outbound and return halves of a PSC run. Here, rather than in return-trips.ts
 *  which owns the trip logic, for the same reason as PSC_VIA_LABEL above and one more:
 *  the three are one concept (see ENGINE_LEG_LABELS) and reading it whole beats reading
 *  it in two files. That is a preference, not a constraint — the set would work in
 *  return-trips.ts too, at the cost of the edge runtime losing reach on it. */
export const PSC_RETURN_LABEL = "🛵 Vận chuyển mẫu PSC (về)";
export const PSC_OUTBOUND_LABEL = "🛵 Vận chuyển mẫu PSC";

/** Every label the engine puts on a leg it created for itself. THE list — the rollover
 *  rule, the late-pickup classifier and the morning cleanup sweep all read it, where
 *  each used to spell the three out for itself. Missing one of those sites is silent
 *  and expensive: an engine leg that rolls loses its driver, becomes unremovable, and
 *  re-rolls every morning.
 *
 *  A fourth leg label is one edit here, but NOT only here — and the neighbouring policy
 *  is NOT this set, in either direction. Duplicate handling splits the question in two:
 *  DUPLICATE_EXEMPT_LABELS in assign.ts decides who is never REJECTED (return, and PSC
 *  tỉnh — but a return still sits in the active-route map, so it can still block), while
 *  the skip in buildActiveRouteMap decides who never BLOCKS (via — which is therefore
 *  still rejectable itself). Outbound is in neither. A new label needs its own decision
 *  in both places. */
export const ENGINE_LEG_LABELS: readonly string[] = [
  PSC_OUTBOUND_LABEL,
  PSC_VIA_LABEL,
  PSC_RETURN_LABEL,
];

/** True for a leg the engine created for itself — outbound, via or return — as opposed
 *  to a client's request. `isInternalOrPlanJob` in assign.ts is a WIDER net (plans, any
 *  Diag pickup) answering a different question: it is built ON this one but is not a
 *  substitute for it — swapping it into the rollover rule would refuse to roll a
 *  genuine bag run nobody rode. Reads REST-shaped labels (plain strings); see
 *  isChamCong for the JSON-RPC `{ labelId, label }` shape, which this does not handle. */
export function isEngineLeg(job: { labels?: string[] | null }): boolean {
  const labels = job.labels ?? [];
  return ENGINE_LEG_LABELS.some((l) => labels.includes(l));
}

/** True if this stop can still block re-booking (Created, En Route, Arrived). */
export function isActiveStop(stopStatusId: number): boolean {
  return stopStatusId === 1 || stopStatusId === 2 || stopStatusId === 3;
}

/**
 * True if a pickup stop can still block re-booking its pickup→dropoff pair.
 *
 * `stop_status_id` alone is not enough. Cartrack lags the status behind the activity
 * timestamps — the same lag `isStopStarted` guards against, in the other direction: a
 * stop the driver has already completed can still read 1–3. The dedup guards read that
 * as "the batch is still sitting at the branch" and refused the branch's next request
 * with "vẫn chưa rời chi nhánh", about samples that had already been collected.
 *
 * A completion timestamp is the sample having left, whatever the status says.
 */
export function isBlockingPickupStop(stop: {
  stop_status_id?: number | null;
  activity_completed_ts?: string | null;
}): boolean {
  if (stop.activity_completed_ts) return false;
  return stop.stop_status_id != null && isActiveStop(stop.stop_status_id);
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
