# misa-fetcher

Fetches driver shift schedules + leave requests from MISA AMIS and writes them to
**Supabase** (`public.driver_shifts`) and the **"Driver Shift" Google Sheet tab**.

Replaces the old Apps Script MISA module that needed session cookies pasted by
hand. Here, every run performs a **fresh automatic login** (username + password +
TOTP) inside a real headless Chromium, so there is no stored session that can
expire. Cloudflare/F5 are satisfied because all API calls run inside the browser
page itself.

## How it runs

- **Scheduled:** GitHub Actions ([misa-shifts.yml](../.github/workflows/misa-shifts.yml))
  at 04:45 and 12:00 VN daily, plus manual runs from the Actions tab.
- **Locally:** `npm install && npx playwright install chromium`, copy
  `.env.example` → `.env`, then `npm run fetch` (or `npm run dry-run` to fetch
  without writing anywhere — output lands in `out/`).

## Data flow

```
MISA AMIS ──(headless login + in-page API calls)──┐
"PT Shift Pattern" tab (weekly, part-timers) ─────┼──▶ merge + parse
Driver tab (employee_code → driver_id) ───────────┘
    ├─▶ POST /api/nghi-phep  ──▶ "Nghỉ phép" tab   (approved leave; engine source)
    ├─▶ Apps Script web app  ──▶ "Driver Shift" tab (flat, 8 cols)
    ├─▶ Apps Script web app  ──▶ "Lịch Ca" tab      (month grid, colour-coded)
    └─▶ Supabase public.driver_shifts               (dormant until keys are set)
```

Flat tab format: `employee_code | full_name | date | start_time | end_time |
leave_start_time | leave_end_time | leave_gap` — `start_time` holds `OFF` or the
holiday name on non-working days; `leave_gap` = `1` marks a day someone is on
approved leave but still rostered (see below).

## Part-time roster

~70 active part-timers have no MISA account. Their shifts live in a **`PT Shift
Pattern`** tab as a weekly recurring pattern, expanded to daily rows at run time
and merged with the MISA data:

| driver | employee_code | active_from | active_to | mon | tue | wed | thu | fri | sat | sun | note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `P - P - PT101279 Đỗ Anh Quốc` | PT101279 | | | 06:00-15:00 | | 06:00-15:00 | … | | | | |

`driver` must match the Driver tab label exactly. A blank day cell (or `OFF`)
means not working. Anyone already in MISA is skipped, so a person in both
sources is never rostered twice. If the tab is missing the run continues with a
warning.

**The pattern is effective-dated.** To change someone's hours, add a new row
rather than editing the old one:

- `active_from` — first day the pattern applies. Blank = always.
- `active_to` — last day it applies. Blank = still current.

So a person can hold several rows and the one in force on a given day wins
(latest `active_from` that has started and not ended). This keeps the history,
lets a change be entered before it takes effect, and represents a joiner or
leaver as a date rather than an anomaly. Outside every dated range a person
produces no rows at all, rather than showing as "off".

## Part-time twin

About a dozen people hold **two** Cartrack accounts under one personal name: a
full-time `DC…` record and a part-time `PT…` one. The full-time account works the
rostered shift; the part-time account is what picks up a trip running past it.
MISA only knows the employment it charges the leave against — the full-time one —
so a day off used to leave the twin reading as available all evening.

Every charged leave day therefore also produces a row for the twin:

| MISA day | PT companion row |
|---|---|
| full day | full day |
| half day ending **after 12:00** | from when the person leaves until `23:59` |
| half day ending by 12:00 (morning) | none — they are back for their own shift |
| half day with no usable window | none — the engine ignores such a row anyway |

The afternoon window deliberately does **not** mirror MISA's. A 12:00–18:00 leave
copied verbatim would leave 18:00–22:00 open, and that stretch is the only reason
the twin account exists — the feature would look like it worked and change
nothing.

The twin is taken only when the name matches **exactly one** active part-time
account, the same timidity as `driver-match.ts` on the dashboard side. Two
candidates and the day is left alone and the person named in the run log:
inventing a day off on the wrong record takes a *working* driver off the road,
which is worse than the gap being closed. Companion rows are written with a note
of `MISA auto PT <stamp>`, so a supervisor can tell them from a day MISA actually
charged — and remove one from the dashboard if it is wrong.

Pinned offline by `node scripts/pt-companion.test.mjs`.

## Leave/roster gaps

MISA deducts leave against a company calendar, but each person has their own
roster. When someone takes continuous leave across a day the calendar calls
non-working — yet their roster has them scheduled — MISA charges nothing and
attaches no leave window, so they read as available. Those days are flagged
(`leave_gap`, red in both sheet tabs) rather than silently passed through.

## Secrets (GitHub → repo Settings → Secrets and variables → Actions)

| Secret | Value |
|---|---|
| `MISA_USERNAME` | MISA AMIS login email |
| `MISA_PASSWORD` | MISA AMIS password |
| `MISA_TOTP_SECRET` | Base32 authenticator secret |
| `SUPABASE_URL` | `https://qudnkxivfgntwvmydpkt.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → service_role |
| `SHEET_WEBAPP_URL` | `/exec` URL of the deployed `misa_shift_webapp.gs` web app |
| `SHEET_WEBAPP_TOKEN` | Shared token (same value pasted into the .gs file) |

A sink whose secrets are missing is skipped with a warning, so the pipeline can
be brought up one piece at a time.

## Sheet web app setup (once)

See the header of [misa_shift_webapp.gs](../misa_shift_webapp.gs) — paste it into
the cartrack_combined Apps Script project, set the token, deploy as a web app
(Execute as: Me / Access: Anyone), and put the `/exec` URL into the secrets.

## Notes

- A leave request approved only in PART still leaves the rows this pushed on the
  sheet — cancelling it in MISA does not reach back here. Remove those from the
  dashboard's Nghỉ phép panel ("Xoá" on the row); a later run will not re-add a
  day MISA no longer charges.
- Leave data uses the MISA attendance-watch view with `Status: 2` — the same
  filter the old module proved working. If leaves ever look wrong, verify what
  status code means "approved" on this tenant.
- The current month is computed in `Asia/Ho_Chi_Minh` regardless of runner TZ.
- Session state is cached between CI runs purely to reduce login/"new device"
  noise; any invalid state falls back to a fresh login automatically.
