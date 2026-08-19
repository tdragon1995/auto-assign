---
target: dashboard
total_score: 25
p0_count: 0
p1_count: 3
timestamp: 2026-07-20T03-22-59Z
slug: dashboard-src-components-dashboard-tsx
---
# Critique — Fleet Auto-Assign Dashboard

Method: ⚠️ DEGRADED: single-context (harness policy restricts spawning sub-agents without an explicit user request; Assessment A was fully formed before the detector ran, preserving the ordering invariant). Browser visual capture unavailable this session (capture timed out repeatedly; preview closed) — Assessment B used the deterministic detector + the rendered accessibility tree + source.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Heartbeat + attention badge + toasts are good; "armed until 22:00 / by whom" is tracked but not surfaced; no loading skeletons |
| 2 | Match System / Real World | 2 | VN domain language is right, but chrome mixes EN/VN ("Live Log", "Distance checking", "Auto-Assign"); "Nhịp" + bare time is cryptic |
| 3 | User Control and Freedom | 3 | Cancel on editors, env-switch disarms first, optimistic-assign re-emerges on failure |
| 4 | Consistency and Standards | 2 | Two color systems (shadcn tokens defined but unused vs hardcoded slate/indigo/amber); button sizes + primary-action colors diverge |
| 5 | Error Prevention | 3 | Sub-editor validates windows/overlaps/name-in-list; env change auto-disarms |
| 6 | Recognition Rather Than Recall | 3 | Tabs labeled (not icon-only), datalist autocomplete; but fleet-code prefixes + "Nhịp" + PROD/UAT direction lean on recall |
| 7 | Flexibility and Efficiency | 2 | Daily power user, yet no keyboard shortcuts, no bulk assign, no command palette; assign is one-at-a-time |
| 8 | Aesthetic and Minimalist Design | 2 | 9–11px fonts everywhere, ragged flex-wrap card mosaic, side-stripe borders, crowded header; high visual-noise floor |
| 9 | Error Recovery | 3 | Specific VN toasts ("Gán Job X thất bại: …"), row re-emerges, leave-error line only when empty |
| 10 | Help and Documentation | 2 | Good empty-state helper text, but no tooltips/inline help for "Nhịp", PROD/UAT; no onboarding |
| **Total** | | **25/40** | **Acceptable — significant improvements needed** |

## Anti-Patterns Verdict

**LLM assessment:** Does not look like generic marketing-AI slop — it's an honest, dense internal tool and the density is largely earned. But it fails the *product* slop test ("would a user fluent in Linear/Stripe trust every component?") on consistency: two parallel color systems, button vocabularies that don't match screen-to-screen, and a micro-typography floor (9–11px) that reads as "cram everything in" rather than "designed density." The tool mostly disappears into the task, but the seams show.

**Deterministic scan (detect.mjs, 6 findings):**
- `side-tab` (colored `border-l-4`) ×4 — activity-log.tsx:80, failed-jobs-panel.tsx:93, :322, :345. This is an impeccable **absolute ban** and the detector's headline tell.
- `gray-on-color` ×2 — schedule-list-panel.tsx:138 (`text-slate-600` on `bg-indigo-600`) is a **real contrast failure** (~1.3:1, effectively unreadable); failed-jobs-panel.tsx:159 (`text-slate-700` on `bg-blue-50`) is a likely **false positive** (~9:1, fine).

**Visual overlays:** No reliable user-visible overlay available — browser injection/capture was not reachable this session. Fallback signal: source + rendered accessibility tree + CLI detector.

## Overall Impression

This is a competent, information-dense dispatch cockpit that does the hard part well — it's legible about *what the engine did* and lets a supervisor override. The single biggest opportunity is **hierarchy through restraint**: right now everything is small and roughly equal weight, so the eye has no landing point. Making the primary things bigger (and the reference things quieter) would do more for "clean and intuitive" than any new feature. The request "clean looking" maps almost entirely to heuristic #8 and #4.

## What's Working

1. **Legible automation, as promised.** Failed jobs carry a plain-VN reason chip (`Không có tài xế trực`, `Nghỉ, không người thay`), a deep link to the Cartrack map, and an inline manual-assign — the "see what happened and override it" principle is real, not aspirational.
2. **Empty states teach.** "Không có mục nào cần xử lý" + the subtext explaining what *will* appear here is exactly the product-register standard, and better than most internal tools ship.
3. **Optimistic UI with honest rollback.** Manual assign and "Giao ngay" hide the row immediately and re-emerge the exact row with a specific error toast on failure — good status visibility under real network conditions.

## Priority Issues

