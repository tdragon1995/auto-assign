# Business Rules

Non-obvious logic in the assign engine. Start here when debugging a missed or wrong assignment.

## Assign cycle overview

Entry point: `autoAssignCycle()` in `dashboard/src/lib/assign.ts`  
Trigger: `POST /api/assign`, called by the dashboard every 30 s.

```
fetch in parallel:
  – status=2 unassigned         (ASAP + scheduled, no server time filter)
  – status=4 + null driver      (planned, filtered by today's scheduled_delivery_ts)
  – jobs on CARTRACK_QUEUE_PROXY_DRIVER_ID  (already-parked scheduled/planned)
merge by job_id (last-write-wins so parked snapshot is fresh)
  → classifyJob: asap | scheduled | planned | parked
  → ASAP-only: drop if create_ts older than job_max_age_minutes (default 60)
  → drop jobs with stop notes
  → run duplicate check → proxy-assign + reject duplicates
  → for each remaining job:
      ASAP                          → assign now using create_ts as job time
      scheduled / planned / parked  → if now < operational time → park on queue proxy + queued[]
                                      else                      → assign now using operational time as job time
      smart_driver_id populated?    → smart path
      driver_id populated?          → fixed path
      neither?                      → skip (no mapping)
```

**Operational time** = `pickup.delivery_windows[0].time_to − 30 min`, computed by `getOperationalTime`. ASAP jobs have no `delivery_windows` and skip this gate entirely.

**Queue proxy.** Set `CARTRACK_QUEUE_PROXY_DRIVER_ID` to a dedicated driver UUID. Scheduled and planned jobs are assigned to that driver as a parking lot until their operational time arrives, then the regular `assignJob` overwrites the proxy assignment with the real driver. The cycle returns the parked-job snapshot in `{ logs, queued }` and the dashboard renders it under the activity log.

**Status=4 with null driver is a real state.** Cartrack returns recurring "planned" jobs at `job_status_id=4` with `delivery_driver_id=null` and `assigned_ts=null`. They were invisible to the old cycle and are now picked up by `getStatus4UnassignedScheduled`.

## Fixed-driver path

1. Find pickup stop (`stop_type_id === 1`) → look up `customer_id` in the sheet mapping.
2. If `alt_drop_off_id` is set on the mapping, call `PUT /jobs/{jobId}` to swap the dropoff customer **before** assignment.
3. Derive job time: ASAP jobs use `create_ts`; scheduled/planned/parked jobs use `getOperationalTime` (pickup window − 30 min). Both are treated as UTC+7.
4. Check shift window: if `shift_start`/`shift_end` are set on the mapping, skip if current time is outside the window.
5. Assign via `PUT /jobs/assign/{driverUUID}` — always the driver UUID, never a display name.
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

### Auto-assign (`POST /api/assign`)

Before assigning any job, `buildActiveRouteMap()` fetches all assigned jobs (`status=4`) for today and builds a set of active pickup→dropoff pairs (keyed as `pickupCustomerId:dropoffCustomerId`).

A new job is a **duplicate** when:
- The same pickup→dropoff pair is already active, AND
- The pickup stop on the existing job is not yet completed/rejected (`stopStatusId` not in `{4, 5}`), AND
- The pickup window does not start more than 60 minutes in the future.

When a duplicate is detected:
1. Proxy-assign it to `CARTRACK_REJECT_PROXY_DRIVER_ID`.
2. Reject it via `delivery_reject_job` JSON-RPC with a Vietnamese reason string.

**PSC tỉnh jobs are exempt.** Jobs carrying the label `🛵 Vận chuyển mẫu tỉnh` are skipped in the duplicate-blocking path entirely.

### PSC-assign (`POST /api/psc-assign`)

Duplicate detection runs **before the job is created** — there is no proxy-assign/reject step.

Two layers:

1. **In-memory lock** (`creationLock` in `psc-assign/route.ts`): keyed on `${pickup}-${dropoff}-${today}`, TTL 15 s. Guards against race conditions when two browser tabs submit within seconds of each other. Returns 409 immediately if the lock is held.

2. **Cartrack API check**: fetches both unassigned (`status=2`) and assigned (`status=4`) jobs for today, then blocks if any existing job has:
   - A pickup stop (`stop_type_id === 1`) matching `customer_id === pickup` with an active status (`stopStatusId` in `{1 Created, 2 En Route, 3 Arrived}`), AND
   - A dropoff stop (`stop_type_id === 2`) matching `customer_id === dropoff`.
   - Cancelled (`status=7`) and rejected (`status=3`) jobs are excluded.

   Returns 409 with a Vietnamese error message; the job is never created.

Unlike auto-assign, PSC-assign has no 60-minute window guard — any active same-route job today blocks the request regardless of its scheduled time.

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

Sheet ID and GIDs are hardcoded in `dashboard/src/lib/sheets.ts`, which also owns `parseCSV` and `fetchSheetRows(gid)`. Both `config.ts` and `psc-config.ts` import from there — do not add another CSV parser.

`config.ts` (`loadConfigFromSheets`) is intentionally uncached — the 30 s assign cycle must see fresh edits. `psc-config.ts` caches for 5 minutes and is invalidated by the dashboard Refresh button.

## Time helpers

All Saigon time operations go through `dashboard/src/lib/time.ts`:

| Export | Returns | Use case |
|---|---|---|
| `vnDate(d?)` | `"YYYY-MM-DD"` | Today's date for API filters and route windows |
| `vnTimestamp(d?)` | `"YYYY-MM-DD HH:mm:ss"` | Log entry timestamps |
| `vnHoursMinutes(d?)` | `{hours, minutes}` | Shift window comparisons |
| `vnMinutesSinceMidnight(d?)` | `number` | Duplicate-window check |
| `parseVnTimestamp(ts)` | `Date` | Parse Cartrack's `create_ts` strings (appends `+07:00`) |
| `vnDayWindow(date?)` | `{from, to}` | JSON-RPC `filter` objects (`T00:00:00+07:00 / T23:59:59+07:00`) |

Do not use `Date.now() + 7*60*60*1000` or inline `Intl.DateTimeFormat` for timezone work — add a helper to `time.ts` if needed.
