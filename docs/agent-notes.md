# Agent Notes — Fleet Auto-Assign

Persistent memory for AI agents working in this codebase. Captures non-obvious behaviour, known bugs, and "where to look first" pointers that are easy to miss in source code alone.

---

## Critical Footguns

### 1. Auth variable shadowing in smart-assign (assign.ts:419)

Inside `buildActiveRouteMap`, which is called during the smart-assign path, there is:

```ts
const auth = process.env.CARTRACK_AUTH ?? "";
```

This shadows the outer `auth` variable that was correctly derived with the env suffix (e.g. `CARTRACK_AUTH_UAT` when `?env=uat`). As a result, **smart-assign always hits the prod Cartrack JSON-RPC endpoint regardless of the `env` query param**. Same issue exists in `autoplan/route.ts` around line 78.

### 2. `job_status_id=4` does not guarantee a driver is assigned

Cartrack can return a job with status `4 (Assigned)` while `delivery_driver_id` and `assigned_ts` are both `null`. The auto-assign duplicate check queries `status=4` jobs and then inspects stops — this is intentional. But never trust status=4 alone to mean "a real driver is assigned"; always check `delivery_driver_id` directly.

### 3. `findDriverForPickup` ignores its first argument

In `src/lib/psc-config.ts`, `findDriverForPickup(_mappings, pickupCustomerId)` silently ignores the `_mappings` parameter and reads from the module-level `mappingsIndex` instead. Passing a different mappings object has no effect.

### 4. Smart-assign ranking logic is duplicated

Two independent implementations exist:
- `src/app/api/smart-assign/route.ts` — read-only preview/debug endpoint
- `src/lib/assign.ts` (`pickSmartDriver` / `buildActiveRouteMap`) — production path

They share the same reference-stop priority logic and Goong re-rank. If you change ranking in one place, change it in the other too. There is no shared `lib/distance.ts` yet.

### 5. `loadConfigFromSheets` is intentionally uncached

The mapping sheet is re-fetched on every assign cycle (every 30s) so that sheet edits take effect immediately. Do not add caching here without also adding a manual refresh path. In contrast, `psc-config.ts` uses a 5-minute in-memory cache (`PSC_CONFIG_TTL_MS = 5 * 60 * 1000`) and exposes invalidation via the dashboard Refresh button.

### 6. Two completely separate duplicate-detection systems

| | Auto-assign (`POST /api/assign`) | PSC-assign (`POST /api/psc-assign`) |
|---|---|---|
| Checks | status=4 jobs only | status=2 AND status=4 jobs |
| Active stop statuses | `{1,2}` (pending/en-route) | `{1,2,3}` (includes Arrived) |
| 60-min window guard | Yes — within 60 min only | No |
| Action on duplicate | proxy-assign then `delivery_reject_job` JSON-RPC | Returns HTTP 409 before creating the job |
| Exempt labels | `🛵 Vận chuyển mẫu tỉnh` (`PSC_TINH_LABEL`) | No exemptions |
| Race condition guard | None | Module-level `creationLock` Map (15s TTL) |

### 7. Three different representations of "active stop"

- Auto-assign duplicate check: `stop_status_id ∈ {1, 2}` (pending or en-route)
- PSC-assign duplicate check: `stop_status_id ∈ {1, 2, 3}` (also includes Arrived)
- Smart-assign reference-stop selection: prefers `stop_status_id === 3` (Arrived = last known position)

These are not inconsistencies — each has a different semantic goal — but they look like bugs on first read.

### 8. `Date.now() + 7 * 60 * 60 * 1000` anti-pattern

`psc-assign/route.ts` constructs "today in UTC+7" by adding 7 hours to `Date.now()`. This is fragile (breaks at DST boundaries, wrong at year boundaries, etc.). The canonical way used elsewhere is `new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).slice(0, 10)`. Do not copy the `Date.now()+7h` pattern.

### 9. Undocumented Labcenter integration

`src/app/api/customers/route.ts` exists and is not documented in CLAUDE.md. It authenticates to a separate Labcenter system using `LABCENTER_EMAIL` / `LABCENTER_PASSWORD` env vars that are also absent from `.env.example`. If you encounter 500s from `/api/customers`, check these env vars.

### 10. `CARTRACK_WEB_PASS` silently breaks three features

Without this env var, `getFleetwebCookie()` in `cartrack.ts` will fail to log in to Fleetweb. The following features fail silently (no hard error to the user):
- Auto-plan (`delivery_timeline_autoplan`)
- Route optimisation
- Duplicate-job rejection (`delivery_reject_job`)

