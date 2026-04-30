# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Fleet Auto-Assign** service for Cartrack (a Vietnamese fleet management platform). It automatically assigns unassigned delivery jobs to drivers based on customer–driver mappings stored in a Google Sheet.

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
CARTRACK_COOKIE=CTSID=...        # Optional: session cookie for JSONRPC calls
CARTRACK_AUTH_UAT=Basic ...      # UAT environment equivalent
CARTRACK_COOKIE_UAT=...
CARTRACK_REJECT_PROXY_DRIVER_ID= # Driver ID used to proxy-assign then reject duplicate jobs
GOONG_API_KEY=                   # Road distance API (goong.io); falls back to haversine if absent
ROUTE_OPTIMIZE_PILOT=            # Comma-separated driver IDs for route optimisation pilot
```

## Architecture

### Data Flow

1. **Config** is loaded on each assign cycle from a public Google Sheet (CSV export) via `src/lib/config.ts`. It maps `customer_id → driver_id` with optional shift windows and Zalo notification tokens.

2. **Dashboard UI** (`src/components/dashboard.tsx`) polls `POST /api/assign` every 30 seconds when running. Two modes:
   - **Smart mode**: calls `POST /api/assign` which handles all jobs
   - **Auto-Plan mode**: calls `POST /api/autoplan` (Cartrack's timeline planner) + `POST /api/assign?skipSmart=1` for fixed-driver jobs in parallel

3. **Assign cycle** (`src/lib/assign.ts → autoAssignCycle`):
   - Fetches unassigned jobs (status 2) from Cartrack REST API
   - Filters to jobs created within `job_max_age_minutes` (default 60)
   - Skips jobs with stop notes
   - Runs duplicate-detection: if an active route with the same pickup→dropoff pair exists today, proxy-assigns then JSONRPC-rejects the duplicate
   - For each job, chooses path:
     - **Smart path** (`smart_driver_id` populated): ranks candidates by GPS/start-location proximity using haversine + optional Goong road distance; assigns closest driver
     - **Fixed path** (`driver_id` populated): looks up shift schedule; assigns single on-duty driver or logs clash/no-driver

4. **Cartrack APIs** (`src/lib/cartrack.ts`):
   - REST: `https://fleetapi-vn.cartrack.com/rest/delivery` — jobs, drivers, assignment
   - JSONRPC: `https://fleetweb-vn.cartrack.com/jsonrpc/index.php` — timeline auto-plan, route optimisation, job rejection

5. **PSC Routes** (`src/lib/psc-config.ts`): separate Google Sheet for PSC sample-transport jobs (provincial routes). Has a 5-minute in-memory cache; invalidated by the dashboard Refresh button.

### API Routes

| Route | Purpose |
|---|---|
| `POST /api/assign` | Main assign cycle; `?env=prod\|uat`, `?skipSmart=1` |
| `POST /api/autoplan` | Cartrack timeline auto-planner for smart drivers |
| `GET /api/config` | Returns mapping/PSC route counts from sheets |
| `GET /api/drivers` | Proxy to Cartrack drivers list |
| `GET /api/jobs` | Proxy to Cartrack unassigned jobs |
| `POST /api/psc-assign` | PSC provincial route assignment |
| `GET /api/psc-routes` | Load PSC routes from sheet |
| `GET /api/psc-tinh` | Provincial PSC route lookup |
| `GET /api/smart-assign` | Smart-assign debug/status |
| `GET /api/audit` | Job audit log |
| `GET /api/cham-cong` | Attendance/check-in data |
| `GET /api/distance-checking` | Driver–pickup distance queries |
| `POST /api/geo/resolve` | Geocode/reverse-geocode via Goong |
| `POST /api/sales/create-trip` | Sales trip creation |
| `POST /api/sales/reject-job` | Sales job rejection |

### Key Types (`src/lib/types.ts`)

- `Mapping` — customer→driver config row from Google Sheet (includes `smart_driver_id[]`, shift times, Zalo tokens, `alt_drop_off_id`)
- `Job` / `Stop` — Cartrack delivery job with stops (stop_type_id 1=pickup, 2=dropoff)
- `Driver` — Cartrack driver with GPS coords and status
- `LogEntry` — `{ ts, level: "OK"|"INFO"|"WARN"|"ERROR", msg }`

### Timezone

All business logic uses `Asia/Ho_Chi_Minh` (UTC+7). Cartrack timestamps arrive without timezone suffix and are treated as UTC+7.

## CI/CD

Deployment is handled automatically by Vercel on push to `master`. There are no active GitHub Actions workflows.

## Google Sheet

Sheet ID is hardcoded in `src/lib/config.ts` and `src/lib/psc-config.ts`. The mapping sheet (GID 0) has columns: `customer_id`, `driver_id`, `smart_driver_id` (comma-separated UUIDs), `first_name_last_name`, `shift_start`, `shift_end`, `bot_token`, `chat_id`, `alt_drop_off_id`.
