---
target: dashboard
total_score: 29
p0_count: 0
p1_count: 0
timestamp: 2026-07-20T04-32-55Z
slug: dashboard-src-components-dashboard-tsx
---
# Critique — Fleet Auto-Assign Dashboard (iteration 2)

Method: ⚠️ DEGRADED: single-context (harness policy restricts spawning sub-agents; Assessment A formed before the detector ran). Assessment B: bundled detector (post-edit) + live production screenshot at 11:27.

## Design Health Score

| # | Heuristic | Score | Δ | Key Issue |
|---|-----------|-------|---|-----------|
| 1 | Visibility of System Status | 3 | = | Heartbeat now reads "Cập nhật 11:27"; run-state still only a header switch (no "armed until 22:00" line) |
| 2 | Match System / Real World | 4 | ▲2 | Chrome fully VN now; only residual tokens "job" (Quản trị job) / "Smart" (Lịch sử Smart) |
| 3 | User Control and Freedom | 3 | = | Segmented env control no-ops on the active side (nice guard); cancel/undo intact |
| 4 | Consistency and Standards | 3 | ▲1 | Accent unified to indigo, side-stripes gone; shadcn tokens still unused underneath |
| 5 | Error Prevention | 3 | = | Env now a clear segmented control instead of an ambiguous switch |
| 6 | Recognition Rather Than Recall | 3 | = | Labeled tabs + autocomplete; fleet codes still terse |
| 7 | Flexibility and Efficiency | 2 | = | Still no keyboard shortcuts, no bulk assign for the daily power user |
| 8 | Aesthetic and Minimalist Design | 3 | ▲1 | Quiet tinted cards read clean; held back by a large empty void + a lone card that truncates beside empty space |
| 9 | Error Recovery | 3 | = | Specific VN toasts, optimistic rollback |
| 10 | Help and Documentation | 2 | = | Good empty-state text; still no tooltips/onboarding |
| **Total** | | **29/40** | **▲4** | **Good — solid foundation, minor polish left** |

## Anti-Patterns Verdict

**LLM assessment:** The card treatment no longer reads AI-generated. The faint-tint + full-border cards (`border-red-200 bg-red-50/50`) are exactly the restrained product-register move, and killing the side-stripes removed the #1 tell. The screenshot's remaining weakness is *sparseness*, not slop — a large bordered void below three items.

**Deterministic scan (post-edit):** 0 `side-tab` findings (was 4 + 1 purple = 5). Remaining 3 `gray-on-color` are all confirmed false positives: dashboard L352/359 are the inactive segmented-control labels on the dark header (~5.9:1), and schedule-list L138 is a ternary the detector misreads (white-on-indigo active / slate-on-slate inactive). Net: the detector is effectively clean.

## Overall Impression

Two passes took this from "dense and AI-flavored" (25) to "clean, legible, on-brand product tool" (29). The exception list now leads, the cards are quiet, and the chrome speaks one language. What's left is genuinely minor: the panel looks *empty* on a light day, and a single-item section still truncates a route while empty space sits beside it. Both are layout-shape issues, not craft issues.

## What's Working

1. **Quiet, legible cards.** The tinted-fill + full-border treatment signals severity (red/amber) without shouting; severity now reads from fill color, not a stripe.
2. **One language, one accent.** VN chrome throughout (`Cập nhật`, `Nhật ký`, `Khoảng cách`, `Tự động`, `Làm mới`) and indigo as the single interactive accent — the "two products stitched together" feel is gone.
3. **The env control is now unmistakable.** A filled red PROD / gray UAT segmented control removes the old two-word-switch ambiguity on the most consequential control on the page.

## Priority Issues

**[P2] The panel reads empty on a light day.** With 3 items, a large faint-orange-bordered void dominates below the list. *Fix:* soften the panel's `border-orange-300` to a neutral border (the ⚠️ title already carries the "attention" signal), and let the card list hug its content height rather than filling `72vh` when short.

**[P2] A lone card still truncates into empty space.** The single "Không có tài xế trực" card occupies one column of the 2-col grid, so it's ~half width and truncates "Thẩm Mỹ Việ…" while the right half sits empty. *Fix:* let a single-item section span the full row (`auto-fit`/`grid-cols-1` when count === 1), so short lists show routes in full.

**[P3] Redundant reason chip.** In a section already headed `KHÔNG CÓ TÀI XẾ TRỰC`, every card repeats a red `Không có tài xế trực` chip. *Fix:* drop the chip when it equals the section label (or de-emphasize the section header), removing the double-statement.

**[P3] Residual English tokens.** `Quản trị job` and `Lịch sử Smart` still mix a word in. Minor — "job"/"Smart" are near-domain terms, but "Quản trị công việc" / "Lịch sử thông minh" would complete the VN pass.

## Persona Red Flags

**Alex (power-user supervisor):** unchanged — still no keyboard shortcuts and no bulk assign; a multi-failure morning is still N separate search-and-click flows.
**Sam (low-vision):** improved — 11px floor + slate-500 clears AA, indigo accent is consistent; severity is still color-first, though the reason chip/section text backs it up.
**Minh (supervisor):** much better — the exception list leads, "Cập nhật 11:27" answers "is it alive?" at a glance, and the collapsed leave summary keeps the actionable count visible.

## Minor Observations
- shadcn tokens still defined-but-unused; dark mode remains impossible on the hardcoded-slate surfaces (out of scope by choice).
- Late-pickup cards now sit side-by-side (2-col) and fill nicely — the layout fix landed where there are ≥2 items.

## Questions to Consider
- On a quiet day, should the exception panel shrink to its content instead of framing a 72vh void?
- Is the per-card reason chip earning its space when the section header already names the reason?
- What's the smallest change that would give Alex a bulk-assign path for a bad morning?
