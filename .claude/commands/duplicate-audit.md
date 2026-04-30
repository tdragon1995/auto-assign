Report any duplicate jobs active right now that the engine would block or has blocked today.

Usage: /duplicate-audit [env=prod|uat]

Steps:
1. Fetch all assigned jobs (status=4) for today via `GET /jobs?filter[job_status_id]=4&filter[create_ts_from]=<today 00:00 +07>`.
2. For each job, extract pickup (stop_type_id=1) and dropoff (stop_type_id=2) customer_ids. Build a map of `pickupId:dropoffId → [job_ids]`.
3. Find any pairs with more than one job. For each collision:
   - Show all job_ids in the group.
   - Show stop statuses for each job's pickup stop.
   - Show whether any would be exempt (label `🛵 Vận chuyển mẫu tỉnh`).
   - Show whether the pickup window is more than 60 min in the future (not yet blockable).
   - Classify each as: BLOCKED (proxy-rejected), ACTIVE DUPLICATE (should have been blocked), or EXEMPT.
4. Summarise: total duplicates today, blocked count, active duplicates needing investigation.

Read-only — no changes made.

Key files: `dashboard/src/lib/assign.ts` (`buildActiveRouteMap`), `docs/business-rules.md`
