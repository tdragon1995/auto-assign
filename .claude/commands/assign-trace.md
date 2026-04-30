Trace why a specific job was or was not assigned by the auto-assign engine.

Usage: /assign-trace <job_id> [env=prod|uat]

Steps:
1. Fetch the job via `GET /rest/delivery/jobs/<job_id>` using CARTRACK_AUTH (prod by default, or UAT if env=uat). Show: job_id, job_status_id, create_ts, stops (stop_type_id, customer_id, customer_name, note).
2. Identify the pickup stop (stop_type_id === 1). Extract its customer_id.
3. Load the mapping sheet (GID 0 of the sheet in `dashboard/src/lib/sheets.ts`) and find the row with that customer_id. Show: driver_id, smart_driver_id, shift_start, shift_end, alt_drop_off_id.
4. Check each skip condition in order, printing PASS or FAIL for each:
   a. Job age: is create_ts within the last 60 minutes (Asia/Ho_Chi_Minh)?
   b. Stop notes: does any stop have a non-empty note?
   c. Duplicate: fetch assigned jobs (status=4) for today and check for a matching pickup→dropoff pair that is still active and not far-future.
   d. Mapping found: was a row found for this customer_id?
   e. Shift window: is the current Saigon time within shift_start–shift_end (if set)?
5. Print the likely decision: ASSIGNED (fixed), ASSIGNED (smart), SKIPPED (duplicate), SKIPPED (no mapping), SKIPPED (out of shift), SKIPPED (too old), or SKIPPED (stop note).
6. If the job would have gone through the smart path, list the smart_driver_id candidates and their current online/offline status.

Key files: `dashboard/src/lib/assign.ts`, `dashboard/src/lib/cartrack.ts`, `docs/business-rules.md`
