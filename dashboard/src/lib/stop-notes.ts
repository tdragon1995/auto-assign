import type { Job } from "./types";

/**
 * The driver's TYPED note on a trip — todo_type_id 5, which Cartrack labels
 * "Note @ pickup" / "Note @ dropoff" and which is where "Bảo 2 ống đỏ" is recorded.
 * Every other todo type holds an image or a signature; this is the only one whose
 * value is words.
 *
 * `p` was typed where the samples were collected, `d` where they were handed over.
 * They are two facts, not one sentence: the card renders them as two labelled rows,
 * because joining them with a "·" made a 132-character run-on that wrapped to three
 * lines on a third of rows, with the separator landing mid-wrap where it separated
 * nothing.
 */
export interface StopNotes { p?: string; d?: string }

/** Notes keyed by job_id, the shape /api/location-notes returns. */
export type NoteMap = Record<number, StopNotes>;

const TODO_NOTE = 5;

/** Lowercased, accent-stripped, whitespace-collapsed — for MATCHING only, never for
 *  display. Mirrors the fold `norm()` uses for the feed's search box. */
function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d")
    .replace(/\s+/g, " ").trim();
}

/**
 * A note as typed, made readable on one row.
 *
 * Drivers type into a phone keyboard and some of them use the return key as a
 * separator: "1 đỏ\n1 lọ\nDung". Rendered in flowing text those newlines collapse to
 * spaces and the PERSON ends up last — everywhere else on this feed the first word is
 * who, so the reader's learned scan reads "1" as the name. When the last segment looks
 * like a name (no digits, at most three words) it is hoisted back to the front.
 * Anything that does not fit that shape is joined in the order it was typed.
 */
export function cleanNote(raw: string): string {
  const parts = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  const last = parts[parts.length - 1];
  const nameLike = !/\d/.test(last) && last.split(/\s+/).length <= 3;
  return (nameLike ? [last, ...parts.slice(0, -1)] : parts).join(", ");
}

/** One trip's notes, or null when the driver typed nothing on either stop — which is
 *  most trips early in the day, since the note is written at completion. */
export function notesOf(job: Job): StopNotes | null {
  const out: StopNotes = {};
  for (const s of job.stops ?? []) {
    const note = (s.todos ?? [])
      .find((t) => t.todo_type_id === TODO_NOTE && (t.note ?? "").trim())
      ?.note?.trim();
    if (!note) continue;
    if (s.stop_type_id === 1) out.p = cleanNote(note);
    else out.d = cleanNote(note);
  }
  return out.p || out.d ? out : null;
}

/**
 * True when the driver recorded that there was NOTHING to collect — "K mẫu",
 * "không có mẫu", sometimes with a time appended ("Không có mẫu 11h29").
 *
 * Worth its own branch because a no-sample trip rendered as an ordinary note is the
 * most misleading row on the page: the reader's heuristic is "there is a note, so
 * samples arrived". It is a different OUTCOME, not an error, so the card shows it as a
 * grey chip rather than anything alarming.
 */
export function isNoSample(n: StopNotes): boolean {
  return [n.p, n.d].some((s) => s && /^(k|ko|kh|khong|0)\s*(co\s*)?mau\b/.test(fold(s)));
}
