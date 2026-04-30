# Business Rules

Non-obvious logic in the assign engine. Start here when debugging a missed or wrong assignment.

## Assign cycle overview

Entry point: `autoAssignCycle()` in `dashboard/src/lib/assign.ts`  
Trigger: `POST /api/assign`, called by the dashboard every 30 s.

```
fetch unassigned jobs (status 2)
  → drop jobs older than job_max_age_minutes (default 60)
  → drop jobs with stop notes
  → run duplicate check → proxy-assign + reject duplicates
  → for each remaining job:
      smart_driver_id populated? → smart path
      driver_id populated?       → fixed path
      neither?                   → skip (no mapping)
```

## Fixed-driver path

1. Find pickup stop (`stop_type_id === 1`) → look up `customer_id` in the sheet mapping.
2. If `alt_drop_off_id` is set on the mapping, call `PUT /jobs/{jobId}` to swap the dropoff customer **before** assignment.
3. Derive job time from `create_ts` (treated as UTC+7).
4. Check shift window: if `shift_start`/`shift_end` are set on the mapping, skip if current time is outside the window.
5. Assign via `PUT /jobs/assign/{driverId}`.
6. Fetch job details to get driver name, then send Zalo notification if `bot_token` + `chat_id` are set.
7. If `ROUTE_OPTIMIZE_PILOT` includes the driver, fire `delivery_route_stops_optimize`.

**`alt_drop_off_id` only runs on the fixed path.** Smart-assign never swaps the dropoff.

## Smart-assign path

Applies when `smart_driver_id` (array of UUIDs) is set on the mapping instead of a single `driver_id`.

Ranking logic (`dashboard/src/app/api/smart-assign/route.ts`):

1. Load candidate drivers from the smart_driver_id list.
2. For each candidate, find a reference location:
   - **Arrived** stop on current route (last one with `stopStatusId === 3`)
   - **En-route** stop (next pending on route)
   - **Next stop** (first unstarted)
   - **First stop** on route
   - **Start location** fallback: fetch customer coordinates for `start_location_customer_id`
   - **GPS** fallback: driver's live coordinates
3. Pre-rank by haversine distance from reference to pickup.
4. Re-rank top N by Goong road distance (motorbike, `rsapi.goong.io/v2/distancematrix`) if `GOONG_API_KEY` is set; otherwise haversine is final.
5. Tie-break by `lastCompletedTs` (more recent = less busy) then `jobsDone` (fewer = preferred).
6. Assign the top-ranked driver.

## Auto-Plan mode (dashboard toggle)

When the user enables Auto-Plan mode the dashboard fires two requests **in parallel**:

- `POST /api/autoplan` — delegates smart-driver jobs to Cartrack's own timeline planner (`delivery_timeline_route_list` + Cartrack's optimiser)
- `POST /api/assign?skipSmart=1` — runs only the fixed-driver path locally

This means smart jobs and fixed jobs have entirely different assignment owners in Auto-Plan mode.

## Duplicate detection

Before assigning any job, `buildActiveRouteMap()` fetches all assigned jobs (`status=4`) for today and builds a set of active pickup→dropoff pairs (keyed as `pickupCustomerId:dropoffCustomerId`).

A new job is a **duplicate** when:
- The same pickup→dropoff pair is already active, AND
- The pickup stop on the existing job is not yet completed/rejected (`stopStatusId` not in `{4, 5}`), AND
- The pickup window does not start more than 60 minutes in the future.

When a duplicate is detected:
1. Proxy-assign it to `CARTRACK_REJECT_PROXY_DRIVER_ID`.
2. Reject it via `delivery_reject_job` JSON-RPC with a Vietnamese reason string.

**PSC tỉnh jobs are exempt.** Jobs carrying the label `🛵 Vận chuyển mẫu tỉnh` are skipped in the duplicate-blocking path entirely.

## PSC provincial routes

Separate assignment flow: `POST /api/psc-assign`.  
Config from a separate sheet tab (GID `281585585`), cached 5 min, invalidated by the dashboard Refresh button.

PSC routes have their own pickup→driver mapping via `psc-config.ts:loadDriverMappings()` + `findDriverForPickup()`.

## Sheet config

Main mapping sheet (GID `0`) columns:

| Column | Purpose |
|---|---|
| `customer_id` | Cartrack pickup customer UUID |
| `driver_id` | Fixed driver UUID (empty for smart) |
| `smart_driver_id` | Comma-separated driver UUIDs for smart ranking |
| `first_name_last_name` | Display name for logs and Zalo messages |
| `shift_start` / `shift_end` | HH:MM window; empty = always on duty |
| `bot_token` / `chat_id` | Zalo notification credentials |
| `alt_drop_off_id` | If set, swap dropoff stop to this customer before assigning |

Sheet ID and GIDs are hardcoded in `dashboard/src/lib/sheets.ts`.

## Time helpers

Three independent implementations of "now in Saigon / today's VN date" exist across `assign.ts` and `autoplan/route.ts`. One uses a `Date.now() + 7*60*60*1000` UTC-offset pattern; others use `Intl.DateTimeFormat`. VN does not observe DST so both are correct in practice, but the offset pattern is fragile — prefer `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' })` for any new time code.
