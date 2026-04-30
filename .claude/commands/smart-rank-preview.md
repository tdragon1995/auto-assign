Show the smart-assign driver ranking for a given pickup customer without making any changes.

Usage: /smart-rank-preview <pickup_customer_id> [env=prod|uat]

Steps:
1. Load the mapping sheet and find the row for <pickup_customer_id>. Show smart_driver_id list. If not found or no smart_driver_ids, stop and explain.
2. Fetch all drivers from `GET /drivers` (limit=1000). Filter to the smart_driver_id candidates. Show each candidate's: name, driver_status_id, is_online, GPS (latitude/longitude).
3. Fetch today's route timeline via JSON-RPC `delivery_timeline_route_list` (scheduleType=scheduled, today in Asia/Ho_Chi_Minh). For each candidate driver find their reference location using this priority:
   - Last stop with stopStatusId=3 (Arrived)
   - Next pending stop on route
   - First stop on route
   - start_location_customer_id (fetch customer coords)
   - Live GPS coords
   Print which reference source was used for each driver.
4. Compute haversine distance from each reference location to the pickup customer's GPS coords (fetch customer if needed). Print ranked list.
5. If GOONG_API_KEY is set, re-rank by Goong road distance (motorbike). Show both haversine and road-distance rankings side by side.
6. Print final ranked list with estimated distances. Mark the winner.

Read-only — does not assign anything.

Key files: `dashboard/src/app/api/smart-assign/route.ts`, `dashboard/src/lib/cartrack.ts`, `docs/business-rules.md`
