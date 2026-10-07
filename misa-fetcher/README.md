# misa-fetcher

MISA AMIS shift/leave pipeline. Its roster, PT patterns and leave overlay now come
from Supabase. Shifts are replaced atomically through `replace_driver_shifts`;
manual app edits are preserved. Approved leave is submitted through
`/api/nghi-phep`, backed by Supabase. There are no Google Sheet reads or writes.

The existing 05:00 VN dispatcher and **Đồng Bộ Thông Tin → MISA** run this workflow.
Default range: payroll cutoff month through the end of next month. A specific
month can be requested with `--month=YYYY-MM`. History before the 15th of two
months prior is clipped by the database; future dates are retained.

Drivers without MISA employment can use PT patterns linked to their driver UUID.
New patterns take effect in the next refresh. Multiple effective-dated patterns
use the latest applicable start date. Unlinked/review patterns are excluded.
Blank pattern days mean off; absence of a pattern does not mean off.

Required Actions secrets: MISA_USERNAME, MISA_PASSWORD, MISA_TOTP_SECRET,
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Missing Supabase credentials fail before
MISA login or leave writes. Debug artifacts are private Actions artifacts with
seven-day retention. Source keys and service-role keys are never returned to UI.

Local flags: `--dry-run`, `--no-leave`, `--leave-dry`, `--month=YYYY-MM`,
`--months=N`, `--start-offset=N`, `--headed`. `--no-supabase` is for local debugging
only. Locally copy `.env.example` to ignored `.env`, install the existing
Playwright runtime, and run `npm run fetch`.

PT companion leave behavior is unchanged: afternoon FT leave extends to 23:59
on its uniquely matched PT account; ambiguous twins are reported. Manual leave
removals are retained in `master_leave_suppressions`. Use the dashboard's
**Khôi phục** action to let an automated leave record return.

Checks: `node scripts/pt-companion.test.mjs`; see
[cutover notes](../docs/non-sunday-supabase.md) for database and shift-reader checks.
