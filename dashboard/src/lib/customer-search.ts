/**
 * Client search for /qr "Giao Kết Quả / Vật Tư". Accent-insensitive, and ranked so
 * what was typed AS A PHRASE comes first: "tri phuong" is a street, and matching each
 * word anywhere put "TRỊNH Hoài Đức, PHƯỜNG Mỹ Tho" at the top.
 */
import { foldName } from "./driver-cell";

export interface Customer { customer_id: string; customer_name: string; address_line_1?: string | null }

/** Folded and padded so " word" finds a word start. Punctuation becomes a "|" so a
 *  phrase never runs across it: "Nguyễn Gia Trí, Phường 25" is not "tri phuong". */
export const searchKey = (s: string) =>
  ` ${foldName(s).replace(/[^a-z0-9\s]+/g, " | ").replace(/\s+/g, " ").trim()} `;

/** Cartrack marks a retired customer by prefixing its name; never deliver to one. */
export const isInactive = (c: Customer) => /^\s*\{inactive\}/i.test(c.customer_name);

export interface Indexed extends Customer { nameKey: string; addrKey: string }
export const indexCustomer = (c: Customer): Indexed =>
  ({ ...c, nameKey: searchKey(c.customer_name), addrKey: searchKey(c.address_line_1 ?? "") });

/**
 * 0 phrase in the name · 1 phrase in the address · 2 every word starts a word of the
 * name · 3 every word starts a word somewhere · otherwise no match.
 */
function score(c: Indexed, phrase: string, words: string[]): number | null {
  if (c.nameKey.includes(phrase)) return 0;
  if (c.addrKey.includes(phrase)) return 1;
  if (words.every((w) => c.nameKey.includes(w))) return 2;
  if (words.every((w) => c.nameKey.includes(w) || c.addrKey.includes(w))) return 3;
  return null;
}

export function rankCustomers(all: Iterable<Indexed>, q: string, limit = 15): Customer[] {
  const key = searchKey(q).trim();
  if (key.replace(/ /g, "").length < 2) return [];
  const phrase = ` ${key}`;
  const words = key.split(" ").map((w) => ` ${w}`);
  const hits: { c: Indexed; s: number }[] = [];
  for (const c of all) {
    if (isInactive(c)) continue;
    const s = score(c, phrase, words);
    if (s !== null) hits.push({ c, s });
  }
  // Once the phrase is found anywhere, scattered-word matches are noise, not options.
  const phraseHit = hits.some((h) => h.s <= 1);
  return hits
    .filter((h) => !phraseHit || h.s <= 1)
    .sort((a, b) => a.s - b.s || a.c.customer_name.localeCompare(b.c.customer_name))
    .slice(0, limit)
    .map(({ c }) => ({ customer_id: c.customer_id, customer_name: c.customer_name, address_line_1: c.address_line_1 }));
}
