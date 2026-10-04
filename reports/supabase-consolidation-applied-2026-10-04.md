# Master schema consolidation — 2026-10-04

The canonical masters now own settings once. Runtime adapters derive the Sheet-shaped output used by assignment and leave calculation. Payroll, attendance, TAT, completed pickup counts and ETA eligibility retain their existing populations and historical labels/timestamps.

| Area | Implemented ownership |
|---|---|
| Account contacts | `master_accounts` owns sales/supervisor fields. `master_clients_read` joins them through `account_id`. |
| Current names | The client read view joins nearest PSC and dropoff names through their IDs. Geography results remain stored. |
| Rule selection | `assignment_mode` and ordered `master_rule_drivers` are canonical. Stored `row_data`, fixed/smart/manual driver copies are removed. Notification token and chat ID are named columns. |
| Leave | Typed dates/times and `master_leave_substitutes` are canonical. Submitted date, leave type and note are ordinary columns. Stored `row_data`, generated legacy aliases and the first-substitute duplicate are removed. `review_input` contains only unresolved names or unparsed dates/times, never resolved fields. |
| Recurring instructions | The unused per-row `source_data` import copy is removed; source evidence is retained in the checkpoint. |
| Approved pickup setup | `pickup_setup` owns linked locations' approved dropoff and ETA. Both editors verify Labcenter then use `commit_pickup_setup` to atomically commit setup and history. Metadata sync adopts unseen setups, keeps approved values, and leaves drift for review. Four unapproved disagreements were reconciled from a read-only Labcenter snapshot. |
| Unlinked clients | The existing dropoff/ETA fields remain only as a fallback for clients without a setup row. A setup commit clears that fallback. No configured unlinked client existed during review. |
| Archived identities | Original external IDs remain canonical. Service-only `*_linked` views derive nullable verified master links; ten stored duplicates and their copy-maintaining triggers are removed. The missing driver was found in Cartrack. The deleted/unavailable location's original UUID remains on its historical trip without inventing a master profile. |
| Driver roster | Local Zalo/token/phone override columns remain authoritative. Duplicate roster JSON keys and the redundant generated delivery-driver UUID column are removed. Cartrack source payloads and useful generated projections remain. |
| Pickup summary | Freshness also checks the master population so new clients get zero totals after refresh. |
| Dormant shifts | Empty `pay_shifts` is retired, with a migration guard that aborts if any rows appear. The optional MISA `driver_shifts` sink is a different integration. |

## Evidence and validation

An existing service-only `master_import_runs` record with `source_hash = 'schema-consolidation-20261004'` preserves pre-migration rules, leave, clients, drivers, recurring instructions and approved setup. Unknown source-only fields, original unresolved inputs and removed copies remain available for review/rollback. Existing rule, leave, setup approval and distance correction audit histories stay intact.

Deploy in two phases: apply read views and the shared setup RPC, deploy their application readers/writers, then remove legacy storage. The contract migration verifies notification settings, leave notes and unresolved inputs against the checkpoint before committing. Both phases were rehearsed together in a transaction that rolled back.

Run `supabase/consolidation.check.sql` after migration. Its edits roll back and verify canonical reads, notification and leave writes, stale revisions, atomic setup audit, import idempotence and service-only permissions. Existing offline profile, location status, pickup-event/retention and ETA tests pass. Run `npm run build` from `dashboard/` before pushing.

## Decisions retained from the review

The three audit/rollback tables, experimental payroll views and import snapshots remain until their audits/rollback obligations end. Road cache, provider audit and correction provenance remain distinct. Planned and unpaid pickup events remain separate from payroll eligibility; TAT continues to measure adjacent stops. A general event model was conditional in the review and is unnecessary for these changes.

Physical table compaction is a separate maintenance operation. Dropping columns and copy-maintaining indexes does not promise an immediate reduction in allocated database files.
