# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Fleet Auto-Assign** service for Cartrack (a Telematics fleet management platform). It automatically assigns unassigned delivery jobs to drivers based on customer–driver mappings stored in a Google Sheet.

The active codebase is `dashboard/` — a Next.js 15 (React 19, TypeScript) web app deployed to **Vercel**.

## Dashboard Commands

All commands run from `dashboard/`:

```bash
npm run dev     # Start dev server (http://localhost:3000)
npm run build   # Production build
npm run lint    # ESLint
```

## Pre-push Checklist

Always run `npm run build` from `dashboard/` before pushing. Vercel runs the same build — if it fails locally it will fail in production. Common mistake: removing a field from an object/type without grepping for all usages of that field in the same file (TypeScript will catch this at build time, not in the editor).

No test suite exists currently.

## Environment Variables

Copy `dashboard/.env.example` to `dashboard/.env.local`:

```
CARTRACK_AUTH=Basic ...           # Required: Cartrack REST API auth header
CARTRACK_COOKIE=CTSID=...        # Optional: session cookie for REST calls
CARTRACK_AUTH_UAT=Basic ...      # UAT environment equivalent
CARTRACK_COOKIE_UAT=...
CARTRACK_WEB_PASS=               # Required for JSON-RPC (route optimise, duplicate rejection)
CARTRACK_REJECT_PROXY_DRIVER_ID= # Driver UUID used to proxy-assign then reject duplicate jobs
GOONG_API_KEY=                   # Road distance API (goong.io); falls back to haversine if absent
ROUTE_OPTIMIZE_PILOT=            # Comma-separated driver UUIDs for route optimisation pilot
LABCENTER_EMAIL=                 # Labcenter API login (used by /api/customers POST to sync pick/drop locations)
LABCENTER_PASSWORD=              # Labcenter API password
LABCENTER_RECEPTIONIST_EMAIL=    # Separate receptionist account for /api/labcenter/client (client search in sales form)
LABCENTER_RECEPTIONIST_PASSWORD= # Password for receptionist account
LEAVE_NAME_RECOVERY=             # Set to "0" to stop recovering a leave row from its typed name
```

`LEAVE_NAME_RECOVERY` is ON unless set to `0`. When a leave row's `driver_id` comes
back blank — nearly always because the driver was renamed in Cartrack, which rewrites
the roster tab's name column and orphans every row typed against the old spelling —
the engine resolves the typed name against the *active* roster and honours the leave
if **exactly one** working driver could be meant. It never guesses between two: about
a dozen drivers hold both a PT and a DC account under one personal name, so a bare
name matching both is left alone. Recovered rows are still reported for repair, in
blue rather than red. See `driver-match.ts`; step 4 of the config plan deletes it.

### Leave rows: written by MISA, removable by hand

The MISA sync (`misa-fetcher/`) writes one Nghỉ phép row per day MISA charged,
through the same `POST /api/nghi-phep` a driver's own form uses — so
`findLeaveConflict` makes a re-run idempotent. Two things follow from that:

