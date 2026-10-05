/**
 * Pickup setup: what a pickup really takes vs the ETA the customer portal shows.
 *
 * Labcenter's pick-drop setup gives each client place a default drop-off and an
 * `estimate_pick_up`. Supabase `pickup_setup` is our MASTER copy of it: a change
 * is proposed here, approved by an admin or the daily check, pushed to Labcenter, read back, and
 * only then written to the master. Labcenter's live values are never stored —
 * drift is the two compared at read time.
 *
 * Cost shape (free tiers): only the daily gate uses Redis; no Cartrack call of its own (the
 * pickups come off the routes the archive already holds); the percentiles are a
 * Postgres view, so the dashboard pulls a few hundred rows rather than every
 * pickup; the report runs on demand and reliable increases are applied daily.
 */
import { isChamCong } from "./job-filters";
import { UUID } from "./master-reconcile";
import {
  getAdminToken, getCartrackCustomerId, listPickDropLocations, updatePickDropLocation,
  type PickDropRow,
} from "./labcenter";
import { isPlanStop } from "./smart-rank";
import { sbInsert, sbRpc, sbSelect, sbSelectAll, sbUpsert } from "./supabase-rest";
import { addDays, cartrackHistoryCutoff, vnDate } from "./time";
import type { TimelineRoute, TimelineStop } from "./types";

// -- Measured pickups --------------------------------------------------------

export interface PickupEtaRow {
  job_id: number;
  trip_date: string;
  pickup_customer_id: string;
  pickup_name: string | null;
  /** When the pickup was DUE, not when the job record was made. */
  scheduled_ts: string;
  arrived_ts: string;
  arrived_basis: "arrived" | "completed";
  has_window: boolean;
  /** The day the job's DROPOFF finished, or null when it did not finish that day.
   *  The view keeps only rows where this is the pickup's own day. */
  dropoff_date: string | null;
}

/** Cartrack's zone-less VN wall time -> an explicit +07:00 instant (same rule as
 *  tat.ts/pay.ts: left bare, Postgres would read it as UTC). */
function toIso(ts: string | null | undefined): string | null {
  if (!ts || typeof ts !== "string" || ts.length < 19) return null;
  return `${ts.slice(0, 10)}T${ts.slice(11, 19)}+07:00`;
}

/** Branch and 3PL pickups are internal transport, not a client asking. */
const INTERNAL_PICKUP = /^(BRA\s*-|3PL\b)/i;
const PICKUP_STOP = 1;
const DROPOFF_STOP = 2;
const COMPLETED = 5;

/** When each job's dropoff finished, across EVERY route of the day — a job's two
 *  stops are often worked by two drivers (collection, then the lab run), so a
 *  per-route pairing would call half of them next-day deliveries. A job missing
 *  here did not finish today at all, which is the case being excluded. */
function dropoffDayByJob(routes: TimelineRoute[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const route of routes) {
    for (const s of (route.orderedStops ?? []) as TimelineStop[]) {
      if (Number(s.stopTypeId) !== DROPOFF_STOP) continue;
      const done = toIso(s.activityCompletedTs);
      const jobId = Number(s.jobId);
      if (done && Number.isFinite(jobId)) out.set(jobId, done.slice(0, 10));
    }
  }
  return out;
}

/**
 * One row per completed ad-hoc client pickup, off the SAME routes the leg and pay
 * archives already fetched — no Cartrack call of its own. Checked field for field
 * against the REST job list on 698 of 699 pickups (2026-09-17): scheduled time,
 * arrival, customer, window flag and plan marker all identical.
 *
 * The clock starts when the pickup was DUE, not when the record was made. On the
 * scored population the two barely differ — 1 minute at both the median and the
 * 90th percentile, and only 18 of 1,136 rows more than an hour apart — because
 * the day-long gaps belong to WINDOWED bookings, which has_window already drops.
 * It is kept because those few outliers land on clients with a dozen pickups,
 * where one of them drags the p80; reading the timeline is the real gain.
 *
 * Skipped: plan stops (a recurring slot laid out overnight, not a request), chấm
 * công taps, and anything whose arrival is not on the scheduled day, which is a
 * parked job rather than a measurement.
 *
 * Windowed pickups and overnight jobs are KEPT, flagged by has_window and by a
 * dropoff_date that is not the pickup's day. The view drops both, so either rule
 * can be retuned without re-archiving.
 */
