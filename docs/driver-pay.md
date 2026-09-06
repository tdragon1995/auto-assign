# Part-time pay (Thu Nhập)

What a part-time driver earned, archived alongside the TAT legs and read back two
ways: by the driver in `/cham-cong`, and by điều phối on the dashboard's **Lương
PT** tab.

## The two rates

```
30.000đ  per hour clocked, from the driver's own chấm-công check-in / check-out taps
 2.000đ  per kilometre, pickup → dropoff on each COMPLETED job
```

Both live in `dashboard/src/lib/pay.ts` (`RATE_PER_HOUR_VND`, `RATE_PER_KM_VND`)
and are applied on read, never stored.

## The kilometre is a JOB's pickup→dropoff, not a TAT leg

These are different numbers and the difference is not small.

A **leg** (`docs/driver-tat.md`) is the ride between two consecutive stops. A driver
collecting at three clinics before the lab run rides four legs while completing three
jobs, and the leg kilometres exceed the job kilometres by every hop between clinics.

The leg is what they actually rode. The job pickup→dropoff is what payroll pays, and
it is the **same measure `/api/export-completed` has produced for the payroll CSV all
along** — this module did not invent a rule, it automated the one already in use.

The driver's screen says so in as many words, because comparing the km on the Hiệu
Suất tab with the km on the Thu Nhập tab is the first thing anyone will do.

## Distance is frozen, hours are not

`distance_km` costs a billed provider request the first time a pickup→dropoff pair is
ever seen, so it is resolved once and stored on the row. Recomputing it would re-spend
real money to arrive at the same number.

Hours cost nothing to recompute, and **the payroll pairing formula is still being
settled**. So the raw taps are archived — all three activity stamps, exactly as
Cartrack reported them — and the minutes are derived on read by
`workedMinutes()` in `pay.ts`, which is the *only* place the pairing lives.

Replacing it is a change to that one function: no re-archive, no Cartrack day-fetch,
no billed lookup, and every past month re-reads correctly the moment it ships.
`scripts/pay.test.mts` section 1 is the thing to rewrite alongside it.

### The provisional rule, today

Sort the day's taps by time; pair each check-in with the next check-out; sum the
pairs. Several pairs a day is normal — drivers check in and out at different PSCs
across a shift, and the gap between two shifts is not paid time.

An **unpaired check-in pays nothing**. There is no recorded end to that shift, and
the data cannot tell a forgotten tap from a short one. It is surfaced instead: a ⚠ on
the driver's day, a count on the supervisor's row, and a banner on both — because the
fix has to happen before the 25th.

## Where the data comes from

Nothing here fetches anything of its own. `archiveDay()` in `tat-archive.ts` already
pulls one day of Cartrack routes to cut TAT legs; `archivePay()` runs off the **same
routes**, in the same pass, behind the same Redis seal.

**Do not add a cron for this** — same rule as footgun 8 in `CLAUDE.md`, for the same
reason. Backfill is the existing `/api/tat/archive?date=…&days=N`, which now writes
both records.

`archivePay()` runs *after* the legs are safely written and inside its own
try/catch. A pay failure is reported in `ArchiveResult.pay.error` and never fails the
day: legs are the older record and the one the seal was built for, and a released
seal would take the day's legs down with the pay.

## Tables

| Table | One row is | Key |
|---|---|---|
| `pay_jobs` | one completed job with a real pickup and dropoff | `(trip_date, job_id)` |
| `pay_punches` | one chấm-công tap | `(trip_date, job_id)` |
| `v_pay_daily` | a driver's kilometres for a day (view) | — |

Both tables are written upsert-first-then-delete-what-was-not-touched, exactly as
`tat_legs` is, so a write that dies leaves the previous copy of the day intact rather
than an empty one.

RLS is on with **no policies**: only the service-role key reaches them.

Migration: `supabase/migrations/20260905090000_driver_pay.sql`.

## Reading it back

| Route | Answers |
|---|---|
| `GET /api/pay/me?month=YYYY-MM` | the signed-in driver's month: totals + one line per day |
| `GET /api/pay/me?date=YYYY-MM-DD` | that day's jobs and taps |
| `GET /api/pay/team?month=YYYY-MM` | every PT driver's month, for điều phối. Defaults to LAST month |