- **A partly-approved request leaves rows behind.** Cancelling the rest in MISA
  does not reach back into the sheet, so the engine keeps the driver off on days
  they are working. `DELETE /api/leave-status` removes ONE row, identified the
  way `updateLeaveSubs` identifies one (driver + `leave_from` + window,
  re-resolved against the sheet at write time — never a row number the dashboard
  is holding). Where several rows answer to the same identity the UNCOVERED one
  goes first and the response says how many are left, so the substitute on a
  duplicate's twin is never the thing that disappears. It refuses the first data
  row: the tab is an append log so row 2 is months old, but it is also where a
  column-wide formula would be anchored. `scripts/leave-row-delete.test.mts`.

  **A delete IS a tombstone, because on its own it would not be.** The MISA
  pusher re-derives every charged day from today forward on each run and dedupes
  purely on the row being present, so a deleted future day MISA still charges
  would be written straight back at 04:45. Every delete therefore also appends a
  line to the **"Nghỉ phép đã xoá"** tab (created on first use), and
  `/api/nghi-phep` refuses to re-create a day carrying one — see
  `leave-suppression.ts`. Matching is EXACT on driver + day + window: two
  half-days on one date are two rows, and deleting the morning must not silence
  the afternoon.

  Two rules stop that list becoming a second truth that drifts:

  - **It only blocks an AUTOMATED push** (`automated: true`, or a note starting
    `MISA auto`). A person filing leave — the driver's form, the panel — is never
    blocked, so a stale suppression can never be why a real day off failed to
    register, and the way past one is the ordinary action rather than sheet
    surgery.
  - **It is visible and reversible.** Lines that can still block something are
    listed in the leave panel with a "Khôi phục" button
    (`DELETE /api/leave-status/suppression`); past ones are filtered out because
    the pusher floors its range at today and they can no longer block anything.
    Restoring only lifts the bar — the day returns at the next sync if MISA
    still charges it, and stays gone if it does not.

  The read **fails open**, deliberately. A missing tab and an unreadable one look
  identical through the gviz by-name endpoint (an unknown name returns the
  workbook's FIRST tab), and the tab genuinely does not exist until the first
  delete — so failing closed would refuse every leave submission on a fresh
  deploy, driver form included. An untrusted read lets the write through, which
  is exactly the pre-feature behaviour; once a process has read the tab once, a
  later failure raises the dashboard's sheet alarm instead of going quiet.
  `scripts/leave-suppression.test.mts`.

  Both post-write refreshes pass `fresh=1` (`loadLeaveStatus(true)`). Not for
  the server cache — the write path already cleared that — but because
  `loadLeaveStatus` skips any non-fresh reload inside a 5-minute window, which
  would leave the panel showing the row that was just deleted and invite a
  second click onto a row nobody meant to remove.
- **A day off is filed against the PART-TIME TWIN too.** About a dozen people
  hold both a `DC…` and a `PT…` account and switch to the second for a trip
  running past their shift; MISA only ever names the account it charges. A full
  day off copies as a full day; an afternoon half-day copies as "from when they
  leave until 23:59" — NOT the MISA window, which would leave the evening open
  and make the feature a no-op. A morning half-day copies as nothing. The twin
  must match by name to exactly one active PT account or the day is left alone
  and reported. `misa-fetcher/scripts/pt-companion.test.mjs`.

## Architecture

### Data Flow

1. **Config** is loaded on each assign cycle from a public Google Sheet (CSV export) via `src/lib/config.ts`. It maps `customer_id → driver_id` with optional shift windows and Zalo notification tokens.

2. **Dashboard UI** (`src/components/dashboard.tsx`) polls `POST /api/assign` every 3 minutes when running (hardcoded `180_000` ms in `dashboard.tsx`). It calls `POST /api/assign`, which handles all jobs (smart + fixed) in one cycle.

3. **Assign cycle** (`src/lib/assign.ts → autoAssignCycle`):
   - Fetches unassigned jobs (status 2) from Cartrack REST API
   - Skips jobs with stop notes
   - Day-boundary rollover: a once-per-day morning pass (Redis-gated, runs before the fetch on the first armed cycle) reclaims yesterday's unfinished ad-hoc jobs into today. It fetches yesterday's status 2 (unassigned) + status 4 (assigned-but-unfinished, incl. started), keeps only jobs with **no plan attached** (`hasPlanAttached` — plan slots regenerate daily, so rolling one would duplicate it), unassigns any stale driver, and re-dates `scheduled_delivery_ts` to today so the same cycle assigns them. `rolloverUnfinishedJobs` in `assign.ts`
   - Runs duplicate-detection: if an active route with the same pickup→dropoff pair exists today, proxy-assigns then JSONRPC-rejects the duplicate
   - For each job, chooses path:
     - **Smart path** (`smart_driver_id` populated): ranks candidates by GPS/start-location proximity using haversine + optional Goong road distance; assigns closest driver
     - **Fixed path** (`driver_id` populated): looks up shift schedule; assigns single on-duty driver or logs clash/no-driver

4. **Cartrack APIs** (`src/lib/cartrack.ts`):
   - REST: `https://fleetapi-vn.cartrack.com/rest/delivery` — jobs, drivers, assignment, customers creation
   - JSONRPC: `https://fleetweb-vn.cartrack.com/jsonrpc/index.php` — route optimisation, job rejection

5. **PSC Routes** (`src/lib/psc-config.ts`): separate Google Sheet for PSC sample-transport jobs (provincial routes). Has a 5-minute in-memory cache; invalidated by the dashboard Refresh button.

### API Routes

| Route | Purpose |
|---|---|
| `POST /api/assign` | Main assign cycle; `?env=prod\|uat`, `?skipSmart=1` |
| `GET /api/config` | Returns mapping/PSC route counts from sheets |
| `GET /api/config/rows` | The config table itself, for the dashboard's Config tab and the copy-a-branch picker. NOT on the status poll — ~1,700 rows, fetched on demand behind a 5-min in-process cache |
| `POST /api/config/delete-row` | Deletes one config row. Weekday only; refuses row 2 (the id ARRAYFORMULA anchor) and read-back-checks the spill afterwards |
| `GET /api/drivers` | Proxy to Cartrack drivers list |
| `POST /api/psc-assign` | PSC sample-transport job creation (creates unassigned job; auto-assign picks it up) |
| `GET /api/psc-routes` | Load PSC routes from sheet (pickup→dropoff pairs with GPS coords) |
| `GET /api/psc-tinh` | Provincial PSC route lookup; `?psc=D021` for 3PL options, `?psc=D021&mode=orders` for today's orders; `DELETE` cancels a job |
| `POST /api/smart-assign` | Smart-assign dry-run — returns ranked driver suggestions without assigning |
| `GET /api/audit` | List locations for weekly audit job creation; `POST` creates the audit job and assigns it |
| `GET /api/cham-cong` | Attendance (chấm công) — lists today's check-in/out jobs for a driver (`?driver_id=`); `POST` creates a check-in or check-out job |
| `POST /api/distance-checking` | Batch Goong road-distance queries (`{ rows: DistanceRow[] }`); sequential with 1s gaps |
| `GET /api/location-jobs` | Fetch all jobs for a date+status (`?date=YYYY-MM-DD&status=4`), paginating to exhaustion |
| `GET /api/customers` | Check for duplicate customer name in Cartrack; `POST` creates a new customer and syncs pick/drop location to Labcenter |
| `POST /api/geo/resolve` | Geocode/reverse-geocode via Goong |
| `GET /api/sales/locations` | Lists a client's Labcenter locations (`?client_code=`); `PUT` updates the contact phone in **both** Cartrack (`contact_number`) and Labcenter (`phone`), joined via the location's `cartrack_vn` integration link |
| `PUT /api/sales/address` | Updates a location's address + GPS in **both** Cartrack and Labcenter. Cartrack needs a full-record PUT (`address_line_1` is ignored by a partial PUT); Labcenter takes a direct address PUT. Both use read-back guards (the APIs 200 on writes they discard). Body must be proper UTF-8 — a Windows `curl` with inline Vietnamese mangles it and the write no-ops |
| `POST /api/sales/reject-job` | Rejects a sales job by reference number via JSON-RPC (guards against started jobs) |
| `GET /api/sales/search-trips` | Searches today's B2B trips by `?ma_kh=` (matches reference_number suffix); returns status 2+4 jobs only |
| `GET /api/tat/archive` | Manual/backfill archive of route **legs** into Supabase `tat_legs`; `?date=`, `?days=N`, `CRON_SECRET` auth. Idempotent (replaces the day). Routine archiving needs no cron — see footgun 8 |
| `GET /api/tat/me` | The signed-in driver's TAT report (today + week + month). Driver id from the `nv_session` cookie only |

### Shared Libraries

| Module | Exports |
|---|---|
| `src/lib/cartrack.ts` | `BASE_URL`, `JSONRPC_URL`, `getHeaders`, all Cartrack REST/JSONRPC wrappers |
| `src/lib/labcenter.ts` | `getAdminToken` / `getReceptionistToken` (cached JWT logins — admin for `spc-delivery`, receptionist for `spc-pos`), `listLocationsByClientCode`, `getCartrackCustomerId`, `updateLocationPhone`, `updateLocationAddress` |
| `src/lib/distance.ts` | `haversineKm`, `goongDistanceKm` (1→1), `goongMatrix` (1→N batch), `goongMatrixMultiOrigin` (N→1, one request — undocumented-but-verified Goong behavior, shape-checked with null-fill fallback) |
| `src/lib/distance-cache.ts` | `roadDistancesToPoint` (N→1), `roadDistancesFromPoint` (1→N) — resolve pairs cheapest-first: self-pair = 0 km free, then a non-expiring Redis cache (`dist:v1:` keys **truncated to 5 dp** — read, don't round, mirrors Excel `TRUNC`; value `{distance_km, eta_mins, from, to}` keeps the exact coords), then ONE matrix call for misses (write-behind; nulls never cached). Each result carries `source: "self"\|"cache"\|"api"`. `exportCachedDistances()` dumps all pairs (read-only SCAN+MGET) for download |
| `src/lib/job-filters.ts` | `JOB_STATUS`, `STOP_STATUS` maps; `isActiveStop`, `isCompletedOrRejectedStop`, `isStopStarted` |
| `src/lib/smart-rank.ts` | `RefStop`, `RefLabel`, `selectReferenceStop`, `computeStopStats`, `rankingComparator`; anchor honesty: `isUnreachedAnchor`, `liveGpsRef`, `lastRealPositionRef` (see footgun 9) |
| `src/lib/time.ts` | `vnDate`, `vnTimestamp`, `vnHoursMinutes`, `vnMinutesSinceMidnight`, `vnDayWindow`, `parseVnTimestamp` |
| `src/lib/tat.ts` | Driver TAT: `legsForRoute` / `buildDayLegs` cut a day into **legs** (rides between consecutive stops, in the order actually worked), `MINS_PER_KM`, `targetMinsFor`, `summarize`. See `docs/driver-tat.md` |
| `src/lib/tat-archive.ts` | `archiveDay` — fetch, price and **replace** one day in Supabase `tat_legs` |
| `src/lib/supabase-rest.ts` | `sbSelect` / `sbInsert` / `sbUpsert` / `sbDelete` — PostgREST over `fetch`, service-role, SERVER ONLY. No SDK dependency by design |

### Key Types (`src/lib/types.ts`)

- `Mapping` — customer→driver config row from Google Sheet (includes `smart_driver_id[]`, shift times, Zalo tokens, `alt_drop_off_id`, `dropoff_id`)
- `Job` / `Stop` — Cartrack delivery job with stops (stop_type_id 1=pickup, 2=dropoff, 3=delivery)
- `Driver` — Cartrack driver with GPS coords and status
- `LogEntry` — `{ ts, level: "OK"|"INFO"|"WARN"|"ERROR", msg }`

### Timezone

All business logic uses `Asia/Ho_Chi_Minh` (UTC+7). Cartrack timestamps arrive without timezone suffix and are treated as UTC+7.

## Known Footguns

These are the things most likely to burn a future agent working on this codebase.

1. **`job_status_id` and assignment can disagree — trust `delivery_driver_id`.** Cartrack can return status `4 (Assigned)` with `delivery_driver_id` null; it can also return status `2` with a `delivery_driver_id` already set (e.g. after a *manual* assignment the list lags at status 2). So a job is assigned iff `delivery_driver_id` is set, regardless of status — the cycle's status-2/4 partition checks this, otherwise a manually-assigned job gets re-flagged (NO MAPPING, etc.) every cycle.

2. **Fetch jobs by `scheduled_delivery_ts`, not `create_ts`.** The cycle fetches today's jobs with `getJobsByDate` (all statuses, one call) / `getJobsByStatusAndDate`, both filtered on `scheduled_delivery_ts` — so multi-day parked jobs released from the proxy driver surface on their scheduled day. A `create_ts` filter (the old `getUnassignedJobs` approach, now removed) is fine for ad-hoc jobs but silently drops scheduled/planned ones; don't reintroduce it.

3. **`loadConfigFromSheets` has an in-memory cache.** It only re-fetches the sheet after `invalidateConfigCache()` is called (dashboard Refresh button). If the sheet fetch ever returns suspiciously few rows (network hiccup), the bad result gets cached and all subsequent cycles see an empty mapping — causing widespread NO MAPPING errors until the server restarts or Refresh is clicked.

   **Every reader now declares the columns it cannot work without** (`SHEET_CONTRACT`
   in `sheets.ts`). A tab missing one is refused, the last good copy keeps serving, and
   the tab is named in the dashboard's "Cần xử lý" tab. This catches a hand-edited
   column, an HTML error page served with a 200, and the by-name lookup being answered
   with the WRONG TAB — that endpoint returns the *first tab in the workbook* for an
   unknown name, which here is the ~1,700-row mapping table and parses perfectly.

   **Never add a column to a contract without checking the live header row first.**
   Requiring one that isn't there refuses the tab on every load, and the engine then
   runs on a stale copy indefinitely with only the alarm to show for it. Run
   `npx tsx scripts/sheet-contract-live.mts` — it drives every real reader against the
   live workbook and fails if any tab is refused. `scripts/sheet-contract.test.mts`
   pins the logic offline.

   **A NEW column goes in `expect`, not `require`.** `require` cannot express a
   column that is arriving: it starts life absent, so requiring it refuses the tab
   from the moment the code ships until someone adds it by hand. Declaring nothing
   has the opposite failure — the column later vanishes, every row reads blank, the
   feature quietly reverts to its default and nothing says so. `expect` is the
   middle: read it, default it, and put a line on the dashboard when the sheet and
   the code disagree. Promote to `require` once it is on every tab that needs it
   AND carrying data. `npx tsx scripts/config-audit-live.mts` prints exactly that
   for every declared column, so promotion is a look rather than a guess.

   **A failed lookup is not always blank.** Some cells come back with the words
   `KHÔNG TÌM THẤY` in them, which pass any truthiness test — the same trap as an
   `#N/A` leave row. Test ids with `isValidDriverId`, never `if (id)`. Note that on
   a SMART row this is normal and harmless: the name cell holds several drivers, so
   the fixed-driver lookup is expected to fail, and ~218 rows look like that today.
   Only a row with no smart fallback is actually broken.

4. **`CARTRACK_WEB_PASS` is required for JSON-RPC calls** (`getFleetwebCookie`). Without it, route optimisation and duplicate-rejection both fail silently at login.

5. **Duplicate detection exempts PSC tỉnh jobs by design.** The exempt label list lives in `DUPLICATE_EXEMPT_LABELS` at the top of `assign.ts`. The label string itself is `PSC_TINH_LABEL` exported from `psc-config.ts` — change it in one place.

6. **Recurring per-job assign failures are dropped from the live log on purpose.** `NO DRIVER ON DUTY`, `NO MAPPING`, `CLASH`/`SUB CLASH`, on-leave-no-sub, `invalid driver_id`, and the smart `SMART skipped`/`on-break or unavailable` lines would re-print every cycle for the same stuck job, so `shouldStore` (via `LOG_DROP_PATTERNS` in `smart-log-kv.ts`) filters them out of the rolling run log. Instead each cycle writes a **snapshot** of these via `setFailedJobs` (key `assign:failed_jobs`), surfaced in the dashboard's **"Cần xử lý"** tab. If you add a new recurring failure reason, push it to `failedJobs` in `assign.ts` *and* add its string to `LOG_DROP_PATTERNS` — otherwise it will spam the live log again. One-off action errors (`SMART failed`, `Job failed`) are intentionally *not* dropped.

7. **Driver TAT measures LEGS, not jobs.** A leg is the ride between two consecutive
   stops on a driver's route, cut from the order they *actually* worked (stops sorted by
   completion time). A job's pickup→dropoff pair is NOT a leg — a driver collecting at
   three clinics before the lab run rides three legs, and the job-shaped view would
   invent trips starting where they had already left. `distance_km` / `target_mins` are
   frozen onto each row at archive time, so retuning `MINS_PER_KM` never rewrites
   history.

   **`tat_mins` is the FAIR clock, not raw elapsed.** It starts at the later of leaving
   the last stop and the next job becoming available, so time before the job existed is
   not charged to the driver — `idle_mins` records what was taken off, and
   `tat_mins + idle_mins` is the raw span. Without it the report ran backwards: two
   thirds of all flagged waits were simply "the job did not exist yet", and the quieter
   the day the worse a driver scored. Changing the rule requires re-archiving, because
   the clock is frozen onto the row like the distance. See `docs/driver-tat.md`.

8. **TAT archiving rides the assign cron — do NOT add a schedule for it.** `/api/assign/cron`
   calls `archiveSealedDays()` in `after()`, *before* the arm check so it still fires on
   the overnight "disarmed" pings (the cheapest moment of the day, and the day is
   genuinely finished by then). A Redis seal key makes it a no-op on every other ping;
   it walks back 3 days oldest-first, one day per ping, releasing the seal on failure so
   the next ping retries. Today is NOT its job — `/api/tat/me` refreshes today on demand.
   Adding a cron-job.org entry for `/api/tat/archive` would just duplicate day-fetches.
   Gate logic is covered by `scripts/tat-seal.test.mts`.

9. **A driver is ranked from where they have BEEN, never from where they are due.**
   Distance from one anchor point is the ranking's primary key, so an anchor that is
   only scheduled competes as hard fact. The rule is scoped to **Cartrack plans**, which
   lay a driver's whole day out in advance: an untouched stop of a PLAN job does not
   anchor them. A stop of a plan job already under way still does (a collected pickup
   with the lab run open — they are committed to going), and so does every **ad-hoc**
   stop, planned-looking or not: someone dispatched that job to this driver on purpose.
   Where the anchor is dropped — and for the `start_location` of a driver with no route
   at all — re-anchor onto the best truth available: live GPS → the last stop we know
   they stood on → `start_location` → (nothing better) leave it.
   The route-state LABEL never moves with the anchor: position and availability
   are separate questions, and shifting a mid-route driver into the `Available`
   band would quietly promote them past everyone at an equal-distance tie — which
   is common, since drivers pile up at the same PSC on 0 km.

   Why: on 27/08 a route-free driver whose `start_location` IS the pickup scored 0 km
   road and won the Start-Location priority band, while his own GPS put him 6.3 km away
   — the driver standing on the pickup came second. Same day, 16 of 17 drivers anchored
   on a not-yet-started next stop were still sitting on their last completed one, up to
   14 km from the anchor they were scored against — though only half of those anchors
   carry a plan marker, so only half are re-anchored. `scripts/unstarted-anchor.test.mts`
   pins the rule offline; `scripts/_replay.mts` (untracked) diffs old vs new anchors
   against a live day.

10. **A stop note holds a job unless the sentence is on the measured safe-list.** The gate
    used to have exactly one exemption, the literal `"Call before delivery"`, copy-pasted
    into four places. It is now one predicate in `job-filters.ts` (`isBlockingNote` /
    `blockingNotes`) over two sets: `ALWAYS_NON_BLOCKING` (that one old sentence, exempt at
    every hour, because evening jobs relied on it) and `DAYTIME_NON_BLOCKING` (sentences
    measured harmless).

    **Matching is WHOLE-NOTE and exact** after normalization (case, spacing, trailing
    punctuation, ✅ stripped — accents deliberately KEPT). A listed sentence *inside* a
    longer note must never release: the surrounding words are the instruction. A job is
    released only when EVERY note on it is listed.

    **The list is clock-guarded at 19:30** (`NOTE_RELEASE_CUTOFF_MIN`). Bookings after that
    are pushed to the next day by hand because shifts have ended — nothing in the engine
    enforced it before this, and without the guard a released 8pm job would be offered to a
    driver who has gone home. Callers that only DISPLAY or stamp a note (the "Cần xử lý"
    route) pass no `now` and so see the gate exactly as it was.

    **Never seed the list by eye.** `scripts/note-scan.mts` reads N days of history and
    scores each sentence on two signals — the ✅ that "Giao ngay" stamps (approved as-is)
    versus the job ending with a pickup window (rescheduled) — counting evening bookings
    SEPARATELY and excluding them from the verdict, or every sentence common on evening
    bookings is condemned for the hour rather than the words. `scripts/note-simulate.mts`
    prices a chosen list against the same days: coverage is NOT the sum of the appearance
    counts, because a job releases only when all of its notes are listed. The trap the
    counts hide is a note carrying a TIME ("19h", "lấy mẫu trước 5 giờ") — never
    rescheduled, therefore a clean candidate, and genuinely an instruction.
    `scripts/note-whitelist.test.mts` pins all of the above offline.

    **The list grows itself, but never promotes itself.** Every "Giao ngay" credits
    each of that job's sentences one CONSECUTIVE approval; every "Hẹn giờ" zeroes the
    run and records a reschedule ("Chọn tài xế" counts for neither — naming a driver by
    hand may mean the note *requires* that driver). At three clean approvals the
    sentence is OFFERED in "Cần xử lý" and a click accepts it; the engine reads accepted
    sentences and unions them with the code list each cycle. Auto-promotion was
    considered and rejected on evidence: the same automatic test that produced the seed
    list also proposed "19h" and "lấy mẫu trước 5 giờ giúp e ạ" — and promotion severs
    its own feedback, since a listed sentence's jobs never reach the review panel again,
    so no reschedule can ever demote it. Acceptance is the last moment a human reads it.

    **Do not move the accepted-list read onto the per-cycle path.** It is behind a
    10-minute in-process TTL for the reason the command-budget header in `smart-log-kv.ts`
    gives; the list changes once or twice a month, so a stale copy costs nothing but a
    cycle's delay.

See `docs/business-rules.md` for deeper detail, `docs/cartrack-api.md` for API reference,
and `docs/driver-tat.md` for the TAT module.

## CI/CD

### Standard deploy — just push to `master`

```bash
# From repo root:
git add <files>
git commit -m "..."
git push origin master
```

The **GitHub→Vercel integration auto-deploys `master` to production** within ~2 minutes of the push. That push is the whole deploy — do not also run `./deploy.sh`, or you get two redundant builds of the same commit (one CLI `>_`, one git `-o-`). Always run `npm run build` from `dashboard/` before pushing (Vercel runs the same build).

**`./deploy.sh` is a fallback only** — use it if the GitHub integration is ever disabled or stalls. It enforces a clean tree in sync with `origin/master`, then runs `npx vercel --prod` from the repo root. **Never run `npx vercel --prod` directly** (especially from `dashboard/`, which has no `.vercel/` link — the CLI would create an orphan project instead of deploying to `diag-logistics`). The correct `.vercel/project.json` (`prj_DQHaXcRc31jOI58J7NU8cNK1iO4C` / `diag-logistics`) lives at the repo root.

Production URL: **https://diag-logistics.vercel.app** (also aliased as `https://auto-assign-opal.vercel.app`).

One GitHub Actions workflow exists: `.github/workflows/kiotviet-daily-report.yml`,
`workflow_dispatch`-only (manual run + `dry_run` toggle, no `schedule:`). The actual
16:00 Asia/Ho_Chi_Minh trigger is a **cron-job.org** ping at `GET
/api/zalo/daily-report` — same mechanism as the `/api/assign/cron` engine, chosen
because GitHub's own `schedule:` trigger is best-effort and was observed firing
~85 minutes late. Keep the schedule in exactly one place (cron-job.org) or the
report goes out twice; do not re-add `schedule:` to the workflow file.

## Google Sheet

Sheet ID and GIDs are hardcoded in `src/lib/sheets.ts` (`SHEET_GID` enum). Both `config.ts` and `psc-config.ts` import from there. The mapping sheet (GID 0) has columns: `customer_id`, `driver_id`, `smart_driver_id` (comma-separated UUIDs), `first_name_last_name`, `shift_start`, `shift_end`, `bot_token`, `chat_id`, `alt_drop_off_id`, `dropoff_id`.

`dropoff_id` scopes a row to ONE destination, so a branch can send to two places
under two drivers ("D014 → D001 is Nam, D014 → D007 is Hùng"). Blank = any
destination, which is what every pre-existing row is. Selection is
most-specific-wins and runs AFTER the shift filter: a destination row replaces the
branch's blank row for that destination (so the two never read as a CLASH), but an
off-shift destination row falls back to the blank row rather than blocking the job.
A branch whose rows all name other destinations fails as `NO_DROPOFF_RULE`, not
`NO MAPPING` — different problem, different fix. Do NOT confuse it with
`alt_drop_off_id`, which REWRITES a job's destination; `dropoff_id` only matches.
It is deliberately absent from `SHEET_CONTRACT` (see footgun 3), so the code is
safe to deploy before the column exists — every row simply reads blank.

### A gap and an overlap are the same fault, so both are to-dos

Two fixed rules covering one branch at the same minute fail the job as `CLASH`,
exactly as an uncovered hour fails it as `NO_DRIVER`. Overlaps used to be
reported only as a sentence in the sheet-alarm banner while gaps got an
actionable row; both are now rows in "Cần tạo config", and `A_OVERLAP` is
retracted rather than written (`emitConfigWarnings`).

The fix offered is the same one-boundary move a gap gets, through the same
`/api/config/stretch-rule`: the earlier rule hands over sooner, or the later one
starts later — or the row is removed outright via `/api/config/delete-row`, which
is what most same-driver pairs actually need.

That DELETES the sheet row. It blanked the value cells at first, on the reasoning
that a blank-pickup row is what `writeConfigRows` means by free space — which is
only true BELOW the table's last used row. `configTableBounds` puts
`firstFreeRow` after the LAST non-blank pickup, so a blank in the middle is
skipped over forever: the hole stayed and no capacity came back. Deleting a row
inside the id columns' spill is safe where WRITING into one is not — a literal
collapses the ARRAYFORMULA to `#REF!`, a deleted row just shrinks it — so row 2,
the anchor, is refused and the delete is followed by a read-back that would catch
a collapse loudly. Rows below shift up by one; every writer re-reads its row and
compares the branch first, so a stale number refuses rather than writes. `shrinkOptions` refuses a move that would **open a hole** — a rule
wholly inside another looks closable and is not, and trading a CLASH for a
five-hour gap is the worse outcome. Those rows say so and send you to the
full-day editor.

**The engine clashes on ROW COUNT, not on distinct drivers.** `getDriversOnDuty`
returns `clash` as soon as more than one row is on duty, whoever they name — so
one driver on two overlapping rows blocks the branch exactly like two people do.
The audit skipped those pairs as "redundant" until 2026-09-03, when a live CLASH
(Đặng Khắc Huy 07:00–19:00 against himself 15:15–19:30) had nothing beside it on
the dashboard. Refusing is right on the engine's side — two rows for one person
can differ in `alt_drop_off_id`, which REWRITES where the job goes — so this
reports rather than letting the engine pick.

Unlike a gap this needs no runtime record: an overlap is fully visible in the
sheet, so it is derived on every parse. That derivation needs SHEET ROWS, which
the cached `Mapping` deliberately does not carry — so `overlaps` is cached in the
L2 blob beside `gaps` and read back, never recomputed from the cached mappings.
`scripts/config-shift.test.mts` pins the arithmetic;
`npx tsx scripts/shift-overlap-live.mts` prints the live pairs and says how many
are fixable in one click.

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes_tool` or `query_graph_tool` instead of Grep
- **Understanding impact**: `get_impact_radius_tool` instead of manually tracing imports
- **Code review**: `detect_changes_tool` + `get_review_context_tool` instead of reading entire files
- **Finding relationships**: `query_graph_tool` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview_tool` + `list_communities_tool`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes_tool` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context_tool` | Need source snippets for review — token-efficient |
| `get_impact_radius_tool` | Understanding blast radius of a change |
| `get_affected_flows_tool` | Finding which execution paths are impacted |
| `query_graph_tool` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes_tool` | Finding functions/classes by name or keyword |
| `get_architecture_overview_tool` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes_tool` for code review.
3. Use `get_affected_flows_tool` to understand impact.
4. Use `query_graph_tool` pattern="tests_for" to check coverage.