export function pickupEtaRows(routes: TimelineRoute[]): PickupEtaRow[] {
  const dropoffDay = dropoffDayByJob(routes);
  const out = new Map<number, PickupEtaRow>();
  for (const route of routes) {
    for (const s of (route.orderedStops ?? []) as TimelineStop[]) {
      if (Number(s.stopTypeId) !== PICKUP_STOP || Number(s.jobStatusId) !== COMPLETED) continue;
      if (isPlanStop(s) || isChamCong(s as unknown as { referenceNumber?: string | null; jobLabels?: unknown })) continue;
      if (!s.customerId || INTERNAL_PICKUP.test(s.customerName ?? "")) continue;
      const scheduled = toIso(s.scheduledDeliveryTs);
      const arrived = toIso(s.activityArrivedTs ?? s.activityCompletedTs);
      const jobId = Number(s.jobId);
      if (!scheduled || !arrived || !Number.isFinite(jobId)) continue;
      if (scheduled.slice(0, 10) !== arrived.slice(0, 10)) continue;
      out.set(jobId, {
        job_id: jobId,
        trip_date: arrived.slice(0, 10),
        pickup_customer_id: s.customerId,
        pickup_name: s.customerName ?? null,
        scheduled_ts: scheduled,
        arrived_ts: arrived,
        arrived_basis: s.activityArrivedTs ? "arrived" : "completed",
        has_window: (s.deliveryWindows?.length ?? 0) > 0,
        dropoff_date: dropoffDay.get(jobId) ?? null,
      });
    }
  }
  return [...out.values()];
}

export interface PickupEventRow extends Omit<PickupEtaRow, "scheduled_ts"> {
  scheduled_ts: string | null;
  pickup_completed_ts: string;
  is_eta_sample: boolean;
}

/** All completed pickup stops, including plans, unpaid jobs and split-driver jobs.
 * The existing table now serves both volume and ETA; job_id deduplicates routes. */
export function pickupEventRows(routes: TimelineRoute[], date: string): PickupEventRow[] {
  const eta = new Map(pickupEtaRows(routes).map(row => [row.job_id, row]));
  const dropoffDay = dropoffDayByJob(routes);
  const rows = new Map<number, PickupEventRow>();
  for (const route of routes) {
    for (const stop of (route.orderedStops ?? []) as TimelineStop[]) {
      const completed = toIso(stop.activityCompletedTs);
      const jobId = Number(stop.jobId);
      if (Number(stop.stopTypeId) !== PICKUP_STOP || !completed || completed.slice(0, 10) !== date ||
          !stop.customerId || !Number.isSafeInteger(jobId) || jobId <= 0 || isChamCong(stop)) continue;
      rows.set(jobId, {
        job_id: jobId, trip_date: date, pickup_customer_id: stop.customerId,
        pickup_name: stop.customerName ?? null,
        scheduled_ts: toIso(stop.scheduledDeliveryTs),
        arrived_ts: toIso(stop.activityArrivedTs) ?? completed,
        arrived_basis: stop.activityArrivedTs ? "arrived" : "completed",
        has_window: (stop.deliveryWindows?.length ?? 0) > 0,
        dropoff_date: dropoffDay.get(jobId) ?? null,
        pickup_completed_ts: completed, is_eta_sample: eta.has(jobId),
      });
    }
  }
  return [...rows.values()];
}

export async function archivePickupEvents(routes: TimelineRoute[], date: string): Promise<number> {
  if (date < cartrackHistoryCutoff()) return 0;
  const rows = pickupEventRows(routes, date);
  const stamp = new Date().toISOString();
  await sbUpsert("pickup_eta", rows.map(row => ({ ...row, archived_at: stamp })), "job_id");
  await sbRpc("refresh_pickup_volume_stats");
  return rows.length;
}

export interface PickupVolume {
  pickup_customer_id: string;
  total_pickups: number;
  average_per_day: number;
  period_from: string;
  period_to: string;
  calendar_days: number;
}

