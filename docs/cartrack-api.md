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

Wrapper: `getCustomerById(customerId, env)` — used for fallback GPS when a driver's `start_location_customer_id` is set but no live GPS exists.

## JSON-RPC methods

### `delivery_timeline_route_list`

Reads all driver route timelines for a day. Used by smart-assign ranking and the autoplan route.

Filter: `scheduleType: "scheduled"`, `from/to: YYYY-MM-DDT00:00:00+07:00 / ...T23:59:59+07:00`

Response fields used: `routeId`, `orderedStops[].{jobId, stopId, stopStatusId, latitude, longitude, customerName, activityCompletedTs}`

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

## Timezone

All business-logic time is `Asia/Ho_Chi_Minh` (UTC+7). Cartrack timestamps arrive without a timezone suffix and are treated as UTC+7 by appending `+07:00` before parsing.