`/api/pay/me` takes the driver_id from the **signed HttpOnly `nv_session` cookie and
never from a query parameter** — the rule `/api/tat/me` follows, and here the
strictest case of it: a readable id in the request would make every driver's pay
readable by every other driver.

It also refuses anything that is not a **PT** account, including an account whose
label carries no staff code at all. This is money, so "cannot tell" has to mean no.

`/api/pay/team` carries no session and inherits the dashboard's own (absent) auth
posture, exactly as `/api/tat/team` does. If the dashboard ever gets a gate, this
route should be near the front of the queue — it is the one endpoint that returns
everybody's pay.

## The report stops at yesterday

Same rule as the TAT report, plus a better reason. `/api/tat/me` used to refresh
today on demand and became the most expensive thing in the system; beyond that, a
part-day total that changes every time you look is not something anyone should be
checking their pay against.

## Rounding

Totals **sum the kilometres and price once**; they never add up per-job đồng. Each
job's figure on screen is `kmPayFor(km)` for display only — adding thirty of those
instead would drift from the total by up to fifteen đồng, and a payslip whose lines
do not add to its own total is a payslip nobody trusts. The same rule is why the
supervisor CSV carries exact figures while the table rounds to millions.

Hours are charged **per minute** (30.000đ/h is exactly 500đ a minute), so a
twenty-minute shift is not rounded away to nothing.

## Cost

The marginal cost of this module is close to zero, by construction:

- **No Cartrack calls.** It rides a day-fetch that was already happening.
- **No new cron, no new seal.**
- **Distance lookups go through the shared non-expiring Redis pair cache**
  (`dist:v1:*`) that `/api/export-completed` has been warming with these exact
  pickup→dropoff pairs for months. Only a genuinely new pair is billed, once.
- **Storage** is one row per completed job and one per tap — a few hundred rows per
  driver-month.

The one thing that does spend is a **historical backfill**, which resolves pairs the
cache may not hold. Run it a few days at a time rather than `days=31` in one request:
the route's 60-second budget is per request, and a cold day can use most of it on its
own.

---

# Where this is up to

Written 2026-09-06, mid-build. Delete this section once the open items are closed —
it describes work in flight, not how the module behaves.

## Settled, and why

**The hours rule is the payroll workbook's, not "tap to tap".** Established by
reading `2026.08_PT_Records_Vận_14.08.xlsx` (1,076 driver-days, 15/07–14/08) and
checking its own computed cells:

```
in  = MAX(check-in tap, shift start)       early arrival earns nothing
out = MAX(shift end, last completed task)  paid to shift end even if you stopped
                                           early; past it only as far as real work
```

The check-out tap is **discarded** whenever a shift end and a last task both exist —
including obviously wrong taps (a 15:00 tap on a shift ending 21:00 paid to 21:15; a
22:01 tap capped at 21:13). It survives only when one of the three is missing.
`workedMinutes` implements this; `scripts/pay.test.mts` §1 pins four rows copied from
the workbook's output.

**Sunday split shifts do NOT need gap-splitting.** All 62 multi-ca Sunday driver-days
in that file are back-to-back (`06:00-15:00 + 15:00-20:00`), so MIN/MAX and
sum-of-ca give identical answers on every row — the workbook has never overpaid one.
The agreed implementation is **merge touching/overlapping windows, then sum the merged
intervals**: same answer today, correct if a real gap ever appears. NOT YET WRITTEN.

**The pay period is the 15th to the 14th**, not the calendar month — that is what the
payroll file covers and what a driver is actually paid. `?month=YYYY-MM` is therefore
wrong and both UIs say "Tháng N". NOT YET CHANGED.

**Parity is the route, not the destination.** The workbook is being retired, but the
app has to reconcile against it first, per-row on a real month, so that its
disagreements are examined rather than inherited. One known workbook artifact is
already NOT copied: where the check-out tap exactly equals the shift end and the last
task is later, its formula keeps the tap instead of extending. `workedMinutes` takes
the clean `MAX`.

## Answered, 2026-09-06

**The 35.000đ rate belongs to the PERSON, not the shift** — it is Lê Ngọc Anh Tú's
arrangement, and his 06:00–15:00 morning work **is not normal delivery work** and is
**paid separately**, outside this module. So the app must not price those taps at all:
not at 30k, not at 35k. They are somebody else's ledger.

