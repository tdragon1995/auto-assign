/**
 * Move a formula from one row to another the way Sheets' own paste would:
 * every RELATIVE row reference shifts by the distance moved, `$`-anchored rows
 * and whole-column references (`J:J`) stay put.
 *
 * It exists because `copyPaste` is refused outright on any range with a row
 * hidden by a filter — and the config tab is filtered by hand most of the day,
 * with the blank rows new lines are written into being exactly the ones a
 * filter hides. Reading the source formula and writing the shifted text with
 * `updateCells` has no such restriction.
 *
 * Deliberately narrow: it refuses what it cannot shift with certainty (a whole-
 * ROW reference, a row pushed above row 1) rather than writing a formula that
 * quietly points somewhere else. `scripts/formula-shift.test.mts`.
 */
export function shiftFormulaRows(formula: string, delta: number): string {
  if (!formula.startsWith("=")) return formula;
  let out = "";
  let i = 0;
  const n = formula.length;
  while (i < n) {
    const ch = formula[i];
    // String literal: copied verbatim ("" is an escaped quote).
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (formula[j] === '"') { if (formula[j + 1] === '"') { j += 2; continue; } break; }
        j++;
      }
      out += formula.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // Quoted sheet name: copied verbatim ('' is an escaped quote). The reference
    // after its `!` is an ordinary token and shifts like any other.
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (formula[j] === "'") { if (formula[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      out += formula.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z0-9_.$]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_.$]/.test(formula[j])) j++;
      const token = formula.slice(i, j);
      let k = j;
      while (k < n && formula[k] === " ") k++;
      const next = formula[k];
      const prev = out.trimEnd().slice(-1);
      const m = /^(\$?[A-Za-z]{1,3}\$?)(\d+)$/.exec(token);
      if (m && next !== "(" && next !== "!") {
        // A1-style cell reference. A `$` right before the digits anchors the row.
        if (m[1].endsWith("$")) out += token;
        else {
          const row = Number(m[2]) + delta;
          if (row < 1) throw new Error(`công thức "${formula}" trỏ lên trên dòng 1 khi copy`);
          out += m[1] + row;
        }
      } else if (/^\$?\d+$/.test(token) && (next === ":" || prev === ":") && !token.includes(".")) {
        // `5:5` — a whole-row reference. Shifting it correctly needs to know
        // both ends; nothing in the config row uses one, so refuse rather than
        // guess.
        throw new Error(`công thức "${formula}" có tham chiếu cả dòng — không tự dời được`);
      } else {
        out += token;
      }
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
