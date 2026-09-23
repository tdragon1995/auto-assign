import { NextRequest, NextResponse } from "next/server";
import { getReceptionistToken } from "@/lib/labcenter";
import { destFromRemark, isPending, type TestEntry, type PendingTest } from "@/lib/handover";

export const runtime = "nodejs";
export const preferredRegion = "sin1";
export const maxDuration = 60;

// Needs the receptionist-nurse-phlebotomist role — the delivery-admin account 403s here.
const ORDERS_URL = "https://api.labcenter.vn/spc-pos/api/orders";
// The LIS view of the same order: one line per test (a package already split into parts) with its result status.
const TESTS_URL = "https://api.labcenter.vn/spc-lis/api/v1/test-results/list-tests";
const MAX_VIDS = 100;
const CONCURRENCY = 10;

async function fetchOrder(vid: string, token: string, retry = true): Promise<Response> {
  const res = await fetch(`${ORDERS_URL}?visit_number=${vid}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (retry && (res.status === 429 || res.status >= 500)) {
    await new Promise((r) => setTimeout(r, 1000));
    return fetchOrder(vid, token, false);
  }
  return res;
}

/** Tests whose result is not approved yet; null when the LIS could not be read (never guessed as "all done"). */
async function fetchPending(vid: string, token: string): Promise<PendingTest[] | null> {
  try {
    const res = await fetch(`${TESTS_URL}?order_id=${vid}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json())?.data;
    if (!Array.isArray(data)) return null;
    return data
      .filter((t: { test_status?: string }) => isPending(String(t.test_status ?? "")))
      .map((t: { test_code?: string; test_name_en?: string; test_status?: string }) => ({
        code: String(t.test_code ?? ""), name: String(t.test_name_en ?? t.test_code ?? ""), status: String(t.test_status ?? ""),
      }));
  } catch {
    return null;
  }
}

const namesOf = (t: Record<string, unknown>) =>
  [...new Set([t.billing_name, t.test_name, t.test_name_vi].map((v) => String(v ?? "").trim()).filter(Boolean))];

/** Each name a test goes by with the LIS codes behind it. A package also lists its parts
 *  (group_component), and staff paste those one per line, so each part is an entry too. */
function testEntries(details: unknown): TestEntry[] {
  return (Array.isArray(details) ? details : []).flatMap((t: Record<string, unknown>) => {
    const parts = (Array.isArray(t.group_component) ? t.group_component : []) as Record<string, unknown>[];
    const own = { names: namesOf(t), codes: parts.length ? parts.map((p) => String(p.test_code ?? "")) : [String(t.test_code ?? "")] };
    return [own, ...parts.map((p) => ({ names: namesOf(p), codes: [String(p.test_code ?? "")] }))];
  });
}

// Location 999 has no paper-result desk of its own; its hard copies travel with the D001 list.
const HUB_BRANCHES: Record<string, string> = { "999": "D001" };
const hubFor = (branch: unknown) => HUB_BRANCHES[String(branch ?? "").trim()] ?? null;

async function lookup(vid: string, token: string) {
  try {
    // Both calls at once: the status call is the faster of the two, so it adds almost no wait.
    const [res, pending] = await Promise.all([fetchOrder(vid, token), fetchPending(vid, token)]);
    if (res.status === 403) return { vid, error: "Tài khoản chưa có quyền xem đơn" };
    if (res.status === 404) return { vid, error: "Không tìm thấy" };
    if (!res.ok) return { vid, error: `Labcenter ${res.status}` };
    const o = (await res.json().catch(() => ({})))?.data;
    if (!o?.branch_code && !o?.client_id) return { vid, error: "Không tìm thấy" };
    // Only HBC orders carry a hard-copy destination in the remark; every other branch keeps its own.
    // Read Ghi chú (remarks) and Bệnh sử (history) together — staff type the sentence into either.
    const notes = [...new Set([o.remarks, o.history].map((v) => String(v ?? "").trim()).filter(Boolean))];
    const remark = o.branch_code === "HBC" ? notes.join(" | ") || null : null;
    const fromRemark = destFromRemark(remark);
    return {
      vid,
      branch_code: o.branch_code ?? null,
      client_id: o.client_id != null ? String(o.client_id) : null,
      client_name: o.client_name?.trim() || null,
      patient_name: o.patient_full_name?.trim() || null,
      test_entries: testEntries(o.order_test_details),
      pending,
      remark,
      // Where the paper result goes: for HBC, the branch its remark names; otherwise the order's branch.
      dest: fromRemark ?? hubFor(o.branch_code) ?? o.branch_code ?? null,
      dest_from_remark: !!fromRemark,
    };
  } catch {
    return { vid, error: "Không kết nối được Labcenter" };
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const vids = [...new Set(
    (Array.isArray(body?.vids) ? body.vids : []).map((v: unknown) => String(v).replace(/\D/g, "")).filter(Boolean),
  )] as string[];
  if (!vids.length) return NextResponse.json({ error: "Chưa có VID" }, { status: 400 });
  if (vids.length > MAX_VIDS) return NextResponse.json({ error: `Tối đa ${MAX_VIDS} VID mỗi lần` }, { status: 400 });

  const token = await getReceptionistToken();
  if (!token) return NextResponse.json({ error: "Labcenter login failed" }, { status: 502 });

  const results: Awaited<ReturnType<typeof lookup>>[] = new Array(vids.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < vids.length) {
      const i = next++;
      results[i] = await lookup(vids[i], token);
    }
  }));

  return NextResponse.json({ results });
}