export async function loadPickupVolumes(): Promise<PickupVolume[]> {
  const read = () => sbSelectAll<PickupVolume>("pickup_volume_stats", "select=*", "pickup_customer_id.asc");
  const [rows,clients] = await Promise.all([read(),sbSelectAll<{customer_id:string}>("master_clients","select=customer_id","customer_id.asc")]);
  const represented = new Set(rows.map(r=>r.pickup_customer_id));
  if (rows[0]?.period_from === cartrackHistoryCutoff() && rows[0]?.period_to === addDays(vnDate(), -1)
      && clients.every(c=>represented.has(c.customer_id))) return rows;
  await sbRpc("refresh_pickup_volume_stats");
  return read();
}

// ── Proposals and drift (pure) ───────────────────────────────────────────────

export interface SetupRow {
  lc_location_id: number;
  pick_id: string | null;
  pick_name: string | null;
  drop_location_id: number;
  drop_id: string | null;
  drop_name: string | null;
  eta_mins: number;
}

export interface StatsRow { pickup_customer_id: string; n: number; median_mins: number; p80_mins: number; pickup_name?: string | null; sample_days?: number }

export interface EtaProposal {
  lc_location_id: number;
  drop_location_id: number;
  pick_name: string | null;
  drop_name: string | null;
  n: number;
  sample_days: number;
  median_mins: number;
  /** The time 8 in 10 pickups beat — what the proposal is based on. */
  p80_mins: number;
  current_mins: number;
  proposed_mins: number;
  /** (target − current) / current, e.g. 0.25 = the target is 25% above the ETA. */
  deviation: number;
}

export interface Drift {
  lc_location_id: number;
  pick_name: string | null;
  master: { drop_name: string | null; eta_mins: number };
  labcenter: { drop_name: string | null; eta_mins: number };
  conflicts?: { drop_name: string | null; eta_mins: number }[];
}

/** More than this far from the target, relative to the current ETA, is proposed.
 *  The target is the p80 rather than the median because the portal ETA is a
 *  PROMISE: set to the median it would be broken on half of all pickups. */
export const ETA_TOLERANCE = 0.1;
export const ETA_MIN = 5;
export const ETA_MAX = 480;

export const roundTo5 = (m: number) => Math.min(ETA_MAX, Math.max(ETA_MIN, Math.round(m / 5) * 5));

/**
 * What to promise: the p80, but never more than twice the typical pickup.
 *
 * Some clients are bimodal — one is served in 32 minutes four times out of five
 * and in six hours the rest of the time. Its raw p80 is 369, and promising that
 * describes no pickup anyone there has ever had. The cap keeps the promise near
 * the experience while still covering the ordinary spread; it bites on 56 of 289
 * clients. Where the MEDIAN itself is hours past due the target stays high, which
 * is correct — that client really is served hours late, and the panel shows both
 * numbers so the reader can see which of the two they are looking at.
 */
export function targetMins(medianMins: number, p80Mins: number): number {
  return Math.min(p80Mins, 2 * Math.max(medianMins, ETA_MIN));
}

/** The view already holds only clients with n > 5. A zero/blank ETA is always off. */
export function etaProposals(setup: SetupRow[], stats: StatsRow[]): EtaProposal[] {
  const byPick = new Map(stats.map((m) => [m.pickup_customer_id, m]));
  const out: EtaProposal[] = [];
  for (const s of setup) {
    const m = s.pick_id ? byPick.get(s.pick_id) : undefined;
    if (!m || !Number.isInteger(m.n) || m.n < 6 || !Number.isFinite(s.eta_mins) || s.eta_mins < 0) continue;
    const p80 = Number(m.p80_mins);
    if (!Number.isFinite(p80) || !Number.isFinite(Number(m.median_mins)) || Number(m.median_mins) <= 0 || p80 < Number(m.median_mins)) continue;
    const target = targetMins(Number(m.median_mins), p80);
    const deviation = s.eta_mins > 0 ? (target - s.eta_mins) / s.eta_mins : Infinity;
    if (Math.abs(deviation) <= ETA_TOLERANCE) continue;
    const proposed = roundTo5(target);
    if (proposed === s.eta_mins) continue;
    out.push({
      lc_location_id: s.lc_location_id, drop_location_id: s.drop_location_id, pick_name: s.pick_name, drop_name: s.drop_name,
      sample_days: m.sample_days ?? 0,
      n: m.n, median_mins: Number(m.median_mins), p80_mins: p80, current_mins: s.eta_mins, proposed_mins: proposed, deviation,
    });
  }
  return out.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));
}

