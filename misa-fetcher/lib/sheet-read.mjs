/** Source readers for the MISA pipeline. Non-Sunday data is Supabase-owned. */
export const PT_PATTERN_SHEET = "Mẫu ca PT (Supabase)";
async function select(table,query,order) {
 const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!url||!key)throw new Error("Supabase credentials required; Sheet fallback is retired");
 const rows=[];
 for(let offset=0;;offset+=1000){
  const res=await fetch(`${url.replace(/\/$/,"")}/rest/v1/${table}?${query}&order=${order}&limit=1000&offset=${offset}`,{headers:{apikey:key,Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(20000)});
  if(!res.ok)throw new Error(`Supabase ${table} HTTP ${res.status}`);
  const batch=await res.json();rows.push(...batch);if(batch.length<1000)return rows;
 }
}



/**
 * The Driver tab: the bridge between MISA and Cartrack. `employee_code` holds
 * the MISA code (DC…/PT…), `Driver` is the label the Nghỉ phép sheet's
 * xlookup resolves to a driver_id, and `delivery_driver_id` is the Cartrack UUID.
 */
export async function loadDrivers() {
  const rows=await select("master_drivers","select=driver_id,first_name,last_name,is_active,roster","driver_id.asc");
  return rows.map(r=>({label:r.roster?.Driver || `${r.first_name??""} ${r.last_name??""}`.trim(),
    driver_id:r.driver_id,employee_code:r.roster?.employee_code || `driver:${r.driver_id}`,
    employee_name:r.roster?.employee_full_name || r.last_name || "",active:r.is_active!==false}));
}

/** employee_code → driver row, active drivers only (a deactivated account can
 *  never take a job, so it has no place on a roster). */
export function driversByEmployeeCode(drivers) {
  const map = new Map();
  for (const d of drivers) {
    if (!d.employee_code || !d.active) continue;
    if (!map.has(d.employee_code)) map.set(d.employee_code, d);
  }
  return map;
}

/**
 * Weekly recurring patterns for staff with no MISA shift data (part-timers who
 * have no AMIS access). One column per weekday holding "HH:MM-HH:MM" or
 * blank/OFF.
 *
 * Effective-dated, so a person can have several rows: `active_from` is the day
 * the pattern takes effect and `active_to` the last day it applies (blank =
 * still current). Changing someone's hours means adding a row, not editing the
 * old one — which keeps the history and lets a change be entered ahead of time.
 * A blank `active_from` means "always", so a single-row-per-person sheet works
 * unchanged.
 *
 * Unlinked patterns remain visible for review and are not expanded.
 */
export async function loadPtPatterns() {
  const rows=await select("driver_shift_patterns","select=employee_code,label,days,active_from,active_to,note,driver_id,review_issues&active=eq.true","id.asc");
  return rows.filter(r=>r.review_issues.length===0 && r.days.some(Boolean)).map(r=>({
    label:r.label,employee_code:r.employee_code,days:r.days,active_from:r.active_from,active_to:r.active_to,note:r.note,driver_id:r.driver_id}));
}

/** The pattern in force for `date`: latest active_from that has started and has
 *  not been superseded or ended. Null when the person isn't rostered that day. */
function patternOn(versions, date) {
  let best = null;
  for (const v of versions) {
    if (v.active_from && date < v.active_from) continue; // not started yet
    if (v.active_to && date > v.active_to) continue; // already ended
    if (!best) {
      best = v;
      continue;
    }
    // Later start wins; a dated row beats an undated "always" row.
    const a = v.active_from ?? "";
    const b = best.active_from ?? "";
    if (a >= b) best = v;
  }
  return best;
}

/**
 * Expand weekly patterns into the same per-day record shape MISA produces, for
 * every date in the month. People already covered by MISA are skipped —
 * `skipCodes` carries their employee codes so a person who exists in both
 * sources is not rostered twice.
 */
export function expandPtPatterns(patterns, range, skipCodes = new Set()) {
  // Group a person's pattern versions together.
  const byPerson = new Map();
  for (const p of patterns) {
    const key = p.employee_code || p.label;
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key).push(p);
  }

  const records = [];
  const start = new Date(range.monthStart + "T00:00:00Z");
  const end = new Date(range.monthEnd + "T00:00:00Z");

  for (const [key, versions] of byPerson) {
    if (skipCodes.has(key)) continue;
    const label = versions[0].label;
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const date = d.toISOString().slice(0, 10);
      const p = patternOn(versions, date);
      if (!p) continue; // before they started, or after they left — no row at all
      const win = p.days[d.getUTCDay()];
      records.push({
        employee_code: p.employee_code || label,
        driver_id: p.driver_id ?? null,
        full_name: label,
        label, // canonical Driver-tab label, for leave matching

        shift_date: date,
        slot: 1,
        day_type: win ? "working" : "off",
        start_time: win ? win.start : null,
        end_time: win ? win.end : null,
        holiday_name: null,
        leave_start: null,
        leave_end: null,
        leave_gap: false,
        source: "PT",
      });
    }
  }
  return records;
}

/**
 * Leave already recorded in the Nghỉ phép tab — the engine's actual source of
 * truth. Used to overlay leave onto the grid for everyone, including part-timers
 * MISA knows nothing about. Returns a Map of "label|YYYY-MM-DD" → leave label.
 */
export async function loadSheetLeave() {
  const stored=await select("master_leave_read","select=linked_driver_id,starts_on,ends_on,starts_at,ends_at,leave_type,row_data&active=eq.true","id.asc");
  const drivers=await loadDrivers(),names=new Map(drivers.map(d=>[d.driver_id,d.label]));
  const rows=stored.map(r=>({...r.row_data,driver:names.get(r.linked_driver_id)||r.row_data.driver,
    leave_from:r.starts_on||r.row_data.leave_from,leave_to:r.ends_on||r.row_data.leave_to,
    leave_from_hr:r.starts_at?.slice(0,5)||"",leave_to_hr:r.ends_at?.slice(0,5)||"","Loại Nghỉ":r.leave_type}));
  const map = new Map();
  for (const r of rows) {
    const label = (r["driver"] || "").trim();
    const from = (r["leave_from"] || "").trim();
    if (!label || !/^\d{4}-\d{2}-\d{2}$/.test(from)) continue;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(r["leave_to"] || "") ? r["leave_to"].trim() : from;
    const type = (r["Loại Nghỉ"] || "").trim();
    const hrFrom = (r["leave_from_hr"] || "").trim();
    const hrTo = (r["leave_to_hr"] || "").trim();
    const tag = hrFrom && hrTo ? `${hrFrom}-${hrTo}` : type || "Nghỉ";

    // "Nghỉ việc" is open-ended (resigned) — cap the walk at the month end.
    const end = type === "Nghỉ việc" ? to : to;
    for (let d = new Date(from + "T00:00:00Z"), i = 0; i < 400; d.setUTCDate(d.getUTCDate() + 1), i++) {
      const ds = d.toISOString().slice(0, 10);
      if (ds > end) break;
      map.set(`${label}|${ds}`, tag);
    }
  }
  return map;
}
