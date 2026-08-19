---
target: Cần xử lý note-review panel
total_score: 23
p0_count: 0
p1_count: 2
timestamp: 2026-07-22T11-13-43Z
slug: dashboard-src-components-note-review-panel-tsx
---
Method: ⚠️ DEGRADED: single-context (harness policy: sub-agents not auto-spawned; user did not request). Browser live-inspection skipped — panel only renders with live note-held jobs in Redis; user screenshot + source + detector used instead.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Optimistic row-removal on schedule can read as "did it work?" before the background write confirms |
| 2 | Match System / Real World | 3 | Mostly plain Vietnamese, but "Tasks có ghi chú" mixes English; error copy leaks "sched 422" |
| 3 | User Control and Freedom | 2 | No undo after Giao ngay / Lên lịch — the row vanishes; recovery is only via Cartrack |
| 4 | Consistency and Standards | 2 | Three control vocabularies in one row: custom chips + native select + shadcn Buttons |
| 5 | Error Prevention | 3 | window.confirm on Giao ngay, future-only time filter — good; but button coupling is a hidden mode |
| 6 | Recognition Rather Than Recall | 2 | Hidden rule (pick time → Giao ngay disables) must be discovered; 96-item time dropdown |
| 7 | Flexibility and Efficiency | 1 | No bulk actions, no keyboard, 96-option scroll, no presets — worst for an all-day power user |
| 8 | Aesthetic and Minimalist | 3 | Detector clean, no slop; but identical amber notes + repeated control scaffold create noise |
| 9 | Error Recovery | 2 | Failed job reappears with red banner (good) but message leaks a raw status code |
| 10 | Help and Documentation | 2 | No inline explanation of note-approval semantics or the button coupling |
| **Total** | | **23/40** | **Acceptable — significant improvements before the supervisor is happy** |

## Anti-Patterns Verdict

**LLM assessment**: Does NOT look AI-generated. This is a restrained, dense internal tool — the right instinct for the register. No gradient text, no glass, no eyebrow scaffolding, no hero-metric template. The failure mode here is the opposite of slop: it's *over-compressed* — everything shrunk to 10–11px and stacked, so the panel reads as a wall of near-identical amber rows rather than a scannable queue.

**Deterministic scan**: `detect.mjs` returned `[]` — zero findings on note-review-panel.tsx. Confirms the LLM read: no mechanical slop tells.

**Visual overlays**: Not available (no reliable in-page injection for this Redis-gated panel state). Fallback: source + user screenshot.

## Overall Impression

The panel does the right thing structurally — inline scheduling, no modal, optimistic feedback, real error recovery. But it's tuned for information density at the expense of the two things the supervisor actually needs when clearing this queue: **(1) telling the rows apart** (all three notes are the identical boilerplate "VỀ NHÀ CHỊ HUỆ", yet the note is the most visually prominent element, while the differentiating customer line is plain) and **(2) acting fast across many jobs** (each row forces a one-at-a-time, mouse-only, scroll-a-96-item-dropdown interaction). The single biggest opportunity: make the two actions an explicit choice instead of a hidden button-coupling mode.

## What's Working

1. **Inline scheduling, no modal.** The day chips + time + actions live on the row itself — exactly the product's "fewer steps, not more screens" principle. Right call.
2. **Real optimistic-then-reconciled feedback.** onAssigned removes the row instantly; a failed background write reappears with a red banner and "vui lòng thử lại". That's a genuine recover loop, not a fire-and-forget.
3. **Guardrails on the risky path.** window.confirm before Giao ngay (which bypasses the note gate), and the time list is filtered to future slots with past-time cleared when switching back to today.

## Priority Issues

- **[P1] The two actions are a hidden mode.** `Giao ngay` is disabled the moment a time is picked (`disabled={... || !!timeLabel}`); `Lên lịch` is disabled until one is (`disabled={... || !timeLabel}`). Both buttons are always visible, so a greyed-out button has no visible cause — the supervisor can't tell *why* Giao ngay is dead.
  - **Why it matters**: A disabled control with no explanation is the classic "is it broken?" trigger. It forces trial-and-error to learn the rule.
  - **Fix**: Make it an explicit branch. A small segmented control — `Giao ngay` | `Hẹn giờ` — and only reveal the day-chips + time picker when "Hẹn giờ" is chosen. One primary button whose label follows the mode. Removes the coupling entirely.
  - **Suggested command**: /impeccable layout

