/** Supabase shift sink. One transaction, with manual edits retained. */
function log(msg) {
  console.log(`[sink] ${msg}`);
}

export async function pushSupabase(records, range) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required; Sheet fallback is retired");
  }

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  const base = `${url.replace(/\/$/, "")}/rest/v1/rpc/replace_driver_shifts`;
  // One transaction: a failed batch cannot leave payroll without its schedule.
  const res=await fetch(base,{method:"POST",headers,signal:AbortSignal.timeout(60000),
    body:JSON.stringify({p_from:range.monthStart,p_to:range.monthEnd,rows:records})});
  if(!res.ok)throw new Error(`Supabase shift replacement HTTP ${res.status}: ${(await res.text()).slice(0,300)}`);
  const written=await res.json();log(`Supabase: synced ${written} rows; manual edits preserved`);
  return {written};
}
