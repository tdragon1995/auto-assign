# Driver TAT (Hiệu Suất)

A durable archive of every driver's day, and the plain-language report each driver
reads from it in `/cham-cong`.

## Why it exists

The day's routes already live in Redis (`day:v1:*`, `dashboard/src/lib/day-snapshot.ts`),
but that hash has a **900-second TTL** — it is a cache for today's operational reads,
not a record. Once a day passed, nothing in the system remembered it, so there was no
trend, no week-on-week comparison and nothing to ground an appraisal conversation in.

## The unit is a LEG, not a job

A driver's day is a sequence of stops. The thing that takes time and can be measured
against a distance is the ride **between two consecutive stops**.

That is not the same as a job's pickup→dropoff pair. A driver who collects at three
clinics before running to the lab rides three legs; the job-shaped view would instead
see three "trips" that each begin somewhere the driver had already left, and would
charge them for distance they never covered on that leg.

Legs are cut from the order the driver **actually worked** — stops sorted by their
completion time — not the planned `orderedStops` sequence. Re-sequencing a run is
normal, and measuring against pairs nobody rode would be meaningless.

Attendance stops (`Chấm Công -`) are dropped before the cut. Their completion stamp
is when a button was tapped, not when a vehicle left a place; a check-out tapped from
home would splice a phantom ride across the city into the day.

## The clock

```
tat_mins = arrival at the next stop − completion at this one
```

Time on the road. Loading, queueing and paperwork at either end sit outside it,
because they are neither the driver's choice nor their pace.

Drivers who never tap "đã đến" would otherwise have no measurable legs at all, so the
archiver falls back to the next stop's **completion** stamp and records which was used
in `tat_basis`. The UI marks those with `≈` and a one-line explanation, so an inferred
leg can always be told from a measured one.

## The target

```
target_mins = max(1, ceil(distance_km)) × 4
```

An effective 15 km/h. That sounds slow read as a speed and is not, once HCMC traffic,
lights, parking and the walk into a clinic are all inside the same number. The ceiling
is on whole kilometres so a driver can check the target in their head: 7 km → 28 minutes.
The `max(1, …)` floor stops two stops at one address from getting a 0-minute target
that nothing could meet.

Tune it by changing `MINS_PER_KM` in `dashboard/src/lib/tat.ts`. **Changing it does not
rewrite history** — `distance_km` and `target_mins` are frozen onto each row at archive
time, because a report is a record of what the driver was measured against on the day.

### Long gaps

A leg spanning a lunch break or a long wait at a clinic is real elapsed time but not a
slow ride. Legs running more than `LONG_GAP_OVER_TARGET_MINS` (45) past target are
flagged `long_gap`, shown as "Chờ / nghỉ", and **excluded from the on-time percentage
and the average** — they still appear in the list and in the leg count.

Without this, one lunch break lands as "trễ 130 phút" and every driver learns on day one
that the report does not describe their work, which costs more than the metric is worth.

## Distances

Resolved through `roadDistancesForPairs` (`dashboard/src/lib/distance-cache.ts`): the
whole day's pairs go in one call, deduped, answered from the **non-expiring** Redis
cache before Goong is touched. A fleet riding the same branch↔lab legs daily converges
on a warm cache within days, after which archiving a day costs **zero Goong requests**.
Only genuinely new pairs are billed, and each is billed once, ever.

Legs whose stops carry no coordinates are left ungraded rather than haversined — an
ungraded leg is honest; one graded against a straight-line guess is not.

## Storage

`public.tat_legs`, plus the `v_tat_daily` rollup view used by the week and month spans
so they read ~20 numbers instead of ~600 rows. RLS is on with **no policies**: only the
service-role key reaches the table, and drivers read their own rows through an endpoint
that takes their id from a signed cookie.

The archiver **replaces** a day (delete then insert) rather than upserting. A leg is
identified by the two stops it joins, and those pairs change between runs — a driver
completing one more stop re-cuts the tail of their day — so an upsert would leave the
previous pairing behind as a duplicate phantom leg.

Size: roughly 600 legs/day × ~250 bytes ≈ 150 KB/day, about 55 MB/year. Comfortable
inside the Supabase free tier.

### Which project

TAT lives in its **own** Supabase project, `odbmfkzkipklepmghjwj` — not the
`qudnkxivfgntwvmydpkt` "Auto-assign Config" project that `misa-fetcher` writes
`driver_shifts` into and the `training/` app uses.