**A PT account cannot be paid for being early.** That is exactly what the roster
window is for. Phan Thanh Phương's mid-day gap is the FT→PT handover, not overtime.

**No check-out → take the latest completed task.** Which is what the workbook does
and what `workedMinutes` already implements: `out = MAX(shift end, last task)`.

**Distance exclusions** — implemented and measured over 15/07–14/08 (5,260 completed
pairs), see `payRowsForRoute`:

| rule | jobs removed | share |
|---|---:|---:|
| return leg (`PSC_RETURN_LABEL`) carries nothing back | 28 | 0.5% |
| via leg (`PSC_VIA_LABEL`) with no item tracking number | 17 of 115 | 0.3% |
| jobs riding together — one visit out, one visit back | 37 | 0.7% |

**The third rule nearly went in wrong.** Grouping by driver + day + pickup + dropoff
looks equivalent and removes **36.7% of every job in the period — 1,930 real
payments** — because the shuttle runs repeat the same pair hourly all afternoon
(15:19, 16:46, 17:40, 20:52 …) and those are separate rides. Merging is by
CONSECUTIVE stops at one place, the same rule `tat.ts` uses, which needs no
threshold. `scripts/pay.test.mts` §5 pins both directions.

Excluded jobs are not written to `pay_jobs` at all, so they do not appear on the
driver's trip list. That keeps the schema unchanged, at the cost of "why is my trip
missing" — an `excluded_reason` column would be the transparent version, and needs a
migration applied BEFORE the code ships or the pay archive fails its write.

## Open items

1. **The shift window has no source.** `workedMinutes` takes it as an input
   (`DayFacts.shift`) and every caller currently passes `NO_SHIFT`, so every day comes
   back `missing_shift: true` and falls back to raw taps. The surfaces carry that
   through as `provisional` and say so, but it is not the payroll figure.
   The intended source is the workbook tab at **gid `1656364758`** — add it to
   `SHEET_GID` and to `SHEET_CONTRACT` as **`expect`, never `require`** (footgun 3:
   requiring a column that is not there yet refuses the tab on every load). Its header
   row still needs reading. Precedence, from the workbook: **Sunday roster → substitute
   → standing contract**.
   Watch out: some Sunday `Họ và tên` cells carry **no PT code**, so those rows can only
   be matched by exact full name.

2. **A PT account is not always a part-time shift — it is sometimes an FT
   driver's overflow, and paying it by the clock DOUBLE-PAYS.**

   Some drivers hold both accounts and **switch to the PT account to finish trips
   that spill past their full-time shift**. On such a day there is no PT roster
   row, because the person was rostered under their `DC…` code; the `PT…` account
   exists only to carry the tail.

   Twenty people in the roster grid hold both a `DC…` and a `PT…` code. The worst
   discrepancy in the 15/07–14/08 reconciliation is one of them: **Lê Hồng Thái**
   (PT101732, twin DC102081) — workbook 47.5 h over 24 days, app 329.7 h. The
   workbook holds those days to a 19:00–19:30 contract; the app, with no roster,
   takes the raw span of the taps.

   The hazard is not just overstatement. If the chấm-công taps on the PT account
   span the whole working day, the hourly clock covers hours **already salaried
   under the DC account** — the company pays for them twice. So for a twin holder
   the PT clock has to exclude the DC shift, which means knowing the DC roster
   too, not just the PT one. A PT-only clamp does not solve this.

   Note this is only part of the 15% gap: four of the six worst-gap drivers — **Lê
   Hoàng Anh Duy**, **Lê Ngọc Anh Tú**, **Nguyễn Viết Phi**, **Trần Minh Long** —
   hold **no** twin. For them the cause
   is simply the missing clamp. Two separate faults, one shared fix.

3. **THE HOURLY RATE IS NOT 30.000đ FOR EVERYONE.** **Lê Ngọc Anh Tú** works a
   morning shift, 06:00–15:00, paid a fixed **35.000đ/hour**, on top of the
   15:00–21:00 evening shift the PT roster lists. So `RATE_PER_HOUR_VND` as a
   single global constant is wrong, and every đồng figure derived from it is wrong
   for anyone on a second rate. Unknown so far: how many rates exist, whether 35k
   attaches to the shift or to the person, and whether the morning shift is paid
   through this PT account at all or settled separately.

