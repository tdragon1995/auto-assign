---
target: the driver note line on /qr trip cards
total_score: 18
p0_count: 0
p1_count: 3
timestamp: 2026-09-08T08-35-44Z
slug: dashboard-src-app-qr-code-qr-client-tsx
---
Method: dual-agent (A: a67b598f602c65976 · B: a6c93f53bec75d38a)

Target: the driver's-note line on the branch feed cards — `NoteLine` in `dashboard/src/app/qr/[code]/qr-client.tsx` (:136, rendered at :504 and :1135), `noteLine()` in `dashboard/src/lib/stop-notes.ts`, seen live on /qr/D001.

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | The 4-step stepper is genuinely good. The note's own fetch fails silently (`.catch(() => {})`), so "driver typed nothing" and "the request broke" look identical — 8 of 38 cards showed nothing today. |
| 2 | Match System / Real World | 2 | `Giao: Hân 2 mẫu` reads as "Hân delivered". Hân is the D001 receptionist who RECEIVED. The label is inverted at the dropoff end. |
| 3 | User Control and Freedom | 2 | "Xong hôm nay" search covers location, driver and batch code — not the note. "Which trips did Hân sign for" is unanswerable. |
| 4 | Consistency and Standards | 2 | The detail sheet already renders this correctly: each note under its own event, at its own timestamp. The card is a lossy re-labelled copy one tap away. Two vocabularies for one fact. |
| 5 | Error Prevention | 1 | `Lấy: Như 4 lam, 4 chiết, 1 lọ · Giao: Hân 2 mẫu` — nine collected, two received — renders in exactly the same grey as thirteen perfect matches. |
| 6 | Recognition Rather Than Recall | 2 | The reader holds the first half in memory, scans past a mid-line `·` (often across a wrap), and normalises "lam/chiết/lọ" against "mẫu" by hand. |
| 7 | Flexibility and Efficiency | 2 | No density control, and `max-w-[430px]` gives a desk reader the phone column with 1000px of empty slate beside it. |
| 8 | Aesthetic and Minimalist Design | 2 | Visually restrained, informationally bloated: on 43% of rows the second half is a verbatim repeat of the first. |
| 9 | Error Recovery | 1 | No error state exists for the notes fetch at all. |
| 10 | Help and Documentation | 1 | `K mẫu`, `chiết`, `lam`, `nắp hồng` are defined nowhere in the product; the tube vocabulary is oral tradition. |
| **Total** | | **18/40** | Below the 20–32 band most real interfaces land in |

## Anti-Patterns Verdict

**LLM assessment**: not slop — the opposite failure. No decorative motion, no display font, no invented affordance, no modal, consistent icon vocabulary with `TodoNotes`. It is under-designed: restraint spent on the one element that needed weight.

**Deterministic scan**: `detect.mjs` over `qr-client.tsx` + `trip-sheet.tsx` — 0 findings, exit 0. In-page detector (injected, live): 1 anti-pattern — `overused-font` (Inter at 100%), plus informational `single-font` and `layout-transition: height`. All three are false positives here: one well-tuned sans is the product register's own guidance, and the height transition is the "Xong hôm nay" collapse.

**Measured** (browser, 375px): note text `rgb(69,85,108)` 12px/400 on white = 7.58:1, passes AAA. Sticky-note icon `slate-400` = 2.63:1, below the 3:1 non-text floor — decorative and `aria-hidden`, so not a violation, but it is the only visual marker saying "this is a note" and it is sub-threshold in afternoon sun. Note lengths 24 / 43 / 132 chars (min/median/max). 20 of 60 note spans wrap to 2+ visual lines at 375px. Nothing clips or overflows. Gap from the stepper's label row to the note: 10px.

(A counted 30 rendered notes, B counted 60 spans — `NoteLine` nests an inner span, so B double-counted. Not a data disagreement.)

## Overall Impression

The line is the most valuable thing on the card and is styled as the least. Its job is reconciliation — did what arrived match what was collected — and it performs no reconciliation: it prints two strings, joins them with a middle dot, and leaves the arithmetic to a receptionist holding a tube rack. Meanwhile 43% of those pairs are the same quantity twice, so the noise trains the reader to skip the line, which is exactly where the one real discrepancy of the day was hiding.

The single biggest opportunity: stop flattening two facts into one sentence. The run-on is already false economy — a third of rows wrap anyway, and the `·` lands mid-wrap where it separates nothing.

## What's Working

1. **The extraction is honest.** `notesOf()` reads only `todo_type_id 5`, splits strictly on `stop_type_id`, and returns `null` rather than an empty string — no guessing, no merging. That discipline is why this is worth refining rather than rebuilding.
2. **Loading it second was right.** Only D001 pays the extra request, and it fires after `setJobs()` so a ~6s Cartrack listing never blocks the feed.
3. **The detail sheet already has the correct model** — each note under its own event, anchored to its own timestamp, photos beside it. The card should borrow that structure, not invent a second one.

