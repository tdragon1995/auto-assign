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

No test suite exists currently.

## Environment Variables

Copy `dashboard/.env.example` to `dashboard/.env.local`:

```
CARTRACK_AUTH=Basic ...           # Required: Cartrack REST API auth header
CARTRACK_COOKIE=CTSID=...        # Optional: session cookie for REST calls
CARTRACK_AUTH_UAT=Basic ...      # UAT environment equivalent
CARTRACK_COOKIE_UAT=...
CARTRACK_WEB_PASS=               # Required for JSON-RPC (autoplan, route optimise, duplicate rejection)
CARTRACK_REJECT_PROXY_DRIVER_ID= # Driver UUID used to proxy-assign then reject duplicate jobs
CARTRACK_QUEUE_PROXY_DRIVER_ID=  # Driver UUID used to park scheduled/planned jobs until 30 min before window end
GOONG_API_KEY=                   # Road distance API (goong.io); falls back to haversine if absent
ROUTE_OPTIMIZE_PILOT=            # Comma-separated driver UUIDs for route optimisation pilot
LABCENTER_EMAIL=                 # Labcenter API login (used by /api/customers POST to sync pick/drop locations)
LABCENTER_PASSWORD=              # Labcenter API password
```

## Architecture

### Data Flow

1. **Config** is loaded on each assign cycle from a public Google Sheet (CSV export) via `src/lib/config.ts`. It maps `customer_id → driver_id` with optional shift windows and Zalo notification tokens.

2. **Dashboard UI** (`src/components/dashboard.tsx`) polls `POST /api/assign` every 30 seconds when running. Two modes:
   - **Smart mode**: calls `POST /api/assign` which handles all jobs
   - **Auto-Plan mode**: calls `POST /api/autoplan` which runs Cartrack's timeline planner for smart drivers then fixed-driver assignment in the same request

3. **Assign cycle** (`src/lib/assign.ts → autoAssignCycle`):
   - Fetches three job sources in parallel:
     - status=2 (unassigned) — covers ASAP and scheduled jobs
     - status=4 with null `delivery_driver_id`, filtered by today's `scheduled_delivery_ts` — Cartrack "planned" jobs from recurring plans
     - jobs currently assigned to `CARTRACK_QUEUE_PROXY_DRIVER_ID` — previously parked scheduled/planned jobs
   - Classifies each job (`classifyJob`) as **ASAP** (no `delivery_windows`), **scheduled** (status=2 + window), **planned** (status=4 + null driver + window), or **parked** (already on the queue proxy).
   - Skips jobs with stop notes
   - Runs duplicate-detection: if an active route with the same pickup→dropoff pair exists today, proxy-assigns then JSONRPC-rejects the duplicate
   - Time gate per kind:
     - ASAP → `create_ts` within `job_max_age_minutes` (default 60)
     - Scheduled / planned / parked → `getOperationalTime` = `pickup.delivery_windows[0].time_to − 30 min`
   - When a scheduled/planned job is not yet eligible, the cycle parks it on `CARTRACK_QUEUE_PROXY_DRIVER_ID` and surfaces it in the response's `queued` array (rendered in a dashboard panel). At eligibility time, the standard assign overwrites the proxy assignment.
   - For each eligible job, chooses path:
     - **Smart path** (`smart_driver_id` populated): ranks candidates by GPS/start-location proximity using haversine + optional Goong road distance; assigns closest driver
     - **Fixed path** (`driver_id` populated): looks up shift schedule; assigns single on-duty driver or logs clash/no-driver

4. **Cartrack APIs** (`src/lib/cartrack.ts`):
   - REST: `https://fleetapi-vn.cartrack.com/rest/delivery` — jobs, drivers, assignment, customers creation
   - JSONRPC: `https://fleetweb-vn.cartrack.com/jsonrpc/index.php` — timeline, auto-plan, route optimisation, job rejection

5. **PSC Routes** (`src/lib/psc-config.ts`): separate Google Sheet for PSC sample-transport jobs (provincial routes). Has a 5-minute in-memory cache; invalidated by the dashboard Refresh button.

### API Routes

| Route | Purpose |
|---|---|
| `POST /api/assign` | Main assign cycle; `?env=prod\|uat`, `?skipSmart=1`. Returns `{ logs, queued }` — `queued` is the snapshot of scheduled/planned jobs parked on the queue proxy. |
| `POST /api/autoplan` | Cartrack timeline auto-planner for smart drivers + fixed-driver assignment |
| `GET /api/config` | Returns mapping/PSC route counts from sheets |
| `GET /api/drivers` | Proxy to Cartrack drivers list |
| `GET /api/jobs` | Proxy to Cartrack unassigned jobs |
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
| `POST /api/sales/create-trip` | Creates a B2B sample-transport job (`🛵 Vận chuyển mẫu B2B`) and assigns it |
| `POST /api/sales/reject-job` | Rejects a sales job by reference number via JSON-RPC (guards against started jobs) |

### Shared Libraries