4. **A day's chấm-công taps do not necessarily belong to the rostered shift.**
   Two distinct signatures, and they need opposite treatment:

   **(A) The taps document a SEPARATE, EARLIER shift** — the tap-out lands exactly
   as the rostered shift begins. **Lê Ngọc Anh Tú** 27 of 30 days (taps 05:58→15:00
   against a 15:00–21:00 roster); **Lê Hồng Thái** 15 of 24. For Anh Tú the taps are
   his 35k morning shift; for Lê Hồng Thái, who holds DC102081, they are his
   full-time day. Either way the taps and the roster describe DIFFERENT work, and
   the app's tap-to-tap clock measures the one payroll is not paying on that line.

   **(B) One long span swallowing the rostered shift** — one tap-in hours early, one
   tap-out late, no check-out in between. **Lê Hoàng Anh Duy** 25 of 28 (dismissed),
   **Phan Thanh Phương** 24 of 27, **Nguyễn Phú Quốc** 17 of 31, **Y Quý** 9 of 29.
   Three of those four hold a DC twin, so the likely reading is a full-time day
   followed by a PT evening with no check-out between them — the double-pay case,
   not misuse. Lê Hoàng Anh Duy held no twin, which is what made him stand out.

   A CORRECTION TO AN EARLIER READING IN THIS FILE: a naive "median minutes early"
   statistic conflates A and B and made Anh Tú look like Duy. He is not the same
   case — his taps are a clean nine-hour block that ends precisely when his roster
   shift starts, which is a second job, not an early tap.

5. **The check-in tap is not evidence of work, and drivers know it.**
   **Lê Hoàng Anh Duy** (PT101574, since dismissed) was rostered 17:00–20:30 and
   tapped in between 07:11 and 07:53 — nine and a half hours early — on 28 of 28
   days. His check-outs were honest to the minute (20:30–20:39 against a 20:30
   finish), so this was the check-in specifically. The shift-start floor removed
   **230.8 h = 6,925,500đ** from that one driver in that one period; unclamped the
   app would have paid 358.5 h (10,755,000đ) against payroll's 125.3 h
   (3,759,000đ).

   Which is why a tap-based figure must never be shown to a driver as their
   earnings: it is a number that goes UP when they tap in early. Three drivers —
   **Lê Hồng Thái**, **Lê Ngọc Anh Tú**, **Lê Hoàng Anh Duy** — account for 73% of
   the whole gap.

3. **A rolled-over job corrupts `lastTaskAt` at both ends.** A job finished the
   following day lands its `dropoff_completed_ts` on the wrong day, which both shortens
   the day it belonged to and extends the day it landed on — and `out` is
   `MAX(shift end, last task)`, so it is paid time. Not analysed yet. Note the assign
   cycle's own rollover (`rolloverUnfinishedJobs`) re-dates such jobs, so the two
   mechanisms interact.

6. **`firstTaskAt` is a proxy.** The workbook uses the job's `Started Time`; `pay_jobs`
   stores `pickup_completed_ts`, a few minutes later. It only matters on days with no
   check-in tap (~3%). Fixing it means adding a `started_ts` column and re-archiving —
   cheap, since the distances are already cached.

7. **The month view cannot supply first/last task**, because it reads `v_pay_daily`
   which carries kilometres but no stamps. The day drill-down is exact; the month is
   deliberately coarser. Revisit if the month total has to match the payslip exactly.

8. **The 15/07–14/08 period IS backfilled.** `/api/tat/archive?date=…&days=N`, a few days per
   request, `CRON_SECRET` in an `Authorization: Bearer` header. Watch
   `results[].pay.distances.api` — that is the billed-call count.

## Cannot be done from a restricted cloud session

The session this was built in had egress limited to the **Trusted** allowlist, which
refuses `docs.google.com`, `diag-logistics.vercel.app` and `*.supabase.co` with a 403
at CONNECT. That is why the migration was applied by hand, the backfill never ran, and
the roster header row above is still unread. A cloud environment set to **Custom** with
those three domains (plus the default package-manager list) removes all three
obstacles; a local terminal session has no such limit at all.