---

## Smart-Assign Reference-Stop Priority (production path)

When ranking drivers for a pickup, the reference location is chosen in this order:

1. **Last stop with `stop_status_id === 3`** (Arrived) — driver is physically there
2. **Next pending stop** on today's route — where driver is heading
3. **First stop** on today's route — fallback if no pending stop found
4. **`start_location_customer_id`** — fetch coords via `GET /customers/{id}` (no live GPS today)
5. **Live GPS** (`latitude`/`longitude` on Driver object) — last resort

Phase 1 uses haversine to pre-filter to the top-N candidates. Phase 2 re-ranks with Goong road distance (motorbike) if `GOONG_API_KEY` is set.

---

## `GET /customers/{customerId}` — Two Call Sites

`getCustomerById(customerId, env)` in `cartrack.ts` is called for exactly two reasons:

1. **Start-location coordinates** (`smart_driver_id` path): fetches `latitude`/`longitude` for `driver.start_location_customer_id` when driver has no live GPS. Coords used for haversine ranking and as synthetic `"Start Location"` reference stop for Goong ranking.
2. **Alt-dropoff name resolution** (`applyAltDropoff` in `assign.ts`): fetches `customer_name` for `alt_drop_off_id` before swapping the dropoff stop via `PUT /jobs/{jobId}`.

---

## getHeaders Duplication

`cartrack.ts` has a private `getHeaders(env)` helper. The same `Authorization`/`Cookie` header construction is re-implemented in at least 8 route files (`audit`, `cham-cong`, `distance-checking`, `drivers`, `jobs`, `location-jobs`, `psc-tinh`, `sales/*`). If auth logic changes, you must update all of them.

---

## Assign-Engine Flow Summary

```
POST /api/assign
  └─ autoAssignCycle(config, env, skipSmart)
       ├─ loadConfigFromSheets()            # uncached, every cycle
       ├─ getUnassignedJobs()               # status=2 only; age-filtered locally
       ├─ buildActiveRouteMap()             # status=4 jobs for duplicate detection
       └─ for each job:
            ├─ smart path (smart_driver_id set, !skipSmart)
            │    └─ pickSmartDriver() → haversine pre-filter → Goong re-rank
            └─ fixed path (driver_id set)
                 └─ shift window check → assign or log clash
```

```
POST /api/autoplan
  ├─ delivery_timeline_autoplan (JSON-RPC) for smart jobs
  └─ autoAssignCycle(..., skipSmart=true) for fixed jobs
```

```
POST /api/psc-assign
  ├─ creationLock check (15s in-memory)
  ├─ duplicate check (status=2 + status=4, stop_status ∈ {1,2,3})
  ├─ findDriverForPickup() → driver UUID
  └─ POST /jobs → PUT /jobs/assign/{driverUUID}
```

---

## Debug Slash Commands

| Command | Purpose |
|---|---|
| `/env-check [env=prod\|uat]` | Verify env vars, decode auth account, ping Cartrack |
| `/cartrack-call <endpoint> [env=...] [body=...]` | One-off REST or JSON-RPC call |
| `/smart-rank-preview <pickup_customer_id>` | Dry-run smart-assign ranking without assigning |
| `/duplicate-audit [env=...]` | List active duplicate jobs and their status |
| `/assign-trace <job_id>` | Trace why a specific job was or wasn't assigned |

---

## Sustainability Improvements (not yet implemented)

Ranked by ROI:

1. **Extract shared Cartrack client** — `getHeaders` is duplicated in 8+ files; extract to `lib/cartrack-client.ts`
2. **`lib/distance.ts`** — haversine + Goong re-rank duplicated in `assign.ts` and `smart-assign/route.ts`
3. **`vnNow()` / `vnToday()` helpers** — `Date.now()+7h` pattern and `toLocaleString('sv-SE')` used inconsistently across files
4. **Fix auth shadowing** — `assign.ts:419` and `autoplan/route.ts:~78` shadow the env-aware auth variable
5. **`lib/job-filters.ts`** — age filter, skip-note guard, and duplicate key builder repeated in multiple places
6. **Consolidate smart-rank logic** — single `rankDrivers()` in `lib/distance.ts` used by both API routes
7. **Type Cartrack responses** — `any` casts on REST responses make refactoring risky
8. **Document Labcenter** — add `customers` endpoint and `LABCENTER_*` vars to CLAUDE.md and `.env.example`
9. **Label taxonomy doc** — `PSC_TINH_LABEL` and other job labels should be listed in one place
