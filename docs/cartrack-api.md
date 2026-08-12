# Cartrack API Reference

Repo-derived knowledge. Where behaviour is inferred from calling code it is labelled as an inference. No official Cartrack docs are checked in.

## Two backends

| Backend | Base URL | Used for |
|---|---|---|
| REST delivery API | `https://fleetapi-vn.cartrack.com/rest/delivery` | jobs, drivers, customers, assignment |
| Fleetweb JSON-RPC | `https://fleetweb-vn.cartrack.com/jsonrpc/index.php` | session login, route timeline, route optimisation, job rejection |

Implementation: `dashboard/src/lib/cartrack.ts`

## Authentication

### REST

| Env var | Required | Header |
|---|---|---|
| `CARTRACK_AUTH` / `CARTRACK_AUTH_UAT` | Yes | `Authorization` |
| `CARTRACK_COOKIE` / `CARTRACK_COOKIE_UAT` | No | `Cookie` |

`CARTRACK_AUTH` is `Basic <base64>` where the payload is `ACCOUNT:apipassword`.

### Fleetweb JSON-RPC

Requires `CARTRACK_AUTH` (to decode account name) and `CARTRACK_WEB_PASS` (separate web password — **not in `.env.example`**). The code calls `ct_login`, caches the session cookie in memory for 12 hours.

`ct_login` payload shape:
```json
{
  "version": "2.0",
  "method": "ct_login",
  "id": 1,
  "params": {
    "x": "x",
    "account": "<from Basic auth>",
    "username": "",
    "password": "<CARTRACK_WEB_PASS>",
    "locale": "en-ZA",
    "otp": "",
    "browserName": "",
    "version": "3.9.1",
    "environment": "live",
    "thirdParty": false
  }
}
```

## REST endpoints

### `GET /jobs` — list jobs

Wrapper: `getUnassignedJobs(page, perPage, env)`

Supported filters (documented by Cartrack):

| Param | Meaning |
|---|---|
| `filter[job_status_id]` | job status (see enums below) |
| `filter[create_ts_from/to]` | creation window |
| `filter[scheduled_delivery_ts_from/to]` | scheduled delivery window |
| `filter[driver_id]` | assigned driver UUID |
| `filter[reference_number]` | reference number |
| `filter[item_tracking_number]` | tracking number |
| `page` / `limit` | pagination (limit up to 1000) |

**Current code only uses `job_status_id=2`.** Post-filters by `create_ts` locally. Not appropriate for scheduled jobs — use `scheduled_delivery_ts` filters for those.

### `GET /drivers` — list all drivers

Wrapper: `getDrivers(env)` — fetches page 1, limit 1000.

### `GET /drivers/{driverId}/jobs` — assigned jobs for a driver

Wrapper: `getDriverJobs(driverId, dateVn, env)` — filters `job_status_id=4`, date window via `create_ts_from/to`.

### `PUT /jobs/assign/{driverUUID}` — assign a job

Wrapper: `assignJob(driverId, jobId, env)`

Body: `{ "job_ids": [jobId] }`

Always uses the driver UUID in the URL path. Driver display names are used only for log messages in calling code, never as an API identifier.

### `PUT /jobs/{jobId}` — update a job

Wrapper: `updateJobStops(jobId, stops, env)` — used to swap the dropoff customer when `alt_drop_off_id` is configured before assignment.

### `GET /jobs/{jobId}` — job detail

Wrapper: `getJobDetails(jobId, env)` — used after assignment to fetch driver name for Zalo notification.

### `GET /customers/{customerId}` — customer detail

Wrapper: `getCustomerById(customerId, env)` — called in two situations:

1. **Start-location coordinates** (`assign.ts` smart-assign setup): fetches `latitude`/`longitude` for a driver's `start_location_customer_id` when the driver has no live GPS. The resolved coords are used as the driver's effective position for haversine pre-ranking and, when the driver has no route data for the day, also as a synthetic `"Start Location"` reference stop for Goong distance ranking.
2. **Alt dropoff name resolution** (`applyAltDropoff` in `assign.ts`): fetches `customer_name` for `alt_drop_off_id` before the dropoff stop is swapped via `PUT /jobs/{jobId}`.

## JSON-RPC methods

### `delivery_timeline_route_list`

Reads all driver route timelines for a day. Used by smart-assign ranking and the autoplan route.

Request filter:
```json
{
  "scheduleType": "scheduled",
  "from": "YYYY-MM-DDT00:00:00+07:00",
  "to":   "YYYY-MM-DDT23:59:59+07:00"
}
```

Response shape:
```json
{
  "result": {
    "routes": [
      {
        "routeId": "driver_<driverUUID>",
        "orderedStops": [ "<Stop>" ]
      }
    ],
    "meta": {
      "total": 99,
      "peakMemUsage": "<string>",
      "avgMemPerElement": "<string>"
    }
  }
}
```

Stop object (full shape from real data):

