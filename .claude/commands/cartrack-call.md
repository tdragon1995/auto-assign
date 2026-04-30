Make an authenticated Cartrack API call (REST or JSON-RPC) for debugging or inspection.

Usage: /cartrack-call <endpoint-or-method> [env=prod|uat] [body=<json>]

Examples:
  /cartrack-call GET /jobs?filter[job_status_id]=2&limit=5
  /cartrack-call GET /drivers
  /cartrack-call GET /jobs/12345
  /cartrack-call PUT /jobs/assign/<driverUUID> body={"job_ids":[12345]}
  /cartrack-call jsonrpc delivery_timeline_route_list
  /cartrack-call jsonrpc delivery_reject_job body={"jobIds":[12345],"rejectReason":"test"}

Steps:
1. Determine env: prod uses CARTRACK_AUTH + CARTRACK_COOKIE; uat uses CARTRACK_AUTH_UAT + CARTRACK_COOKIE_UAT. Read from dashboard/.env.local (never log credentials).
2. For REST calls: base URL is `https://fleetapi-vn.cartrack.com/rest/delivery`. Add Authorization header from CARTRACK_AUTH; add Cookie header if CARTRACK_COOKIE is set. Build the curl command and show it (redacting auth values). Execute and pretty-print the JSON response.
3. For JSON-RPC calls: base URL is `https://fleetweb-vn.cartrack.com/jsonrpc/index.php`. Decode CARTRACK_AUTH to extract account name. Use CARTRACK_WEB_PASS for ct_login. Wrap the method in the standard JSON-RPC envelope (version=2.0, id=1, params.data=<body>). Show the curl command (redacted). Execute and print.
4. Print: HTTP status, response body (pretty JSON), and any error messages.

Warn before any PUT/POST that mutates state and ask for confirmation.

Key files: `dashboard/src/lib/cartrack.ts`, `docs/cartrack-api.md`
