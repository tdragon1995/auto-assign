/**
 * Consolidated month view: one row per person, one column per day — the shape a
 * supervisor actually reads a roster in, instead of 2,600 flat rows.
 *
 * Emits values + a parallel background matrix so the Apps Script side stays a
 * dumb writer and every colour decision lives here.
 */

// Sunday-first, matching Date#getUTCDay()
const VN_DOW = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

const COLORS = {
  header: "#d9d9d9",
  weekend: "#efefef",
  working: null, // default white
  off: "#f3f3f3",
  holiday: "#fce8b2",
  leave: "#cfe2f3",
  gap: "#f4b8b8",
  name: "#ffffff",
};

/**
 * Driver labels carry a routing prefix and the employee code
 * ("P - P - PT101734 Nguyễn Hữu Lợi"). The grid already has a Mã NV column, so
 * the prefix is repetition that pushes the actual name out of view. MISA rows
 * arrive as a bare name, so stripping this makes both sources read alike.
 */
function displayName(rec) {
  const raw = rec.full_name || rec.label || "";
  return raw.replace(/^[A-Za-z]+\s*-\s*[A-Za-z]+\s*-\s*\S+\s+/, "").trim() || raw;
}

/** "06:00" → "6", "12:30" → "12:30" — drop the noise, keep the information. */
function compactTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":");
  const hh = String(Number(h));
  return m === "00" ? hh : `${hh}:${m}`;
}

function shiftLabel(rec) {
  if (rec.day_type === "holiday") return rec.holiday_name || "Lễ";
  if (rec.day_type === "off") return "";
  const s = compactTime(rec.start_time);
  const e = compactTime(rec.end_time);
  return s && e ? `${s}-${e}` : s || e || "✓";
}

function daysInRange(range) {
  const out = [];
  const end = new Date(range.monthEnd + "T00:00:00Z");
  for (let d = new Date(range.monthStart + "T00:00:00Z"); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push({ date: d.toISOString().slice(0, 10), dow: d.getUTCDay(), day: d.getUTCDate() });
  }
  return out;
}

/**
 * Build the grid.
 *
 * @param records    merged shift records (MISA + part-time patterns)
 * @param range      month range from monthRange()
 * @param sheetLeave Map "label|date" → leave tag, from the Nghỉ phép tab. Covers
 *                   people MISA knows nothing about, and keeps the grid aligned
 *                   with what the assign engine actually reads.
 */
export function buildGrid(records, range, sheetLeave = new Map()) {
  const days = daysInRange(range);

  // Group by person. Multi-shift days keep the earliest start for the cell; the
  // flat tab carries every slot.
  const people = new Map();
  for (const r of records) {
    const key = r.employee_code || r.full_name;
    if (!people.has(key)) {
      people.set(key, {
        code: r.employee_code,
        name: displayName(r),
        // The Nghỉ phép tab keys leave by the full Driver label, so matching
        // must use that — never the display name, which differs per source.
        label: r.label || r.full_name,
        source: r.source || "MISA",
        byDate: new Map(),
      });
    }
    const p = people.get(key);
    if (!p.label && r.label) p.label = r.label;
    const prev = p.byDate.get(r.shift_date);
    if (!prev || (r.slot ?? 1) < (prev.slot ?? 1)) p.byDate.set(r.shift_date, r);
  }

  const header = ["Nhân viên", "Mã NV", "Nguồn"];
  const headerBg = [COLORS.header, COLORS.header, COLORS.header];
  for (const d of days) {
    header.push(`${d.day}\n${VN_DOW[d.dow]}`);
    headerBg.push(d.dow === 0 ? COLORS.weekend : COLORS.header);
  }
  header.push("Ngày công");
  headerBg.push(COLORS.header);

  const values = [header];
  const backgrounds = [headerBg];

  const sorted = [...people.values()].sort((a, b) =>
    (a.name || "").localeCompare(b.name || "", "vi"),
  );

  for (const p of sorted) {
    const row = [p.name, p.code || "", p.source];
    const bg = [COLORS.name, COLORS.name, COLORS.name];
    let workDays = 0;

    for (const d of days) {
      const rec = p.byDate.get(d.date);
      const sheetLv = sheetLeave.get(`${p.label}|${d.date}`);

      if (!rec) {
        row.push("");
        bg.push(d.dow === 0 ? COLORS.weekend : COLORS.off);
        continue;
      }

      const onLeave = Boolean(rec.leave_start) || Boolean(sheetLv);
      let text = shiftLabel(rec);
      let colour;

      if (rec.leave_gap) {
        // Away on leave but rostered, with nothing deducted — needs a human.
        text = `⚠${text}`;
        colour = COLORS.gap;
      } else if (onLeave && rec.day_type === "working") {
        text = "P";
        colour = COLORS.leave;
      } else if (rec.day_type === "holiday") {
        colour = COLORS.holiday;
      } else if (rec.day_type === "off") {
        colour = d.dow === 0 ? COLORS.weekend : COLORS.off;
      } else {
        colour = COLORS.working;
        workDays++;
      }
      if (rec.leave_gap) workDays++; // still rostered, still counts as a planned day

      row.push(text);
      bg.push(colour);
    }

    row.push(workDays);
    bg.push(COLORS.name);
    values.push(row);
    backgrounds.push(bg);
  }

  // 4, not 3: the sheet-side legend spans columns B–D, and Sheets refuses a
  // merge that straddles the frozen/non-frozen boundary. Freezing through D
  // keeps it inside, and pinning one day column costs nothing.
  return { values, backgrounds, frozenRows: 1, frozenCols: 4 };
}