| Field | Type | Notes |
|---|---|---|
| `stopId` | number | Stop primary key |
| `jobId` | number | Parent job ID |
| `stopTypeId` | number | 1=Pickup, 2=Dropoff, 3=Delivery |
| `stopStatusId` | number | 1=Created, 2=Started, 3=Arrived, 4=Completed, 5=Rejected |
| `customerName` | string | Display name of the customer |
| `deliveryDriverId` | string (UUID) | Assigned driver |
| `referenceNumber` | string | Job reference number |
| `sendToDriverAt` | string \| null | ISO timestamp when sent to driver |
| `allowedToStartAt` | string \| null | Earliest start timestamp |
| `scheduledDeliveryTs` | string \| null | e.g. `"2026-04-02 14:30:19.718904+07"` |
| `isPlanning` | boolean | True if in planning state |
| `firstStopStatusId` | number | Status of the first stop in the job |
| `deliveryDate` | string | ISO timestamp of actual/expected delivery |
| `jobStatusId` | number | Parent job status |
| `deliveryWindows` | array | Time windows (see below); empty `[]` if none |
| `jobLabels` | string[] | Labels attached to the job |
| `etaInSeconds` | number | ETA from driver position; 0 if unknown |
| `latitude` | number | Stop GPS latitude (used by ranking code) |
| `longitude` | number | Stop GPS longitude (used by ranking code) |
| `activityCompletedTs` | string \| null | When the stop was completed (used by ranking code) |

`deliveryWindows` element shape:

| Field | Type | Example |
|---|---|---|
| `stopId` | number | Matches parent `stopId` |
| `timeFrom` | string | `"11:00:00+07"` |
| `timeTo` | string | `"11:30:00+07"` |

Fields consumed by this codebase: `routeId`, `orderedStops[].{jobId, stopId, stopStatusId, latitude, longitude, customerName, activityCompletedTs}`

### `delivery_route_stops_optimize`

Triggers route optimisation for one driver. Only fired for drivers in `ROUTE_OPTIMIZE_PILOT`.

```json
{
  "method": "delivery_route_stops_optimize",
  "params": { "data": {
    "routeId": "driver_<driverId>",
    "scheduleType": "scheduled",
    "filter": { "from": "...", "to": "..." }
  }}
}
```

### `delivery_reject_job`

Rejects a job after proxy-assignment (duplicate handling).

```json
{
  "method": "delivery_reject_job",
  "params": { "data": {
    "jobIds": [12345],
    "rejectReason": "<Vietnamese duplicate message>"
  }}
}
```

### `delivery_timeline_delete_jobs`

Deletes jobs outright — the request the fleetweb map/timeline screen fires when an
admin removes a job from a driver's day. Used by the stale-trip cleanup
(`deleteJobsFromTimeline` in `cartrack.ts`), which prefers deleting a dead
auto-created via-leg/return over rejecting it: a rejected job still shows in the
job list and branch feeds, a deleted one leaves nothing behind.

Needs no proxy-assign first — it removes an *assigned* job directly. `filter` must
be the day window the job actually sits on (yesterday's leftovers are not on
today's timeline). `updateRecurringSetup: false` deletes only these occurrences,
leaving any recurring setup alone.

```json
{
  "method": "delivery_timeline_delete_jobs",
  "params": { "data": {
    "jobIds": [12345],
    "scheduleType": "scheduled",
    "filter": { "from": "YYYY-MM-DDT00:00:00+07:00", "to": "YYYY-MM-DDT23:59:59+07:00" },
    "updateRecurringSetup": false
  }}
}
```

Cleanup falls back to `delivery_reject_job` when a delete is refused (a started or
hung job can be) — better a rejection record than a live stale trip.

## Status enums

### Job status

| ID | Name |
|---|---|
| 2 | Assign Later (unassigned) |
| 3 | Rejected / Failed |
| 4 | Assigned — **does not guarantee `delivery_driver_id` is set** |
| 5 | Completed |
| 7 | Canceled |

### Stop status

| ID | Name |
|---|---|
| 1 | Created |
| 2 | Started (en route) |
| 3 | Arrived |
| 4 | Completed |
| 5 | Rejected |

### Stop type

| ID | Name |
|---|---|
| 1 | Pickup |
| 2 | Dropoff |
| 3 | Delivery |

### Driver status (`DRIVER_STATUS_CONFIG` in `types.ts`)

| ID | Name |
|---|---|
| 1 | Online |
| 2 | On Route |
| 3 | Not Active |
| 4 | Offline |
| 5 | On Break |

### Schedule type

| ID | Name |
|---|---|
| 1 | As Soon As Possible |
| 2 | Scheduled |
| 3 | Unscheduled |

**Always use `schedule_type_id: 1` (ASAP) when creating jobs and omit `scheduled_delivery_ts`.** `schedule_type_id: 2` requires `scheduled_delivery_ts` to be a future timestamp — passing the current time causes a 422 "must be a date after now" error due to clock skew between the server and Cartrack. `schedule_type_id: 1` creates an immediate ASAP job with no timestamp dependency.

## Stop creation rules

**Never pass `customer_name` in a stop payload.** Cartrack resolves the display name from `customer_id` automatically. Passing `customer_name` overwrites the name stored against that customer in Cartrack, causing permanent data corruption for all future jobs at that location.

## Timezone

All business-logic time is `Asia/Ho_Chi_Minh` (UTC+7). Cartrack timestamps arrive without a timezone suffix and are treated as UTC+7 by appending `+07:00` before parsing.
