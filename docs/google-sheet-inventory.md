# Google Sheet inventory (2026-10-29)

Production runs with `MASTER_CLIENT_INFO_SOURCE=supabase`, so the workbook
(`SHEET_ID` in `dashboard/src/lib/sheets.ts`) is meant to be fallback-only. On
2026-10-29 the service account was found to have lost access to it ("The caller
does not have permission" on disabling a location), so anything below that still
runs in production either fails or reads stale data.

Each line: what it is → where → status.

## A. Still runs in production — to fix

- [x] **Rename safety check** — renaming / disabling a location or driver read the
  workbook first. `assertSheetRenameSafe` in `lib/master-profile.ts`. Fixed
  2026-10-29: skips in Supabase mode.
- [ ] **Deleting a removed client** — the reference check reads the retired
  "(NO edit) CONFIG SUNDAY" tab over the public CSV export, ungated.
  `removedClientReferences` in `lib/master-removed-clients.ts`. Sunday rules are
  in Supabase now; drop the sheet read (or check `master_sunday_*` instead).
- [ ] **Sunday edits through the old config-row routes** — the sheet writers only
  divert WEEKDAY to Supabase; a `config_day: "sunday"` request falls through to the
  workbook. `completeConfigRow`, `bulkUpdateConfigRows`, `replaceConfigDriver`
  (`lib/sheets-writer.ts`), reached from `/api/config/complete-row`,
  `/bulk-update`, `/replace-driver`. Check whether the Config tab can still send a
  Sunday request in Supabase mode; either way, refuse it server-side.
- [ ] **Sheet import** — `/api/master-client-info/sync?phase=bootstrap` and the
  `dryRun=1` import read the workbook with the service account
  (`syncMasterSheet`, `stampMasterIds` in `lib/master-sheet-sync.ts`). Real import
  is already refused after cutover; manual-only. Delete once nobody needs a dry run.
- [ ] **Apps Script files in the repo root** — `cartrack_fetcher_all_drivers.gs`,
  `cartrack_fetcher_all_drivers_with_active_column.gs`, `misa_shift_webapp.gs`.
  They run inside Google, not on Vercel, and fill tabs (Driver, shifts) that
  production no longer reads. Turn off their triggers in Apps Script, then delete.

## B. Fallback-only — every one is behind `masterEnabled()`

Dead code in production; it only runs if the switch is turned off.

| Data | Sheet reader / writer |
|---|---|
| Weekday + Sunday config | `lib/config.ts`, `lib/day-config.ts`, `/api/config/rows`, config writers in `lib/sheets-writer.ts` (`writeConfigRows`, `deleteConfigRow`, `bulkDeleteConfigRows`, `adjustConfigRowWindow`, …) |
| Driver roster + Location Table audit | `lib/config.ts` (`SHEET_GID.drivers`, `.locations`), `lib/shift-window.ts` |
| Driver Shift tab | `lib/shift-window.ts` |
| Leave (Nghỉ phép) | `lib/leave-config.ts` (CSV), leave writers in `lib/sheets-writer.ts` (`appendNghiPhep`, `updateLeaveSubs`, `splitLeaveRow`, `deleteLeaveRow`, …), Thay ca sync (`syncThayCaRows`, built on those) |
| Deleted-day tombstones | `lib/leave-suppression.ts` (gviz by name), `appendLeaveDeletion`, `removeLeaveSuppression` |
| Lịch cố định | `lib/schedule-job.ts`, `/api/schedule-job/locations`, `/api/schedule-job/row` (`appendScheduleRow` …) |
| PSC tỉnh 3PL | `lib/psc-config.ts` |
| Public Sunday schedule | `/api/sunday-schedule` |
| Nhận Việc + Mở geofence logs | `appendLogRows` in `lib/sheets-writer.ts` (Supabase `master_action_logs` in production) |

## C. Dev / ops scripts that read the live workbook

`dashboard/scripts/`: `sheet-contract-live.mts`, `config-audit-live.mts`,
`shift-overlap-live.mts`, `leave-profile.mts`, `schedule-snapshot.mts`,
`migrate-remaining-sheets.cjs`. Plus ~15 offline tests that stub the sheet
(`*-write-ranges`, `leave-*`, `config-*`, `sheet-contract.test.mts`) — they go
with the code they test.

## D. Plumbing that goes last

- `lib/sheets.ts` — `SHEET_ID`, `SHEET_GID`, `SHEET_CONTRACT`, CSV/gviz fetch,
  the sheet-alarm list behind the "Cần xử lý" banner (`components/sheet-alarm-banner.tsx`).
- `lib/sheets-writer.ts` — ~2,600 lines, `getSheetsClient`.
- `googleapis` dependency, `GOOGLE_SERVICE_ACCOUNT_KEY` env var (Vercel A + B).
- CLAUDE.md: "Where the data lives", "Google Sheet", footgun 3 and the leave
  sections that still describe rows / tabs.

## Order

1. Section A (small, each a real bug or dead dependency today).
2. Decide whether the Supabase→sheet switch must stay as an emergency fallback.
   The service account can no longer open the workbook, so today it would not
   work anyway. If not: delete B, C and D together and drop `googleapis`.
