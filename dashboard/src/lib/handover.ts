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
