Verify the current environment configuration before making prod-affecting changes.

Usage: /env-check [env=prod|uat]

Steps:
1. Read `dashboard/.env.local`. Check which vars are set vs missing:
   - Required: CARTRACK_AUTH (or CARTRACK_AUTH_UAT for uat)
   - Optional but needed for JSON-RPC: CARTRACK_WEB_PASS
   - Optional: CARTRACK_COOKIE, GOONG_API_KEY, CARTRACK_REJECT_PROXY_DRIVER_ID, ROUTE_OPTIMIZE_PILOT
   Print PRESENT or MISSING for each. Never print credential values.
2. Decode CARTRACK_AUTH (base64 Basic payload) to show the account name only (not the password). Confirm this is prod or UAT as expected.
3. Ping `GET /drivers?limit=1` with the auth credentials. If HTTP 200, print "Auth OK, connected to Cartrack [prod|uat]". If not, print the error status.
4. If CARTRACK_WEB_PASS is set, attempt `ct_login` and report whether the JSON-RPC session was established.
5. Print a summary: environment, auth status, JSON-RPC status, missing optional vars.

This is a read-only preflight check — make it a habit before any assign-engine work on prod.

Key files: `dashboard/.env.local`, `dashboard/src/lib/cartrack.ts`, `docs/cartrack-api.md`
