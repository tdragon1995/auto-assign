# Google Sheet inventory

**Done 2026-10-31.** Every Google Sheet dependency is gone from the code. Kept as a
record of what was removed and the one thing left outside the repo.

On 2026-10-29 the app's Google service account was found to have lost access to the
workbook ("The caller does not have permission" when turning a location off). The
decision was to delete the sheet path rather than restore access: production had
run on Supabase (`MASTER_CLIENT_INFO_SOURCE=supabase`) since the cutover, so the
sheet was only a fallback that could no longer work.

## Fixed (were still live in production)

- [x] Rename / disable a location or driver read the workbook first (`assertSheetRenameSafe`). Deleted.
- [x] Deleting a removed Cartrack client also checked the retired Sunday config tab. Dropped; the Supabase reference check stays.
- [x] Sunday edits through the old config line routes fell through to the sheet writer. These routes now refuse Sunday (`weekdayOnly`); Sunday is edited by area.
- [x] On a Sunday the engine's "add config for an unconfigured branch" aimed at the sheet. It now skips Sundays; the coverage gap is still recorded.
- [x] Sheet import (`master-sheet-sync.ts`, sync `phase=bootstrap` / `phase=sheet`). Deleted with its two scripts.
- [x] Apps Script files in the repo root (`cartrack_fetcher_all_drivers*.gs`, `misa_shift_webapp.gs`). Deleted from the repo.

## Removed (fallback only)

- The `MASTER_CLIENT_INFO_SOURCE` switch (`masterEnabled`, `masterScheduleEnabled`, `assertMasterWritable`) — Supabase is the only path.
- `lib/sheets.ts` and `lib/sheets-writer.ts` (~3,000 lines): CSV/gviz readers, column contracts, every sheet writer.
- Sheet branches in config, day-config, shift windows, 3PL, leave, deleted-days, Lịch cố định, public Sunday schedule, Thay ca sync and the two activity logs.
- `LEAVE_NAME_RECOVERY` and name-based leave recovery (sheet-only; Supabase leave carries the linked driver).
- The Location Table duplicate-name audit (sheet-only).
- `googleapis` package; `GOOGLE_SERVICE_ACCOUNT_KEY`, `MASTER_CLIENT_INFO_SOURCE`, `LEAVE_NAME_RECOVERY` from `.env.example`.
- Sheet-only scripts (contract checks, live audits, write-range tests, snapshots, migration helpers).

What moved rather than went: leave types and pure helpers → `lib/leave-rows.ts`;
activity logs → `lib/action-log.ts`; config warning banner → `lib/config-alarms.ts`;
the Thay ca row sync → `lib/thay-ca-reconcile.ts`. `loadConfigFromSheets` /
`loadDriversFromSheet` are now `loadConfig` / `loadDrivers`.

## Left to do by hand (outside the repo)

- [ ] Turn off the Apps Script triggers in the `cartrack_combined` project (Driver tab fetcher, MISA web app). Deleting the files here does not stop them.
- [ ] Remove `GOOGLE_SERVICE_ACCOUNT_KEY`, `MASTER_CLIENT_INFO_SOURCE` and `LEAVE_NAME_RECOVERY` from both Vercel projects once this is deployed. Harmless if left; nothing reads them.

## Not done

- The config screens still use a row number as their handle for a rule. Nothing writes by it (every save is matched by rule id + revision); switching the screens to the rule id is a separate change.