/** Places Labcenter has and the master does not (adopt as-is), places where
 *  the two disagree, conflicting Labcenter records, and master rows whose
 *  NAMES are stale. Names are Labcenter's to own — a rename is not drift, so it
 *  is copied over silently; the setup values (drop, ETA) are never touched here. */
export function compareWithLabcenter(setup: SetupRow[], lc: PickDropRow[]): { adopt: PickDropRow[]; drift: Drift[]; renamed: SetupRow[] } {
  const master = new Map(setup.map((s) => [s.lc_location_id, s]));
  const lcDropName = new Map(lc.map((l) => [l.drop_location_id, l.drop_name]));
  const adopt: PickDropRow[] = [];
  const drift: Drift[] = [];
  const renamed: SetupRow[] = [];
  const groups = new Map<number, PickDropRow[]>();
  for (const l of lc) {
    const rows = groups.get(l.lc_location_id) ?? [];
    if (!rows.some(r => r.drop_location_id === l.drop_location_id && r.eta_mins === l.eta_mins)) rows.push(l);
    groups.set(l.lc_location_id, rows);
  }
  for (const rows of groups.values()) {
    const l = rows[0];
    const m = master.get(l.lc_location_id);
    if (rows.length > 1) {
      drift.push({lc_location_id:l.lc_location_id,pick_name:m?.pick_name ?? l.pick_name,
        master:{drop_name:m?.drop_name ?? null,eta_mins:m?.eta_mins ?? 0},
        labcenter:{drop_name:l.drop_name,eta_mins:l.eta_mins},
        conflicts:rows.map(r=>({drop_name:r.drop_name,eta_mins:r.eta_mins}))});
      continue;
    }
    if (!m) { adopt.push(l); continue; }
    const dropName = lcDropName.get(m.drop_location_id) ?? m.drop_name;
    if (m.pick_name !== l.pick_name || m.drop_name !== dropName) {
      m.pick_name = l.pick_name;
      m.drop_name = dropName;
      renamed.push(m);
    }
    if (m.drop_location_id !== l.drop_location_id || m.eta_mins !== l.eta_mins) {
      drift.push({
        lc_location_id: l.lc_location_id, pick_name: m.pick_name ?? l.pick_name,
        master: { drop_name: m.drop_name, eta_mins: m.eta_mins },
        labcenter: { drop_name: l.drop_name, eta_mins: l.eta_mins },
      });
    }
  }
  return { adopt, drift, renamed };
}

// ── IO ───────────────────────────────────────────────────────────────────────

const SETUP_COLS = "lc_location_id,pick_id,pick_name,drop_location_id,drop_id,drop_name,eta_mins";

export const loadSetup = () => sbSelectAll<SetupRow>("pickup_setup", `select=${SETUP_COLS}`, "lc_location_id");

async function adoptNew(rows: PickDropRow[]): Promise<void> {
  if (rows.length === 0) return;
  await sbUpsert("pickup_setup", rows.map((r) => ({
    lc_location_id: r.lc_location_id, pick_name: r.pick_name,
    drop_location_id: r.drop_location_id, drop_name: r.drop_name, eta_mins: r.eta_mins,
    pick_id: null, drop_id: null, updated_reason: "adopt",
  })), "lc_location_id");
}

/** Lookups per open beyond the priority set, and how many run at once. Each is
 *  one Labcenter call — waiting on the network, which Fluid does not bill. */
const RESOLVE_EXTRA_PER_OPEN = 25;
const RESOLVE_CONCURRENCY = 10;

async function inBatches<T>(items: T[], fn: (t: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += RESOLVE_CONCURRENCY) await Promise.all(items.slice(i, i + RESOLVE_CONCURRENCY).map(fn));
}

/**
 * Fill missing Cartrack ids. null = never asked; "" = asked, no Cartrack link
 * (so a handful of unlinked places cannot eat every open's budget).
 *
 * Places that HAVE pickup data go first and all at once — found by name, which
 * only decides the ORDER; proposals still join on the id. Everything else trickles
 * in 25 per open. Drop ids repeat (~46 PSCs), so each is asked once and shared.
 * ponytail: a failed HTTP call is also marked "" — the push path re-resolves
 * anything falsy, so the cost is that place missing from proposals.
 */
