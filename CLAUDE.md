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
```

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
| `POST /api/sales/reject-job` | Rejects a sales job by reference number via JSON-RPC (guards against started jobs) |
| `GET /api/sales/search-trips` | Searches today's B2B trips by `?ma_kh=` (matches reference_number suffix); returns status 2+4 jobs only |

### Shared Libraries

| Module | Exports |
|---|---|
| `src/lib/cartrack.ts` | `BASE_URL`, `JSONRPC_URL`, `getHeaders`, all Cartrack REST/JSONRPC wrappers |
| `src/lib/labcenter.ts` | `getAdminToken` / `getReceptionistToken` (cached JWT logins — admin for `spc-delivery`, receptionist for `spc-pos`), `listLocationsByClientCode`, `getCartrackCustomerId`, `updateLocationPhone` |
| `src/lib/distance.ts` | `haversineKm`, `goongDistanceKm` (1→1), `goongMatrix` (1→N batch), `goongMatrixMultiOrigin` (N→1, one request — undocumented-but-verified Goong behavior, shape-checked with null-fill fallback) |
| `src/lib/distance-cache.ts` | `roadDistancesToPoint` (N→1), `roadDistancesFromPoint` (1→N) — resolve pairs cheapest-first: self-pair = 0 km free, then 40-day Redis cache (`dist:v1:` keys **truncated to 5 dp** — read, don't round, mirrors Excel `TRUNC`; value `{distance_km, eta_mins, from, to}` keeps the exact coords), then ONE matrix call for misses (write-behind; nulls never cached). Each result carries `source: "self"\|"cache"\|"api"`. `exportCachedDistances()` dumps all pairs (read-only SCAN+MGET) for download |
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

1. **`job_status_id` and assignment can disagree — trust `delivery_driver_id`.** Cartrack can return status `4 (Assigned)` with `delivery_driver_id` null; it can also return status `2` with a `delivery_driver_id` already set (e.g. after a *manual* assignment the list lags at status 2). So a job is assigned iff `delivery_driver_id` is set, regardless of status — the cycle's status-2/4 partition checks this, otherwise a manually-assigned job gets re-flagged (NO MAPPING, etc.) every cycle.

2. **Fetch jobs by `scheduled_delivery_ts`, not `create_ts`.** The cycle fetches today's jobs with `getJobsByDate` (all statuses, one call) / `getJobsByStatusAndDate`, both filtered on `scheduled_delivery_ts` — so multi-day parked jobs released from the proxy driver surface on their scheduled day. A `create_ts` filter (the old `getUnassignedJobs` approach, now removed) is fine for ad-hoc jobs but silently drops scheduled/planned ones; don't reintroduce it.

3. **`loadConfigFromSheets` has an in-memory cache.** It only re-fetches the sheet after `invalidateConfigCache()` is called (dashboard Refresh button). If the sheet fetch ever returns suspiciously few rows (network hiccup), the bad result gets cached and all subsequent cycles see an empty mapping — causing widespread NO MAPPING errors until the server restarts or Refresh is clicked.

4. **`CARTRACK_WEB_PASS` is required for JSON-RPC calls** (`getFleetwebCookie`). Without it, route optimisation and duplicate-rejection both fail silently at login.

5. **Duplicate detection exempts PSC tỉnh jobs by design.** The exempt label list lives in `DUPLICATE_EXEMPT_LABELS` at the top of `assign.ts`. The label string itself is `PSC_TINH_LABEL` exported from `psc-config.ts` — change it in one place.

6. **Recurring per-job assign failures are dropped from the live log on purpose.** `NO DRIVER ON DUTY`, `NO MAPPING`, `CLASH`/`SUB CLASH`, on-leave-no-sub, `invalid driver_id`, and the smart `SMART skipped`/`on-break or unavailable` lines would re-print every cycle for the same stuck job, so `shouldStore` (via `LOG_DROP_PATTERNS` in `smart-log-kv.ts`) filters them out of the rolling run log. Instead each cycle writes a **snapshot** of these via `setFailedJobs` (key `assign:failed_jobs`), surfaced in the dashboard's **"Cần xử lý"** tab. If you add a new recurring failure reason, push it to `failedJobs` in `assign.ts` *and* add its string to `LOG_DROP_PATTERNS` — otherwise it will spam the live log again. One-off action errors (`SMART failed`, `Job failed`) are intentionally *not* dropped.

See `docs/business-rules.md` for deeper detail and `docs/cartrack-api.md` for API reference.

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

There are no active GitHub Actions workflows.

## Google Sheet

Sheet ID and GIDs are hardcoded in `src/lib/sheets.ts` (`SHEET_GID` enum). Both `config.ts` and `psc-config.ts` import from there. The mapping sheet (GID 0) has columns: `customer_id`, `driver_id`, `smart_driver_id` (comma-separated UUIDs), `first_name_last_name`, `shift_start`, `shift_end`, `bot_token`, `chat_id`, `alt_drop_off_id`.
