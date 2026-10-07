# Non-Sunday operational source cutover

Sunday configuration and its weekly roster remain in Google Sheet. Its Driver and
Location directories are retained only as aliases for Sunday formulas. Weekday
rules, leave, fixed schedules, driver shifts/PT patterns, 3PL entries, deleted-leave
suppression and new action logs are Supabase-owned when MASTER_CLIENT_INFO_SOURCE=supabase.

## Driver shifts

Open **Lịch ca tài xế**. Choose a day, including a future date, to view or edit
materialized shifts. Add a shift for an active driver, including drivers without
MISA employment. Those drivers use their UUID, never the shared PTBU label.
Manual changes survive MISA refreshes. Revision checks reject concurrent edits.
The PT pattern editor supports effective dates; patterns are expanded by the next
MISA refresh. Unlinked patterns remain inactive and visible for review.

History uses the existing payroll cutoff: the 15th of two months before the
current Vietnamese month. The existing history-retention cron also cleans shifts
and action logs. Future shifts are retained; the default MISA refresh covers the
cutoff month through the end of next month. A selected month can be fetched
through the existing MISA dispatcher. No new polling or scheduled job was added.

Config **Tải lại** invalidates shared config/shift/leave caches, then loads current
Supabase data into the dashboard. It does not fetch Cartrack or Labcenter.

## Import and validation

Run from dashboard with both ignored credential files:

    node scripts/migrate-remaining-sheets.cjs --sheet-env=<Google credential file> --env=<Supabase credential file> [--apply]

The script captures restricted snapshots in ignored reports/, verifies the source
has not changed, and imports all tables in one transaction. It does not mutate
Sheet. It is a one-time cutover tool, not ongoing bidirectional synchronization.

Initial import: 6,649 shifts (1 September–31 October), 80 patterns, 8 3PL entries,
56 deleted-leave suppressions and 449 retained action logs. Six patterns need a
unique driver link. 83 older log rows remain in the Sheet snapshot, outside the
current cutoff. 610 shift rows have no matching Master driver; they remain stored
under their original employee codes and do not gain a guessed driver identity.
The source snapshot has no shifts for 15–31 August; a successful MISA fetch is
needed for that gap and November. Missing rows are unknown, never treated as off.

Runnable checks:

    node scripts/driver-shifts.test.cjs
    node scripts/config-source-warning.test.cjs
    npx tsx scripts/shift-window.test.mts

The SQL check in scripts/driver-shifts.test.sql runs inside a transaction and
rolls back every write. It exercises atomic replacement, manual preservation,
future dates, cutoff rejection and stale edits on the actual database.

Before rollout, GitHub Actions must have SUPABASE_URL and
SUPABASE_SERVICE_ROLE_KEY for the same production project. The MISA reader and
sink fail explicitly if these are absent; they never fall back to Sheet.