They can sit apart because `tat_legs` carries **no foreign keys** into the config
schema: driver identity is a bare `uuid` column matching Cartrack's
`delivery_driver_id`, and stop identity is a bare `text` customer id. Nothing here
joins to `drivers` or `locations`.

The dashboard's `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` therefore
point at the **TAT** project. When phase 3 wires the config store into the dashboard
it will need its own variables — repointing these would take TAT's database away.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /api/tat/archive` | Archive a day. `?date=YYYY-MM-DD` (default today VN), `?days=N` to backfill N days ending at `date`, `?env=prod\|uat`. Auth: `CRON_SECRET` as `Authorization: Bearer` or `x-cron-secret`; open when the variable is unset. Idempotent. |
| `GET /api/tat/me` | The signed-in driver's report — today's legs plus week, previous-week and month rollups. Driver id comes from the `nv_session` cookie, **never** from the request. |

`/api/tat/me` serves from the archive immediately and queues a refresh via `after()`
when today's rows are more than 15 minutes old, so a driver never waits on a Cartrack
fetch. The response carries `updated_at` and `refreshing`, and the tab re-fetches once
after 12 seconds when a refresh was queued.

## What triggers an archive

**There is no separate cron for this.** Two triggers cover the whole timeline, and
between them nothing is ever lost:

| When | What | Trigger |
|---|---|---|
| Finished days | Sealed once, permanently | `archiveSealedDays()` in `/api/assign/cron` |
| Today | Refreshed on demand, ≤15 min stale | `after()` in `/api/tat/me` |

The seal hangs off the assign cron because a day only stops changing once it is over,
and that cron is already pinging every few minutes. A second external schedule would be
a second thing to configure, a second thing to forget, and a second single point of
failure.

It is registered **before** the arm check, so it still runs on the overnight pings that
return `{skipped:"disarmed"}`. Those pings do almost nothing, which makes them the
cheapest moment of the day to spend on a day-fetch — and by then the day being sealed is
genuinely finished. A Redis key (`tat:sealed:<env>:<date>`, 7-day TTL) makes it a no-op
on every other ping.

It walks back `TAT_LOOKBACK_DAYS` (3), **oldest first, one day per ping**, so a stretch
of missed days fills in order over a few minutes rather than firing a burst at Cartrack.
The seal is claimed before the work and released if the archive fails, so a failed day
is retried on the next ping instead of being silently lost.

Because it runs in `after()` and never throws, a reporting failure cannot delay or break
an assign cycle.

Covered by `dashboard/scripts/tat-seal.test.mts`:

```bash
node scripts/redis-stub.mjs & npx tsx scripts/tat-seal.test.mts
```

## Setup

1. **Apply the migration** — `supabase/migrations/20260812090000_tat_legs.sql` against
   project **`odbmfkzkipklepmghjwj`**. It creates `tat_legs` and `v_tat_daily` and
   depends on nothing else, so it applies cleanly to an empty project.
2. **Set the env vars** in Vercel (and `dashboard/.env.local` for local work):
   `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Without them the tab shows
   "chưa được cấu hình" rather than failing, and the seal pass is a silent no-op.
3. **Backfill** what Cartrack still holds, once, by hand:
   `GET /api/tat/archive?date=<yesterday>&days=31` with the `x-cron-secret` header. Runs
   sequentially; this first pass is the expensive one for Goong, and every later run
   rides the warm cache. Anything longer than the 3-day lookback is this endpoint's job,
   not the seal pass's.

## Where the code lives

| File | Role |
|---|---|
| `dashboard/src/lib/tat.ts` | Cutting routes into legs, the clock, the target, rollups |
| `dashboard/src/lib/tat-archive.ts` | Fetch → price → replace a day in Supabase |
| `dashboard/src/lib/supabase-rest.ts` | PostgREST over `fetch` (no SDK dependency) |
| `dashboard/src/app/api/tat/archive/route.ts` | Manual/backfill entry point |
| `dashboard/src/app/api/assign/cron/route.ts` | Hosts the once-a-day seal pass |
| `dashboard/src/app/api/tat/me/route.ts` | The driver's own report |
| `dashboard/src/app/cham-cong/page.tsx` | The **Hiệu Suất** tab |
