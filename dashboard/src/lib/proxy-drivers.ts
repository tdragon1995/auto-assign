/**
 * Diag parks jobs on its own "proxy" driver accounts. None of them are people, so a
 * screen that renders them as the assigned driver shows staff a name and phone number
 * that belong to nobody — and, worse, implies the wrong thing about the trip's state.
 *
 * The four accounts do different jobs, so they cannot share one label:
 *   queue   — parked, waiting for the engine to assign a real driver ("Chờ điều phối")
 *   3pl     — genuinely handed to Grab/Be/XanhSM ("Đã gửi qua đối tác")
 *   reject  — duplicate-rejection staging; should not reach a branch screen
 *   supply  — consumables runs
 *
 * Matched on driver id first (stable) with a name fallback, because list payloads
 * built from the route timeline carry only driverFullname, not the id.
 */

export type ProxyKind = "queue" | "3pl" | "reject" | "supply";

const PROXY_BY_ID: Record<string, ProxyKind> = {
  "a8c48608-45d0-11f1-9378-fa163ee8d8ac": "queue",
  "6437bace-6578-11f1-9378-fa163ee8d8ac": "3pl",
  "261e8f56-3c6a-11f1-9378-fa163ee8d8ac": "reject",
  "7e89ea30-5aea-11f0-95d4-506b8d982279": "supply",
};

// Name fallback. Order matters: "Proxy 3PL Express (Grab) Driver" must be tested before
// the bare /proxy/ catch-all, or every parked job reads as a Grab handoff.
const PROXY_BY_NAME: [RegExp, ProxyKind][] = [
  [/3pl|grab/i, "3pl"],
  [/queue/i, "queue"],
  [/reject/i, "reject"],
  [/vật tư|vat tu/i, "supply"],
];

export function proxyKind(name?: string | null, driverId?: string | null): ProxyKind | null {
  if (driverId && PROXY_BY_ID[driverId]) return PROXY_BY_ID[driverId];
  const raw = (name ?? "").trim();
  if (!raw || !/proxy/i.test(raw)) return null;
  for (const [re, kind] of PROXY_BY_NAME) if (re.test(raw)) return kind;
  // Unrecognised proxy account — still not a person, so treat it as parked rather than
  // showing its name to a branch.
  return "queue";
}

export const THREE_PL_LABEL = "Grab/Be/XanhSM/Khác";

/** What to show where a driver name would go. null means "no real driver yet". */
export function driverLabel(name?: string | null, driverId?: string | null): string | null {
  const kind = proxyKind(name, driverId);
  if (kind === "3pl") return THREE_PL_LABEL;
  if (kind) return null; // parked / staging — there is no driver to name
  const raw = (name ?? "").trim();
  return raw || null;
}
