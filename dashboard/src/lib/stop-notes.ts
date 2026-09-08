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

/** One trip's notes, or null when the driver typed nothing on either stop — which is
 *  most trips early in the day, since the note is written at completion. */
export function notesOf(job: Job): StopNotes | null {
  const out: StopNotes = {};
  for (const s of job.stops ?? []) {
    const note = (s.todos ?? [])
      .find((t) => t.todo_type_id === TODO_NOTE && (t.note ?? "").trim())
      ?.note?.trim();
    if (!note) continue;
    if (s.stop_type_id === 1) out.p = note;
    else out.d = note;
  }
  return out.p || out.d ? out : null;
}