**[P1] Visual density collapses the hierarchy.** Body/labels run at `text-[9px]`/`[10px]`/`[11px]` throughout the leave and failed-job cards, fleet codes at `text-[9px] text-slate-400`, and cards tile via `flex-wrap gap-1` into a ragged mosaic. Nothing is clearly primary. *Why it matters:* the supervisor's one job on landing is "what needs handling now," and there's no visual landing point; small gray text also risks WCAG-AA failure. *Fix:* set a 12–13px floor for interactive text, define three weights (primary name / secondary window / muted code), give cards a fixed min-width column instead of wrap-tiling. → `/impeccable layout`

**[P1] Two color systems + inconsistent component vocabulary.** globals.css defines the full shadcn neutral token set, but the dashboard hardcodes `slate-*` / `indigo-*` / `amber-*` / `red-*` and never uses the tokens. Primary actions are indigo-600 (assign button, links) in some places and slate-800 (active tab) in others; buttons range from `h-5 px-1.5 text-[10px]` custom to `size="sm"`. *Why it matters:* it's the product slop tell — subtly-off components erode trust, and there's no single accent to anchor "this is the action." *Fix:* pick one accent (indigo), route it through a token, and standardize one button scale. → `/impeccable polish` (or `/impeccable extract` to systematize)

**[P1] Reference data owns the action surface.** On the `⚠️ Cần xử lý` tab, the read-only leave roster (`max-h-[38vh]`) sits *above* the actionable exception list. In the common case (nothing to action), the leave list dominates a tab literally named "needs handling." *Why it matters:* it inverts the intended hierarchy and pushes the actual work below the fold. *Fix:* collapse leave to a one-line summary that expands ("3 nghỉ hôm nay · 1 chưa có người thay ▸"), and float the one *actionable* leave case (uncovered) into the exception list. → `/impeccable layout`

**[P2] Side-stripe accent borders (`border-l-4`) ×4.** activity-log + failed-jobs rows use a thick colored left border as the tone signal. It's an impeccable absolute ban and the #1 AI-UI tell. *Fix:* replace with a full 1px border + faint tinted background, or a leading colored dot/chip. → `/impeccable quieter`

**[P2] Language mixing + cryptic chrome labels.** The tab bar and header interleave EN and VN ("Live Log", "Distance checking", "Smart History" beside "Cần xử lý", "Quản trị job"); "Nhịp 14:23" and the two-word PROD⟷UAT toggle are ambiguous. *Why it matters:* the office-worker/driver audiences are non-technical VN speakers; mixed chrome adds a translation tax and makes the toggle direction guessable-only. *Fix:* standardize VN chrome, relabel heartbeat to "Cập nhật HH:MM", make env a labeled segmented control with the active segment filled. → `/impeccable clarify`

## Persona Red Flags

**Alex (power-user supervisor, in the tool all day):** No keyboard shortcuts anywhere — not even Refresh or tab-switch. Manual assign is strictly one-at-a-time; a morning with several failed jobs is N separate search-and-click flows with no bulk path. `h-5` buttons and the `+ Thêm` control are small click targets that slow a fast user. Arming requires a `window.prompt()` for a name — a jarring native modal on a power path.

**Sam (accessibility / low-vision, keyboard):** `text-[9px] text-slate-400` fleet codes and `text-[10px] text-slate-400` timestamps almost certainly fail AA contrast at that size. Tone is carried heavily by color (amber = uncovered, red = resigned, green = covered) with only partial text/✓ backup. Confirmed contrast failure at schedule-list-panel.tsx:138 (slate-600 on indigo-600). Custom tab `<button>`s are focusable but have no distinct visible focus ring beyond the browser default.

**Minh (project persona — logistics supervisor, PRODUCT.md):** Lands on the exception tab to answer "is the engine alive and what's on fire?" The liveness signal is a single small "Nhịp" pill, and the exception list — the actual answer — is pushed below a leave roster. The one glance the whole tab exists for is the slowest glance on the page.

## Minor Observations

- shadcn tokens are defined but effectively dead code; the app is themeless relative to its own design system (dark mode won't work on any hardcoded-slate surface).
- No skeleton/loading states — the product register calls for skeletons over empty flashes; panels pop in after fetch.
- Leave cards are card-like `div`s nested inside a `Card` `CardContent` — approaching the nested-card anti-pattern.
- `window.prompt()` for the admin name is an out-of-system native dialog on the arm path.
- failed-jobs-panel.tsx:159 gray-on-color is a detector false positive (slate-700 on blue-50 is ~9:1).

## Questions to Consider

- What if "is the engine running, and until when" were a persistent status line instead of a small header switch — would that remove the daily "wait, is it on?" glance?
- Does the leave roster need to be visible on the action tab at all, or is it reference that belongs one tap away?
- If you set a 13px floor and deleted every `text-[9px]`, what would actually stop fitting — and is that thing earning its place?
- What would the "confident" version of the header look like with one accent color instead of four?
