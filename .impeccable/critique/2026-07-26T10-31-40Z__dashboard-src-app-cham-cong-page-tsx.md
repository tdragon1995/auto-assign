---
target: cham-cong task list redesign
total_score: 32
p0_count: 0
p1_count: 3
timestamp: 2026-07-26T10-31-40Z
slug: dashboard-src-app-cham-cong-page-tsx
---
# Critique — "Chấm công hôm nay" task list (dashboard/src/app/cham-cong/page.tsx)

Method: dual-agent (A: design review · B: detector + browser evidence). Register: product. Target: driver-facing mobile attendance list + inline per-row change-location picker.

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of system status | 3 | ~9s Cartrack fetch shows only "Đang tải…" text, no skeleton |
| 2 | Match system / real world | 4 | Plain Vietnamese, Vào ca/Ra ca, domain-correct location codes |
| 3 | User control & freedom | 3 | Location switch commits on first tap, no confirm/undo |
| 4 | Consistency & standards | 3 | Status pill vs action button shared amber styling (now differentiated) |
| 5 | Error prevention | 3 | Strong server guards; switch itself commits immediately |
| 6 | Recognition over recall | 4 | Full day's record on screen, searchable pickers |
| 7 | Flexibility & efficiency | 3 | Correcting a location is a 4-step reach |
| 8 | Aesthetic & minimalist | 3 | On-brand; was undercut by amber overload + sub-legible micro-text |
| 9 | Error recovery messaging | 4 | Specific, actionable error copy |
| 10 | Help & documentation | 2 | Empty state doesn't teach; state labels never explained |
| **Total** | | **32/40** | **Good** |

## Anti-patterns verdict
- **LLM (Assessment A):** PASS for the product register. Reads as a real record surface, not a mock — restrained neutral card, one sans, semantic palette used for meaning, no glass, no gratuitous motion. State never conveyed by color alone (every badge + direction carries a text label).
- **Deterministic scan (Assessment B):** `detect.mjs` exit 0, `[]` — **zero findings**. No console errors. All interactive elements are real `<button>`/`<input>`.
- **Key false positive (both A and the earlier manual check hit it):** Tailwind v4 emits `lab()` colors; a naive rgb() regex misreads them, producing a bogus ~1.1:1 for the amber button/badge. Measured through canvas sRGB the amber is **6.84:1 (pass)**.

## Priority issues + resolution
- **[P1] Secondary text failed AA (2.6:1):** task time + option address were `text-gray-400`. → **Fixed** to `text-gray-500` (time now 4.84:1). Time also given `tabular-nums`.
- **[P1] Status pill and action button looked identical (both amber-50/200):** → **Fixed** — the "Đổi địa điểm" action is now the heavier `amber-100/300`, the informational pill stays `amber-50/200`. Amber kept on the action for discoverability (prior feedback lesson), weight now separates affordance from status.
- **[P1] Primary Vào Ca / Ra Ca white text failed AA (3.3 / 3.76:1) — pre-existing:** → **Fixed** to green-700 / red-600 (Vào Ca now 4.95:1).
- **[P2] No focus-visible on any button:** → **Fixed** — focus-visible rings added to Vào Ca, Ra Ca, Đổi địa điểm, option buttons, Huỷ.
- **[P2] Tap targets under 44px on mobile:** Đổi địa điểm 30→38px, picker search 30→38px, Huỷ 20→32px. → **Improved** (full-width, so horizontal target is large; heights raised via padding).
- **[P3] Section heading was an orphaned `<label>`:** → **Fixed** to `<h3>` with stronger weight.

## Remaining / deferred
- **Switch commits on first tap, no confirm** (A's sharpest question): the highest-consequence action is the least deliberated, while *creating* a task is guarded by a lock + shift-state + resolve-from-text. Left as-is pending a business-logic decision — it's reversible and server re-validates ownership/started-state, but not the correctness of the chosen branch.
- Empty state doesn't teach; "Đang thực hiện" vs "Chưa hoàn thành" never explained (P3).
- Field labels (Địa điểm, Nhân Viên) are unassociated `<label>`s — pre-existing, out of this redesign's scope.

## Persona notes
- **Casey (one-handed mobile):** the time — the fact most needed to verify "did I already check in?" — was the faintest element; now legible. Tap targets raised. Switch-on-first-tap remains a fat-finger risk (reversible).
- **Sam (accessibility):** all three state badges pass AA (5.2–6.8:1); amber action passes (6.4:1). Focus rings now present. Meaning-by-color-alone is a non-issue (text labels throughout). Remaining: list is `<div>`s not a `<ul>`; inputs rely on placeholder as name.
