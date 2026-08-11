/**
 * Output sinks: Supabase (driver_shifts table) and the Google Sheet
 * ("Driver Shift" tab, via an Apps Script web-app endpoint).
 *
 * Each sink is optional — it runs only when its env vars are present, so the
 * pipeline degrades gracefully while pieces are still being set up.
 */

function log(msg) {
  console.log(`[sink] ${msg}`);
}

/**
 * Replace the current month in public.driver_shifts: delete the month's rows,
 * then bulk-insert the fresh batch (mirrors the sheet's clear-and-rewrite).
 */
export async function pushSupabase(records, range) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    log("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping Supabase");
    return { skipped: true };
  }

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };
  const base = `${url.replace(/\/$/, "")}/rest/v1/driver_shifts`;

  const del = await fetch(
    `${base}?shift_date=gte.${range.monthStart}&shift_date=lte.${range.monthEnd}`,
    { method: "DELETE", headers },
  );
  if (!del.ok) {
    throw new Error(`Supabase delete failed (HTTP ${del.status}): ${(await del.text()).slice(0, 300)}`);
  }

  const BATCH = 500;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const ins = await fetch(base, { method: "POST", headers, body: JSON.stringify(batch) });
    if (!ins.ok) {
      throw new Error(`Supabase insert failed (HTTP ${ins.status}): ${(await ins.text()).slice(0, 300)}`);
    }
  }
  log(`Supabase: replaced ${range.monthStart}..${range.monthEnd} with ${records.length} rows`);
  return { written: records.length };
}

/** POST a payload to the Apps Script web app that owns the sheet writes. */
async function callWebApp(payload) {
  const url = process.env.SHEET_WEBAPP_URL;
  const token = process.env.SHEET_WEBAPP_TOKEN;
  if (!url || !token) {
    log("SHEET_WEBAPP_URL / SHEET_WEBAPP_TOKEN not set — skipping Google Sheet");
    return null;
  }

  // Apps Script web apps reply via a 302 to script.googleusercontent.com;
  // fetch follows it automatically.
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...payload }),
  });
  const text = await resp.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* HTML error page from Apps Script — surfaced below */
  }
  if (!resp.ok || !data?.ok) {
    throw new Error(
      `Sheet web app failed (HTTP ${resp.status}): ${data?.error || text.slice(0, 300)}`,
    );
  }
  return data;
}

/** The flat one-row-per-day tab ("Driver Shift"). */
export async function pushSheet(sheetRows) {
  const data = await callWebApp({ action: "shifts", rows: sheetRows });
  if (!data) return { skipped: true };
  log(`Google Sheet: wrote ${data.written} rows to "${data.sheet}"`);
  return data;
}

/** The consolidated month grid ("Lịch Ca"). */
export async function pushGrid(grid, range) {
  const data = await callWebApp({
    action: "grid",
    month:
      range.monthStart.slice(0, 7) === range.monthEnd.slice(0, 7)
        ? range.monthStart.slice(0, 7)
        : `${range.monthStart.slice(0, 7)} → ${range.monthEnd.slice(0, 7)}`,
    values: grid.values,
    backgrounds: grid.backgrounds,
    frozenRows: grid.frozenRows,
    frozenCols: grid.frozenCols,
  });
  if (!data) return { skipped: true };
  log(`Google Sheet: wrote grid ${data.rows}×${data.cols} to "${data.sheet}"`);
  return data;
}
