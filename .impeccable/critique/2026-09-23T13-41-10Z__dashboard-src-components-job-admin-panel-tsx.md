---
target: Quản trị job panel
total_score: 19
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 4
target_identity: "file:/home/user/auto-assign/dashboard/src/components/job-admin-panel.tsx"
target_fingerprint: "sha256:af5e3dfbb815975ed3e3300994e57e4f3eb75274402faeca42acd2ee63fb4df1"
target_path: /home/user/auto-assign/dashboard/src/components/job-admin-panel.tsx
timestamp: 2026-09-23T13-41-10Z
slug: dashboard-src-components-job-admin-panel-tsx
---
Method: dual-agent (A: design review · B: detector + browser)

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of status | 2 | PSC list opens invisibly; row label stale after dropoff change; "Đã mở đến" never expires on screen |
| 2 | Match real world | 3 | Domain-true LẤY/GIAO + PSC codes; "D003" vs "BRA - D003"; unlock scope/duration unstated |
| 3 | User control / freedom | 2 | Bare window.confirm; dropoff confirm omits current destination |
| 4 | Consistency | 2 | ID + status repeated at two sizes; ad-hoc emerald/indigo; picker isn't the shared DriverCombobox; accent folding inconsistent |
| 5 | Error prevention | 2 | Irreversible "Hoàn thành job" is the loudest, first, widest element; mid-route warning is 11px |
| 6 | Recognition vs recall | 2 | Must retype 8-digit ID from the queue; placeholder-only labels; search scope invisible |
| 7 | Flexibility / efficiency | 1 | No keyboard PSC selection; no deep link from queue/log; nested scroller |
| 8 | Aesthetic / minimalist | 2 | ~1490px-wide buttons; header/editor duplication; three equal coloured bars |
| 9 | Error recovery | 2 | 1-char query says "no match"; generic "Lỗi kết nối"; not-found inside a fake row |
| 10 | Help / docs | 1 | Unlock duration/scope, search scope, completion consequences all unexplained |
| **Total** | | **19/40** | **Poor** |

## Design Specificity Verdict
LLM: Diag-specific content (LẤY/GIAO, PSC codes, geofence unlock, started-route warning, Cartrack deep link, status-aware actions) in a generic shell (stock card, accordion, three full-width coloured bars). Ignores the queue it serves.
Deterministic: CLI detect 0 findings. Browser detect.js: in-panel undersized-ui-text (10px badge :307, LẤY :341, GIAO :345), low-contrast on "Hoàn thành job" 3.5:1 (:362), nested-cards x12 on result rows (mostly false positive). Out-of-panel: header cramped-padding, Inter overuse, body height transition, 449px mobile overflow from header actions. Detector missed slate-400 contrast (~2.5:1) on LẤY/GIAO/helper text.

## Priority Issues
- [P0] PSC picker clipped by the 30vh scroller (:280, :412) and mouse-only (onMouseDown li, no combobox ARIA). Fix: portal/popover or reuse DriverCombobox; full keyboard + ARIA; accent-folded filter. /impeccable harden
- [P1] Race: opening row A then B can render A's details under B (no stale-response guard in fetchJob). Fix: request token / AbortController. /impeccable harden
- [P1] Editor inside a 30vh inner scroller at page bottom; actions below the inner fold. Fix: right-hand inspector next to the queue, or drop max-h when open + scrollIntoView. /impeccable layout
- [P1] No bridge from queue rows to the tool; retyping IDs. Fix: onOpenJob callback, "Quản trị" action on queue/log rows. /impeccable layout
- [P1] Inverted action hierarchy; irreversible action most prominent; emerald button fails AA. Fix: group by consequence, auto-width, quieter separated complete, styled confirm restating pickup → dropoff + driver. /impeccable distill
- [P2] Status drift + invisible search scope (stale label, unlock never expires, 1-char "no match", accent-sensitive log search). /impeccable clarify

## Persona Red Flags
Alex: retypes IDs; no arrow-select PSC; double scroll; no ordering/timestamps on results.
Sam: placeholder-only labels; no aria-expanded; mouse-only × clear; no role=status/alert; slate-400 at ~2.5:1; 10px badges.
Supervisor: panel below the fold under collapsed Nghỉ phép; stale row label makes them doubt the change; driver-scoped unlock not stated.

## Minor Observations
"#99999999 / Job 99999999" duplicated; #ID link lacks ↗; "Quản trị job" title weak; env reset effect is dead code (env hardcoded "prod", dashboard.tsx:73); two badge sizes; "D003" vs "BRA - D003".

## Questions to Consider
- Should queue rows expand into these actions instead of a separate search box?
- Should force-complete be a logged two-step with a reason?
- What if this became a persistent inspector any job ID in the app can open?
