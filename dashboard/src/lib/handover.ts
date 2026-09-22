// Paper-result handover: where a visit's hard copy goes.
//
// Labcenter staff type "Bản cứng kết quả gửi về D015" into the order's remark by
// template, but by hand — so read it loosely (D15, d 015, Đ015, D-015) and accept
// only codes that are real Diag branches. Two different codes are only resolved
// when one of them follows "về"; otherwise the remark is ambiguous and the caller
// falls back to the order's own branch.

import { DIAG_LOCATIONS } from "./diag-locations";

const KNOWN = new Set(DIAG_LOCATIONS.map((l) => l.name));
const CODE_RE = /(?<![\p{L}\d])[DĐ]\s*[-.]?\s*(\d{1,3})(?!\d)/giu;

const codesIn = (s: string) =>
  [...new Set([...s.matchAll(CODE_RE)].map((m) => "D" + m[1].padStart(3, "0")).filter((c) => KNOWN.has(c)))];

export function destFromRemark(remark: string | null | undefined): string | null {
  if (!remark) return null;
  const text = remark.normalize("NFC");
  const codes = codesIn(text);
  if (codes.length <= 1) return codes[0] ?? null;
  const after = text.split(/(?<!\p{L})(?:về|ve)(?!\p{L})/iu).slice(1).join(" ");
  const tail = codesIn(after);
  return tail.length === 1 ? tail[0] : null;
}

// ── Pasted rows ───────────────────────────────────────────────────────────────
// One line per row: a VID, optionally followed by a billing name (two columns
// copied from Excel arrive tab-separated). The same VID with two billing names
// is two rows. A line of bare VIDs ("a, b c") is one row per VID, blank billing.

export interface PasteLine { vid: string; billing: string }

const VID_RE = /\d{8,}/g;

export function parsePaste(text: string): PasteLine[] {
  const out: PasteLine[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const ids = line.match(VID_RE);
    if (!ids) continue;
    const rest = line.replace(VID_RE, "").replace(/^[\s,;|]+|[\s,;|]+$/g, "").replace(/\s+/g, " ");
    const entries = /\p{L}/u.test(rest) ? [{ vid: ids[0], billing: rest }] : ids.map((vid) => ({ vid, billing: "" }));
    for (const e of entries) {
      const key = `${e.vid}|${norm(e.billing)}`;
      if (!seen.has(key)) { seen.add(key); out.push(e); }
    }
  }
  return out;
}

const norm = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLowerCase().replace(/\s+/g, " ").trim();

/** Spacing is not meaningful in a test name: "Carrier Screening 18 **" is "…Screening 18**". */
const squash = (s: string) => norm(s).replace(/ /g, "");

/** Staff paste whole Excel rows, so the patient's own name often sits beside the test name — drop it. */
export function stripPatient(pasted: string, patient: string | null | undefined): string {
  const words = (patient ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return pasted;
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "iu");
  return pasted.replace(re, " ").replace(/^[\s,;|]+|[\s,;|]+$/g, "").replace(/\s+/g, " ");
}

/** True when the pasted text appears in one of the order's test names — billing_name, test_name or test_name_vi (case, accents and all spaces ignored). */
export function billingFound(pasted: string, names: string[]): boolean {
  const p = squash(pasted);
  return !!p && names.some((n) => squash(n).includes(p));
}
