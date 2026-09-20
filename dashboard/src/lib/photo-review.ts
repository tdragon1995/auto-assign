/**
 * What /picture reviews, and what it can say about it.
 *
 * The deck is PHOTO todos only (todo_type_id 2). The e-Sign todo also carries an
 * image — the signature — and putting it in the deck would pad every job with a
 * picture nobody is auditing, and count toward the "seen everything" gate.
 *
 * The typed NOTE (todo_type_id 5, "2tui") is pulled out beside them because one of
 * the three fail reasons is "quantity does not match the note": without the note on
 * screen the reviewer is being asked to compare against something they cannot see.
 *
 * Pure functions, no React — so the rule that decides what a verdict is ABOUT can be
 * pinned by scripts/photo-review.test.mts instead of only existing inside a component.
 */

/** Fail reasons. The CODE is what is stored and counted; the label is display only, so
 *  rewording one never rewrites history. Adding a code here also needs the CHECK
 *  constraint in supabase/migrations/20260920090000_photo_reviews.sql widened — Postgres
 *  refusing an unknown code is the intended second line of defence. */
export const FAIL_REASONS = [
  { code: "blurry", label: "Ảnh mờ" },
  { code: "qty_mismatch", label: "Số lượng không khớp ghi chú" },
  { code: "qty_unclear", label: "Không thấy rõ số lượng" },
] as const;

export const FAIL_REASON_CODES: readonly string[] = FAIL_REASONS.map((r) => r.code);

export interface ReviewImage { image_id: number; image_url: string; is_deleted?: boolean }
export interface ReviewTodo {
  todo_type_id: number;
  description?: string | null;
  note?: string | null;
  images?: ReviewImage[];
}
export interface ReviewStop { customer_name?: string; todos?: ReviewTodo[] }
export interface ReviewJob { stops?: ReviewStop[] }

export interface Shot { id: number; url: string; where: string; caption: string }

/** Every reviewable photo on the job, in stop order (pickup first, then dropoff). */
export function pickPhotos(job: ReviewJob | null | undefined): Shot[] {
  const out: Shot[] = [];
  for (const s of job?.stops ?? []) {
    for (const t of s.todos ?? []) {
      if (t.todo_type_id !== 2) continue;
      for (const img of t.images ?? []) {
        if (img.is_deleted) continue;
        out.push({
          id: img.image_id,
          url: img.image_url,
          where: s.customer_name ?? "",
          caption: (t.description ?? "").trim(),
        });
      }
    }
  }
  return out;
}

/** The driver's typed notes, one per stop that has one. */
export function pickNotes(job: ReviewJob | null | undefined): { where: string; note: string }[] {
  const out: { where: string; note: string }[] = [];
  for (const s of job?.stops ?? []) {
    for (const t of s.todos ?? []) {
      const note = (t.note ?? "").trim();
      if (t.todo_type_id === 5 && note) out.push({ where: s.customer_name ?? "", note });
    }
  }
  return out;
}
