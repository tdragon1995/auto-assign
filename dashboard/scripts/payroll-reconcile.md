# Payroll reconciliation operator guide

Run from `dashboard/` in an explicitly authorized environment with existing
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CARTRACK_AUTH`, and
`CARTRACK_WEB_PASS`. Apply and rollback also require the existing Redis REST URL
and token. This command does not fetch environment secrets and has no public API.

Choose a restricted operator directory with filesystem permissions allowing only
payroll operators. Backups, source snapshots and reports contain personal data.
The default `payroll-audits/` location is gitignored; POSIX file modes are set to
700/600, but Windows operators must enforce access with directory ACLs.

```sh
npm run payroll:reconcile -- --month=2026-09 --out-dir=<restricted-run-directory> --regression=<restricted-case-file>
```

Dry-run is the default. It backs up every stored job and punch in the period,
then reads all 31 Vietnam calendar days sequentially. Successful empty days and
failed days are distinguished. Each successful day's raw timeline and completed
REST response is saved. Payroll parsing, punch pairing, rates and cached road
distance providers are shared with the application. Dry-run does not write
payroll or TAT records; resolving missing distances may populate the shared
distance cache and call the existing providers.

Review `audit.json`, `proposal.json`, the daily source files and attendance review
details. Missing, changed, duplicate, wrong-account/date and unpriced jobs are
reported. Missing/orphan punches remain unchanged and require payroll review.
For September, pass the restricted regression case containing the verified driver
account, tracking numbers, customer pair and distance per job. The supplied
12-job case must contribute 46.8 km. Additional jobs are separate rows. Employee
identifiers and real tracking numbers belong in the ignored audit directory.
Failed requests and source disagreements block apply. Correct the source or
parser and regenerate a proposal; do not erase exceptions to force acceptance.

```sh
npm run payroll:reconcile -- --apply=<run-directory>/proposal.json --confirm=APPLY-2026-09
```

Apply requires a reviewed proposal and refuses changes made since its baseline.
It saves `pre-apply-backup.json` and inserted keys before writing, publishes
incomplete coverage, and upserts one day at a time. Each day is verified against
stored field values before being saved in `apply-state.json`. Rerun the same
command to resume an interrupted run. Completed days are skipped; final period
verification detects later changes. No TAT backfill or additional cron is used.

Nothing is deleted by default. If stale rows need removal, review them and supply
a JSON file of the form `{"jobs":[{"trip_date":"2026-08-15","job_id":123}],"punches":[]}`
using `--delete-list=<reviewed-file>`. Every key must be in the proposal's deletion
list. Deletes also match the stored archive timestamp to avoid removing a row
changed concurrently. Stale rows left in place keep coverage incomplete.

Inspect `apply-audit.json`: completion requires all days, no missing/changed/stale
or duplicate rows, and no unpriced jobs. Attendance exceptions keep approval
readiness false even after source reconciliation. Tính lương displays this
coverage status. A later archive change invalidates it. Compare the per-driver
jobs, km, minutes and pay to the supervisor report and downloaded CSV, then verify
the live September period after deployment.

```sh
npm run payroll:reconcile -- --rollback=<run-directory> --confirm=ROLLBACK-2026-09
```

Rollback backs up the current period, restores only rows touched by the reviewed
run, and removes only its inserted keys. It refuses rows subsequently changed
outside the run, verifies restoration, and clears readiness. Keep all audit files
until payroll review is complete. Generate a fresh dry-run before a new apply.

Validation commands:

```sh
node node_modules/tsx/dist/cli.mjs scripts/pay.test.mts
node node_modules/tsx/dist/cli.mjs scripts/payroll-reconcile.test.mts
node node_modules/tsx/dist/cli.mjs scripts/payroll-reconcile-apply.test.mts
npm run build
```

When only the existing GitHub runner has the Supabase secret, its isolated
`codex/payroll-september-audit` branch captures a baseline using that secret. The
repository is public, so its artifact contains authenticated ciphertext only.
The operator's private RSA key stays in the local ignored audit directory; the
runner receives the public recipient key. Do not upload plaintext payroll files.

```sh
node node_modules/tsx/dist/cli.mjs scripts/payroll-audit-decrypt.mts <encrypted-baseline> <operator-private-key> <restricted-baseline.json>
npm run payroll:reconcile -- --month=2026-09 --baseline=<restricted-baseline.json> --regression=<restricted-case-file> --out-dir=<restricted-run-directory>
```

The second command uses existing local Cartrack credentials and the captured
baseline, without needing a local Supabase key. Apply still requires the
authorized environment with the Supabase secret and repeats baseline verification.