async function resolveIds(setup: SetupRow[], stats: StatsRow[], token: string): Promise<void> {
  const measured = new Set(stats.map((s) => s.pickup_name).filter(Boolean));
  const unresolved = setup.filter((s) => s.pick_id == null);
  const todo = [
    ...unresolved.filter((s) => measured.has(s.pick_name)),
    ...unresolved.filter((s) => !measured.has(s.pick_name)).slice(0, RESOLVE_EXTRA_PER_OPEN),
  ];
  const changed = new Set<SetupRow>();
  await inBatches(todo, async (s) => {
    s.pick_id = (await getCartrackCustomerId(s.lc_location_id, token)) ?? "";
    changed.add(s);
  });

  const dropIds = new Map<number, string>();
  for (const s of setup) if (s.drop_id != null) dropIds.set(s.drop_location_id, s.drop_id);
  const missingDrops = [...new Set(setup.filter((s) => s.drop_id == null).map((s) => s.drop_location_id))]
    .filter((d) => !dropIds.has(d));
  await inBatches(missingDrops, async (d) => { dropIds.set(d, (await getCartrackCustomerId(d, token)) ?? ""); });
  for (const s of setup) {
    if (s.drop_id == null && dropIds.has(s.drop_location_id)) { s.drop_id = dropIds.get(s.drop_location_id)!; changed.add(s); }
  }

  if (changed.size) {
    await sbUpsert("pickup_setup", [...changed].map((s) => ({
      lc_location_id: s.lc_location_id, pick_id: s.pick_id, drop_id: s.drop_id,
      drop_location_id: s.drop_location_id, eta_mins: s.eta_mins,
    })), "lc_location_id");
  }
}

export async function pickupSetupReport(): Promise<{ proposals: EtaProposal[]; drift: Drift[]; adopted: number; places: number }> {
  const token = await getAdminToken();
  if (!token) throw new Error("Labcenter login failed (LABCENTER_EMAIL/LABCENTER_PASSWORD)");
  const [lc, setup, stats] = await Promise.all([
    listPickDropLocations(token),
    loadSetup(),
    sbSelect<StatsRow>("pickup_eta_stats_30d", "select=*"),
  ]);
  const { adopt, drift, renamed } = compareWithLabcenter(setup, lc);
  await adoptNew(adopt);
  if (renamed.length) {
    await sbUpsert("pickup_setup", renamed.map((r) => ({
      lc_location_id: r.lc_location_id, pick_name: r.pick_name, drop_name: r.drop_name,
      drop_location_id: r.drop_location_id, eta_mins: r.eta_mins,
    })), "lc_location_id");
  }
  const all = [...setup, ...adopt.map((a) => ({ ...a, pick_id: null, drop_id: null }))];
  await resolveIds(all, stats, token);
  const conflicts = new Set(drift.filter(d=>d.conflicts).map(d=>d.lc_location_id));
  return { proposals: etaProposals(all.filter(s=>!conflicts.has(s.lc_location_id)), stats), drift, adopted: adopt.length, places: all.length };
}

export type SetupAction =
  | { action: "approve_eta"; lc_location_id: number; mins: number; basis_mins?: number; n?: number }
  | { action: "repush"; lc_location_id: number }
  | { action: "accept_lc"; lc_location_id: number };

/** The median must confirm the increase; a long tail alone cannot. */
export function canAutoUpdateEta(p: EtaProposal): boolean {
  return p.n >= 6 && p.sample_days >= 3 && p.current_mins > 0
    && p.deviation > ETA_TOLERANCE && p.proposed_mins > p.current_mins
    && p.median_mins > p.current_mins * (1 + ETA_TOLERANCE)
    && p.p80_mins <= 2 * Math.max(p.median_mins, ETA_MIN)
    && p.p80_mins <= ETA_MAX;
}

/** Bounded batches on the existing cron; failures wait until tomorrow, so one
 * broken location cannot prevent other locations from being corrected. */