## Priority Issues

**[P1] The labels are the stepper's words, and one of them is backwards.**
The stepper prints `Lấy mẫu` and `Đang giao`; ten pixels below, the note prints `Lấy:` and `Giao:` — same words, different referents, and `Giao:` names the person who received. A new receptionist will learn it wrong.
Fix: `Người giao` / `Người nhận`. Person-words, no collision, correct direction. When only one half exists, the label is what says which end it came from.
Suggested command: `/impeccable clarify`

**[P1] Two facts flattened into one run-on sentence.**
`Lấy: Dung 8 ống đỏ 4 ống tím 2 ống xám 2 ống xanh 2 lọ nước tiểu · Giao: Diễm 8 ống đỏ…` = 132 chars, 3 lines, 54px on a phone, second half a verbatim repeat.
Fix: two aligned rows (label column + value), separated from the stepper by `pt-2 border-t border-slate-50`. Measured evidence says the one-line ideal is already fiction on a third of rows; an explicit two-row structure is cheaper to read than a wrapped run-on.
Suggested command: `/impeccable layout`

**[P1] A missing note and a broken fetch look the same.**
`.catch(() => {})` at :711. If `/api/location-notes` breaks, all 38 cards quietly lose their notes and the page reads as a quiet day — the same failure shape CLAUDE.md footgun 3 warns about for the config sheet.
Fix: `notesFailed` state → one amber line above the list (`Không tải được ghi chú giao nhận`), not 38. And when the fetch succeeded and the trip genuinely has none, say so once in grey rather than rendering nothing.
Suggested command: `/impeccable harden`

**[P2] `K mẫu` renders as a normal handover.**
Two trips today collected nothing and are pixel-identical to a twelve-tube delivery. The reader's heuristic is "there's a note, so samples arrived."
Fix: detect the no-sample forms on the normalised pickup half and render a slate chip — `Không có mẫu` — not a note. Grey, not amber: it is a different outcome, not an error.

**[P2] The note is invisible to a screen reader on every completed row.**
`aria-label` on the row `<button>` (:1103) replaces the whole accessible name, so the note, the driver and all four times are unreachable. The active `TripCard` has no `aria-label`, so the same content behaves differently in the two lists.
Fix: delete the `aria-label` — the inner text is a better name than the label.

**[P3] Embedded newlines put the person last.**
`"1 đỏ \n1 lọ \nDung"` collapses to `Lấy: 1 đỏ 1 lọ Dung`. Everywhere else the first word is the person, so the scan pattern reads "1" as the name.

## The one thing NOT to build

A `⚠ lệch` mismatch flag. Of 30 pairs today, 13 match byte-for-byte, 10 re-count in a different vocabulary (`1 lam, 1 xanh` → `2 mẫu`), 4 genuinely differ. An automatic warning fires on 14 of 30 rows — noise, not signal, and it would burn the one colour budget the card has. The interface can honestly say these two agree; it cannot honestly say these two disagree until the drivers are asked to type comparable units. Collapsing a proven duplicate is safe; declaring a discrepancy is not.

## Persona Red Flags

**Chị Trúc — D001 reception, phone in one hand, tube rack in the other.** Reads a 3-line grey run-on to learn that eight tube types matched. Her own name is the least useful token on thirteen rows. Cannot search her own handovers. When the note is missing she cannot tell whether to go ask the driver.

**Anh Long — supervisor scanning ~40 rows for anything wrong.** No scan target: the 9-vs-2 row is the same grey as everything else. On a desktop monitor he gets the 430px phone column. Note-bearing and note-less cards differ in height, so there is no vertical rhythm to run an eye down.

**Week-one receptionist.** `chiết`, `lam`, `K mẫu` are undefined anywhere. `Lấy:` under `Lấy mẫu` reads as a continuation of the stepper. `Giao: Hân` teaches her that Hân delivered.

## Minor Observations

- The notes request fires three times per feed load (StrictMode + unguarded `.then`). Harmless in dev, triple cost in prod.
- `mt-2.5` puts the note closer to the stepper's timestamps than the stepper's own rows are to each other — that proximity is what creates the `Lấy mẫu`/`Lấy:` binding.
- The sticky-note glyph distinguishes nothing (there is only one kind of note) and is the fifth icon on a completed row. If the labels get fixed, it can go.
- One row today closed all three timestamps at the same minute — the case where the note is the only evidence anything happened — and had no note.

## Questions to Consider

1. If 43% of these lines say the same thing twice, why does the card show both halves instead of the conclusion, with the raw pair one tap away in a sheet that already renders it properly?
2. A third of the notes are written in two incompatible unit vocabularies. Is the interface's job here to keep papering over that, or to make it visible so the conversation moves to what drivers are asked to type?
3. Should the card carry a verdict and the sheet carry the words? That would make 40 rows scannable and leave one renderer instead of two.
