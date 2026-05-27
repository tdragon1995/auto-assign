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
CARTRACK_WEB_PASS=               # Required for JSON-RPC (autoplan, route optimise, duplicate rejection)
CARTRACK_REJECT_PROXY_DRIVER_ID= # Driver UUID used to proxy-assign then reject duplicate jobs
GOONG_API_KEY=                   # Road distance API (goong.io); falls back to haversine if absent
ROUTE_OPTIMIZE_PILOT=            # Comma-separated driver UUIDs for route optimisation pilot
LABCENTER_EMAIL=                 # Labcenter API login (used by /api/customers POST to sync pick/drop locations)
LABCENTER_PASSWORD=              # Labcenter API password
LABCENTER_RECEPTIONIST_EMAIL=    # Separate receptionist account for /api/labcenter/client (client search in sales form)
LABCENTER_RECEPTIONIST_PASSWORD= # Password for receptionist account
```

## Architecture

### Data Flow

1. **Config** is loaded on each assign cycle from a public Google Sheet (CSV export) via `src/lib/config.ts`. It maps `customer_id → driver_id` with optional shift windows and Zalo notification tokens.

2. **Dashboard UI** (`src/components/dashboard.tsx`) polls `POST /api/assign` every 30 seconds when running. Two modes:
   - **Smart mode**: calls `POST /api/assign` which handles all jobs
   - **Auto-Plan mode**: calls `POST /api/autoplan` which runs Cartrack's timeline planner for smart drivers then fixed-driver assignment in the same request

3. **Assign cycle** (`src/lib/assign.ts → autoAssignCycle`):
   - Fetches unassigned jobs (status 2) from Cartrack REST API
   - Filters to jobs created within `job_max_age_minutes` (default 60)
   - Skips jobs with stop notes
   - Runs duplicate-detection: if an active route with the same pickup→dropoff pair exists today, proxy-assigns then JSONRPC-rejects the duplicate
   - For each job, chooses path:
     - **Smart path** (`smart_driver_id` populated): ranks candidates by GPS/start-location proximity using haversine + optional Goong road distance; assigns closest driver
     - **Fixed path** (`driver_id` populated): looks up shift schedule; assigns single on-duty driver or logs clash/no-driver

4. **Cartrack APIs** (`src/lib/cartrack.ts`):
   - REST: `https://fleetapi-vn.cartrack.com/rest/delivery` — jobs, drivers, assignment, customers creation
   - JSONRPC: `https://fleetweb-vn.cartrack.com/jsonrpc/index.php` — timeline, auto-plan, route optimisation, job rejection

5. **PSC Routes** (`src/lib/psc-config.ts`): separate Google Sheet for PSC sample-transport jobs (provincial routes). Has a 5-minute in-memory cache; invalidated by the dashboard Refresh button.

### API Routes

| Route | Purpose |
|---|---|
| `POST /api/assign` | Main assign cycle; `?env=prod\|uat`, `?skipSmart=1` |
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
| `GET /api/sales/job-status` | Looks up a single job's `job_status_id` by `?ref=reference_number`; used by the cancel tab to show live status |
| `GET /api/sales/search-trips` | Searches today's B2B trips by `?ma_kh=` (matches reference_number suffix); returns status 2+4 jobs only |

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

### Timezone

All business logic uses `Asia/Ho_Chi_Minh` (UTC+7). Cartrack timestamps arrive without timezone suffix and are treated as UTC+7.

## Known Footguns

These are the things most likely to burn a future agent working on this codebase.

1. **`job_status_id=4` does not mean a driver is assigned.** Cartrack can return a job with status `4 (Assigned)` while `delivery_driver_id` and `assigned_ts` are both `null`. Always check `delivery_driver_id` directly, not just status.

2. **`getUnassignedJobs` has no time filter.** It only filters by `job_status_id=2`; the assign cycle then drops old jobs locally by `create_ts`. This is correct for ad-hoc jobs but wrong for scheduled/planned jobs — use `scheduled_delivery_ts` filtering for those.

3. **`loadConfigFromSheets` has an in-memory cache.** It only re-fetches the sheet after `invalidateConfigCache()` is called (dashboard Refresh button). If the sheet fetch ever returns suspiciously few rows (network hiccup), the bad result gets cached and all subsequent cycles see an empty mapping — causing widespread NO MAPPING errors until the server restarts or Refresh is clicked.

4. **`CARTRACK_WEB_PASS` is required for JSON-RPC calls** (`getFleetwebCookie`). Without it, `autoplan`, route optimisation, and duplicate-rejection all fail silently at login.

5. **Duplicate detection exempts PSC tỉnh jobs by design.** The exempt label list lives in `DUPLICATE_EXEMPT_LABELS` at the top of `assign.ts`. The label string itself is `PSC_TINH_LABEL` exported from `psc-config.ts` — change it in one place.

See `docs/business-rules.md` for deeper detail and `docs/cartrack-api.md` for API reference.

## CI/CD

### Standard deploy — always use `./deploy.sh`

```bash
# From repo root:
git add <files>
git commit -m "..."
git push origin master
./deploy.sh
```

`deploy.sh` enforces that local is clean and in sync with `origin/master` before building and deploying. **Never run `npx vercel --prod` directly** — it uploads local files bypassing git, causing Vercel and git to silently diverge. Any subsequent deploy from another machine or GitHub integration will overwrite your untracked changes.

If GitHub integration deploys within ~2 minutes of the push, the `./deploy.sh` step is optional — but running it is always safe (it's idempotent).

**Important:** Never run `vercel --prod` from `dashboard/`. That subdirectory has no `.vercel/` link and the CLI will create a new orphan project instead of deploying to `diag-logistics`. The correct `.vercel/project.json` (pointing to `prj_DQHaXcRc31jOI58J7NU8cNK1iO4C` / `diag-logistics`) lives at the repo root.

Production URL: **https://diag-logistics.vercel.app** (also aliased as `https://auto-assign-opal.vercel.app`).

There are no active GitHub Actions workflows.

## Google Sheet

Sheet ID and GIDs are hardcoded in `src/lib/sheets.ts` (`SHEET_GID` enum). Both `config.ts` and `psc-config.ts` import from there. The mapping sheet (GID 0) has columns: `customer_id`, `driver_id`, `smart_driver_id` (comma-separated UUIDs), `first_name_last_name`, `shift_start`, `shift_end`, `bot_token`, `chat_id`, `alt_drop_off_id`.
