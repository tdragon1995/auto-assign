/**
 * Minimal Supabase (PostgREST) access over plain fetch.
 *
 * WHY NOT @supabase/supabase-js
 *   The dashboard's every other external system — Cartrack REST, Cartrack
 *   JSON-RPC, Labcenter, Goong, Zalo — is a hand-rolled fetch wrapper, and the
 *   two calls this module needs (select with filters, upsert on conflict) are a
 *   query string and a header. The SDK would add a dependency and a lockfile
 *   change for that. misa-fetcher/lib/sinks.mjs already writes driver_shifts
 *   this exact way in CI, so the pattern is proven against this project.
 *
 * SERVER ONLY. SUPABASE_SERVICE_ROLE_KEY bypasses RLS, so importing this into a
 * client component would ship a key that can read and write every table. Every
 * caller here is a route handler that derives its own authorization first.
 */

const REST_TIMEOUT_MS = 15_000;

function creds(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

/** Whether Supabase is configured at all. Callers degrade to a clear "chưa cấu
 *  hình" message rather than throwing, so a missing env var reads as a setup
 *  step instead of a 500. */
export function supabaseConfigured(): boolean {
  return creds() !== null;
}

function headers(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function request(path: string, init: RequestInit): Promise<Response> {
  const c = creds();
  if (!c) throw new Error("Supabase not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");

  // PostgREST has no server-side statement timeout on the free tier, so a bad
  // query would otherwise hold a serverless invocation open until the platform
  // kills it — billed the whole time.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REST_TIMEOUT_MS);
  try {
    const res = await fetch(`${c.url}/rest/v1/${path}`, {
      ...init,
      headers: headers(c.key, (init.headers as Record<string, string>) ?? {}),
      signal: ac.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`Supabase ${init.method ?? "GET"} ${path} failed (HTTP ${res.status}): ${body}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** SELECT. `query` is a raw PostgREST query string, e.g.
 *  `select=*&driver_id=eq.<uuid>&trip_date=gte.2026-08-01&order=trip_date.desc`. */
export async function sbSelect<T>(table: string, query: string): Promise<T[]> {
  const res = await request(`${table}?${query}`, { method: "GET" });
  return (await res.json()) as T[];
}

/** DELETE by filter, e.g. `trip_date=eq.2026-08-12`.
 *
 *  PostgREST will happily delete a whole table if handed an empty filter, so a
 *  filter is required rather than defaulted — the one guardrail that stops a
 *  malformed date from erasing the archive. */
export async function sbDelete(table: string, filter: string): Promise<void> {
  if (!filter.trim()) throw new Error("sbDelete requires a filter — refusing to delete an entire table");
  await request(`${table}?${filter}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
}

/** INSERT rows, batched. */
export async function sbInsert(
  table: string,
  rows: Record<string, unknown>[],
  batchSize = 500,
): Promise<number> {
  for (let i = 0; i < rows.length; i += batchSize) {
    await request(table, {
      method: "POST",
      body: JSON.stringify(rows.slice(i, i + batchSize)),
      headers: { Prefer: "return=minimal" },
    });
  }
  return rows.length;
}

/** UPSERT. `onConflict` names the conflict target column(s); rows colliding on it
 *  are merged rather than rejected, which is what makes the archiver safe to run
 *  repeatedly against a day that is still in progress.
 *
 *  Batched because PostgREST holds the whole body in memory and a full day of a
 *  42-location network is several hundred rows. */
export async function sbUpsert(
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  batchSize = 500,
): Promise<number> {
  if (rows.length === 0) return 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    await request(`${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
      method: "POST",
      body: JSON.stringify(rows.slice(i, i + batchSize)),
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    });
  }
  return rows.length;
}