export async function autoUpdatePickupEtas(skipIds: number[] = []) {
  const report = await pickupSetupReport();
  const blocked = new Set([...skipIds, ...report.drift.map(d => d.lc_location_id)]);
  const candidates = report.proposals.filter(p => canAutoUpdateEta(p) && !blocked.has(p.lc_location_id));
  const batch = candidates.slice(0, 10);
  const results = await Promise.all(batch.map(async p => {
    try {
      const result = await applySetupAction({ action: "approve_eta", lc_location_id: p.lc_location_id,
        mins: p.proposed_mins, basis_mins: p.p80_mins, n: p.n }, p);
      return { lc_location_id: p.lc_location_id, ...result };
    } catch (e) {
      return { lc_location_id: p.lc_location_id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }));
  return { remaining: candidates.length - batch.length, results };
}

/**
 * Apply one admin decision. Labcenter first, master second: a push that fails
 * or that Labcenter silently drops leaves BOTH copies as they were.
 */
export async function applySetupAction(a: SetupAction, automatic?: EtaProposal): Promise<{ ok: boolean; error?: string }> {
  const [m] = await sbSelect<SetupRow>("pickup_setup", `select=${SETUP_COLS}&lc_location_id=eq.${a.lc_location_id}`);
  if (!m) return { ok: false, error: "Không có địa điểm này trong bản gốc" };
  if (automatic && (!canAutoUpdateEta(automatic) || m.eta_mins !== automatic.current_mins || m.drop_location_id !== automatic.drop_location_id)) {
    return { ok: false, error: "Pickup setup changed; retry tomorrow" };
  }
  const token = await getAdminToken();
  if (!token) return { ok: false, error: "Labcenter login failed" };

  if (a.action === "accept_lc") {
    const source = (await listPickDropLocations(token, m.lc_location_id)).filter(r=>r.lc_location_id===m.lc_location_id);
    if (source.some(r=>r.drop_location_id!==source[0].drop_location_id || r.eta_mins!==source[0].eta_mins)) {
      return {ok:false,error:"Labcenter có nhiều điểm giao/ETA cho địa điểm này; cần xử lý bản ghi trùng trước khi đồng bộ"};
    }
    const lc = source[0];
    if (!lc) return { ok: false, error: "Labcenter không còn địa điểm này" };
    const dropChanged = lc.drop_location_id !== m.drop_location_id;
    const dropId = dropChanged ? await getCartrackCustomerId(lc.drop_location_id,token) : m.drop_id;
    await commitPickupSetup({...m,drop_location_id:lc.drop_location_id,drop_name:lc.drop_name,
      drop_id:dropId,eta_mins:lc.eta_mins},"accept_lc",m);
    return { ok: true };
  }

  const mins = a.action === "approve_eta" ? Math.round(a.mins) : m.eta_mins;
  if (!(mins >= ETA_MIN && mins <= ETA_MAX)) return { ok: false, error: `ETA phải trong ${ETA_MIN}–${ETA_MAX} phút` };
  const pickId = m.pick_id || await getCartrackCustomerId(m.lc_location_id, token);
  const dropId = m.drop_id || await getCartrackCustomerId(m.drop_location_id, token);
  if (!pickId || !dropId || !UUID.test(pickId) || !UUID.test(dropId)) return { ok: false, error: "Không tìm được mã Cartrack của địa điểm" };
  const ids = [...new Set([pickId,dropId])];
  const known = await sbSelect<{customer_id:string}>("master_clients",`select=customer_id&customer_id=in.(${ids.join(",")})`);
  if (known.length !== ids.length) return {ok:false,error:"Địa điểm chưa có trong Master — đồng bộ trước khi duyệt ETA"};

  const pushed = await updatePickDropLocation(
    { pickId, dropId, etaMins: mins, lcLocationId: m.lc_location_id, dropLocationId: m.drop_location_id,
      expectedEtaMins: automatic ? m.eta_mins : undefined }, token);
  if (!pushed.ok) return pushed;

  await commitPickupSetup({...m,pick_id:pickId,drop_id:dropId,eta_mins:mins},a.action,m,
    a.action === "approve_eta" ? a.basis_mins : undefined, a.action === "approve_eta" ? a.n : undefined);
  return { ok: true };
}

export async function commitPickupSetup(row:SetupRow,kind:"accept_lc"|"approve_eta"|"repush"|"client_edit",previous:SetupRow|null,basis?:number,n?:number) {
  const expected = previous ? {drop_location_id:previous.drop_location_id,eta_mins:previous.eta_mins,
    drop_id:previous.drop_id,pick_id:previous.pick_id} : null;
  await sbRpc("commit_pickup_setup",{item:{...row,kind,basis_mins:basis??null,n:n??null},expected});
}