- **[P1] Time entry is a 96-option native scroll.** 00:00–23:45 in 15-min slots means the common case ("this afternoon, 14:00") is a long scroll or a lot of keyboard-jumping every single time.
  - **Why it matters**: For a power user repeating this dozens of times a day, this is the single slowest step in the flow.
  - **Fix**: Swap for a `<input type="time" step="900">` (type "1400", done), or offer 3–4 one-tap presets for the frequent slots alongside a full picker.
  - **Suggested command**: /impeccable layout

- **[P2] Everything is 10–11px, contradicting the product's own "generous touch targets" principle.** Day chips are `text-[10px]` at ~20px tall; the time select options are `text-[10px]`. PRODUCT.md explicitly promises "generous touch targets, low cognitive load."
  - **Why it matters**: Small dense controls slow scanning and raise misclick rate for an all-day user, and directly violate the stated design principle.
  - **Fix**: Floor interactive text at 12px (`text-xs`), give chips/select ≥28–32px height. Density can stay tight elsewhere; interactive targets shouldn't be the smallest thing on screen.
  - **Suggested command**: /impeccable layout

- **[P2] The identical boilerplate note carries the most visual weight; the differentiator does not.** All three rows show the same amber "Ghi chú: VỀ NHÀ CHỊ HUỆ" box, larger and more colored than the customer line that actually distinguishes the jobs.
  - **Why it matters**: The supervisor re-reads identical text three times to confirm there's nothing new, and has to work to find the line that differs. Hierarchy is inverted.
  - **Fix**: Lead each row with the customer/route as the strong element; treat the note as secondary. Consider collapsing a note that repeats across rows, or de-emphasizing very short/boilerplate notes so genuinely unusual notes stand out.
  - **Suggested command**: /impeccable layout

- **[P2] No bulk action on a queue of look-alikes.** When several held jobs need the same disposition, they must be cleared one row at a time.
  - **Why it matters**: The whole point of this tab is fast exception-clearing; one-at-a-time is the power-user's main friction (Alex red flag).
  - **Fix**: Select-multiple + a shared "Giao ngay tất cả đã chọn" / "Hẹn giờ đã chọn" bar. Even a per-note "apply to all rows with this note" would help.
  - **Suggested command**: /impeccable shape

## Persona Red Flags

**Alex (Power User — this is Linh, the all-day supervisor)**: No keyboard path — day/time/actions are mouse-only. No bulk clear for a queue built to be cleared fast. The 96-item time dropdown is scrolled fresh on every job. A disabled "Giao ngay" with no reason forces her to learn the coupling by poking. This persona is who the tab is *for*, and it's where the design is weakest (Flexibility scored 1/4).

**Sam (Accessibility-Dependent)**: 10px interactive text and ~20px chip targets are below comfortable low-vision / motor thresholds. Verify the `Ghi chú` label (amber-700 on amber-100) hits 4.5:1 — it's borderline for 11px bold. Disabled buttons at `opacity-40` likely drop below AA. State ("Đang xử lý…", success, the reappear-on-fail) should be announced, not just visual.

**Riley (Stress Tester)**: The optimistic remove + background write is the fragile edge — a schedule that vanishes then silently reappears seconds later with "sched 422" is confusing, and the raw status code leaks. What happens if the same job is scheduled twice quickly before the row is removed? Worth probing.

## Minor Observations

- "Tasks có ghi chú" mixes English "Tasks" into an otherwise-Vietnamese UI; "Việc có ghi chú" (or just the count) would be consistent.
- Error copy "Lên lịch lỗi: sched 422" surfaces an internal status code to a non-technical supervisor. Humanize it.
- `Ghi chú` amber-700-on-amber-100 label: verify contrast at 11px.
- Optimistic removal fires before the background Cartrack write confirms; consider a brief "scheduling…" pending row state instead of an immediate vanish.

## Questions to Consider

- What if picking a time were the *only* decision, and "now vs later" were one explicit toggle instead of two buttons fighting over the same time field?
- Does a note that's identical across every row need to be shown in full on every row?
- If this queue is meant to be emptied quickly, what would a keyboard-first, select-many version feel like?