| Module | Exports |
|---|---|
| `src/lib/cartrack.ts` | `BASE_URL`, `JSONRPC_URL`, `getHeaders`, all Cartrack REST/JSONRPC wrappers |
| `src/lib/distance.ts` | `haversineKm`, `goongDistanceKm` (1→1), `goongMatrix` (1→N batch) |
| `src/lib/job-filters.ts` | `JOB_STATUS`, `STOP_STATUS` maps; `isActiveStop`, `isCompletedOrRejectedStop`, `isStopStarted` |
| `src/lib/smart-rank.ts` | `RefStop`, `RefLabel`, `GPS_FRESH_MS`, `selectReferenceStop`, `computeStopStats`, `rankingComparator` |
| `src/lib/time.ts` | `vnDate`, `vnTimestamp`, `vnHoursMinutes`, `vnMinutesSinceMidnight`, `vnDayWindow`, `parseVnTimestamp` |

### Key Types (`src/lib/types.ts`)

- `Mapping` — customer→driver config row from Google Sheet (includes `smart_driver_id[]`, shift times, Zalo tokens, `alt_drop_off_id`)
- `Job` / `Stop` — Cartrack delivery job with stops (stop_type_id 1=pickup, 2=dropoff, 3=delivery)
- `Driver` — Cartrack driver with GPS coords and status
- `LogEntry` — `{ ts, level: "OK"|"INFO"|"WARN"|"ERROR", msg }`
- `QueuedJob` — `{ job_id, customer_id, customer_name, kind: "scheduled"|"planned", eligible_at, parked_on_proxy }`; returned alongside `logs` from the assign cycle

### Timezone

All business logic uses `Asia/Ho_Chi_Minh` (UTC+7). Cartrack timestamps arrive without timezone suffix and are treated as UTC+7.

## Known Footguns

These are the things most likely to burn a future agent working on this codebase.

1. **`job_status_id=4` does not mean a driver is assigned.** Cartrack can return a job with status `4 (Assigned)` while `delivery_driver_id` and `assigned_ts` are both `null`. Always check `delivery_driver_id` directly, not just status.

2. **`getUnassignedJobs` has no time filter.** It only filters by `job_status_id=2` and returns both ASAP and scheduled jobs. The assign cycle splits them locally: ASAP is gated by `create_ts` recency, scheduled by `getOperationalTime`. Don't add a `create_ts_from/to` filter at source — it would silently drop scheduled jobs whose plan was created earlier than today. For status=4 planned jobs, use the dedicated `getStatus4UnassignedScheduled` helper which is bounded by `scheduled_delivery_ts`.

   **Asymmetry to remember:** scheduled jobs at status=2 are *not* server-bounded in time, so a job scheduled for next Tuesday lands in today's response and gets parked on the queue proxy now. This is intentional — parking is idempotent (the next cycle classifies it as `parked` and skips re-assigning) — but it does mean the queue panel and the proxy driver's job list grow with all future-scheduled work.

3. **`loadConfigFromSheets` is intentionally uncached.** The assign cycle runs every 30 s and must see fresh sheet edits immediately. Do not add a cache without also wiring a refresh path.

4. **`CARTRACK_WEB_PASS` is required for JSON-RPC calls** (`getFleetwebCookie`). Without it, `autoplan`, route optimisation, and duplicate-rejection all fail silently at login.

5. **Duplicate detection exempts PSC tỉnh jobs by design.** The exempt label list lives in `DUPLICATE_EXEMPT_LABELS` at the top of `assign.ts`. The label string itself is `PSC_TINH_LABEL` exported from `psc-config.ts` — change it in one place.

6. **Two distinct proxy drivers.** `CARTRACK_REJECT_PROXY_DRIVER_ID` is used to land a duplicate job before JSON-RPC rejecting it. `CARTRACK_QUEUE_PROXY_DRIVER_ID` is used to **park** scheduled/planned jobs that aren't yet eligible. Don't reuse one for the other — the queue proxy's job list is read every cycle to detect already-parked jobs, so parking duplicate-rejection traffic on it would corrupt the queue.

7. **`getOperationalTime` reads pickup `delivery_windows[0].time_to`.** That field is a time-of-day string like `"15:00:00+07:00"`, not a full timestamp. The helper combines it with the date portion of `scheduled_delivery_ts` (or today's VN date as fallback) and subtracts 30 minutes. If Cartrack ever returns multi-window pickups, only the first window is honoured.

See `docs/business-rules.md` for deeper detail and `docs/cartrack-api.md` for API reference.

## CI/CD

Deployment is handled automatically by Vercel on push to `master`. There are no active GitHub Actions workflows.

## Google Sheet

Sheet ID and GIDs are hardcoded in `src/lib/sheets.ts` (`SHEET_GID` enum). Both `config.ts` and `psc-config.ts` import from there. The mapping sheet (GID 0) has columns: `customer_id`, `driver_id`, `smart_driver_id` (comma-separated UUIDs), `first_name_last_name`, `shift_start`, `shift_end`, `bot_token`, `chat_id`, `alt_drop_off_id`.
