/**
 * /qr "Giao Kết Quả / Vật Tư": a PSC sends results or supplies out to clients.
 *
 *   GET  ?q=…  search the Cartrack customer directory (accent-insensitive, 15 hits)
 *   POST       { pickup, deliveries: [{ customer_id, kind, note, files }] }
 *              → 202 at once; then ONE trip per client, PSC → client, created
 *                UNASSIGNED with PSC_DELIVERY_LABEL so the engine leaves it to the
 *                dispatcher. Reference "D002→Mai Hoàng Anh_05:43" (short client name).
 *   GET  (no q) warms the directory — the form calls it when it opens.
 *
 * Photos/files ride as public links in the drop-off note, uploaded through the same
 * Cartrack carrier as "Cập nhật công" (lib/cartrack-files.ts). The /qr page is open
 * to anyone with the link, so the pickup must be a known PSC and every client a real
 * Cartrack customer; the search never hands out the whole directory.
 */
import { NextRequest, NextResponse, after } from "next/server";
import { BASE_URL, getHeaders, createJob } from "@/lib/cartrack";
import { PSC_ROUTES } from "@/lib/psc-routes-data";
import { PSC_DELIVERY_LABEL, PICKUP_PHOTO_TODO } from "@/lib/job-filters";
import { shortCode } from "@/lib/psc-dup";
import { placeLabel } from "@/lib/place-label";
import { indexCustomer, rankCustomers, type Customer, type Indexed } from "@/lib/customer-search";
import { vnHoursMinutes, vnTimestamp } from "@/lib/time";
import { acquireCreateLock, releaseCreateLock, pushRunLog } from "@/lib/smart-log-kv";
import { uploadToCartrack, proofUploadConfigured, type UploadFile } from "@/lib/cartrack-files";
import { MAX_PROOF_FILES, MAX_PROOF_BYTES } from "@/lib/pay-corrections";

export const runtime = "nodejs";
export const preferredRegion = "sin1";
export const maxDuration = 60;

const KINDS = { KQ: "Kết quả", VT: "Vật tư" } as const;
type Kind = keyof typeof KINDS;
const MAX_CLIENTS = 10;
const NOTE_MAX = 300;
const DATA_URL = /^data:(image\/(png|jpe?g|webp|gif|heic)|application\/pdf);base64,[A-Za-z0-9+/=]+$/;

// ponytail: per-instance directory cache (~2,300 customers, 3 Cartrack pages); move to
// Redis only if cold instances stay slow after the warm-up below.
let dir: { at: number; rows: Map<string, Indexed> } | null = null;
let loading: Promise<Map<string, Indexed>> | null = null;
const DIR_TTL_MS = 10 * 60_000;
const PAGE = 1000;

async function page(n: number): Promise<Customer[]> {
  const res = await fetch(`${BASE_URL}/customers?page=${n}&limit=${PAGE}`, { headers: getHeaders("prod"), cache: "no-store" });
  if (!res.ok) throw new Error(`Cartrack HTTP ${res.status}`);
  return (await res.json()).data ?? [];
}

/** All customers, indexed. Pages are fetched 4 at a time (one after another took ~6.5s),
 *  and concurrent callers share one load. */
function directory(): Promise<Map<string, Indexed>> {
  if (dir && Date.now() - dir.at < DIR_TTL_MS) return Promise.resolve(dir.rows);
  loading ??= (async () => {
    const rows = new Map<string, Indexed>();
    for (let first = 1; first <= 30; first += 4) {
      const batch = await Promise.all([0, 1, 2, 3].map((i) => page(first + i)));
      for (const c of batch.flat()) rows.set(c.customer_id, indexCustomer(c));
      if (batch.some((b) => b.length < PAGE)) break;
    }
    dir = { at: Date.now(), rows };
    return rows;
  })().finally(() => { loading = null; });
  return loading;
}

/** No `q` = the form just opened: load the directory now so the first search is warm. */
export async function GET(req: NextRequest) {
  try {
    const all = await directory();
    return NextResponse.json({ customers: rankCustomers(all.values(), req.nextUrl.searchParams.get("q") ?? "") });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

interface Delivery { customer_id: string; kind: Kind; note: string; files: UploadFile[] }

/** The request's shape, checked; a Vietnamese message for the PSC, or the deliveries. */
function parse(body: unknown): string | Delivery[] {
  const list = (body as { deliveries?: unknown } | null)?.deliveries;
  if (!Array.isArray(list) || list.length === 0) return "Chọn ít nhất một khách hàng.";
  if (list.length > MAX_CLIENTS) return `Tối đa ${MAX_CLIENTS} khách hàng mỗi lần.`;
  let bytes = 0;
  const out: Delivery[] = [];
  for (const d of list as Record<string, unknown>[]) {
    if (typeof d?.customer_id !== "string") return "Khách hàng không hợp lệ.";
    if (d.kind !== "KQ" && d.kind !== "VT") return "Chọn Kết quả hoặc Vật tư.";
    const note = typeof d.note === "string" ? d.note.trim() : "";
    if (note.length > NOTE_MAX) return `Ghi chú tối đa ${NOTE_MAX} ký tự.`;
    const files = Array.isArray(d.files) ? (d.files as UploadFile[]) : [];
    if (files.length > MAX_PROOF_FILES) return `Tối đa ${MAX_PROOF_FILES} ảnh mỗi khách hàng.`;
    for (const f of files) {
      if (typeof f?.name !== "string" || f.name.length > 120 || typeof f.dataUrl !== "string" || !DATA_URL.test(f.dataUrl)) return "Chỉ nhận ảnh hoặc PDF.";
      bytes += Math.floor((f.dataUrl.length - f.dataUrl.indexOf(",") - 1) * 3 / 4);
    }
    out.push({ customer_id: d.customer_id, kind: d.kind, note, files });
  }
  if (bytes > MAX_PROOF_BYTES) return "Ảnh quá lớn — tối đa 3 MB tổng cộng.";
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Answers as soon as the request is checked and locked; the upload and the creates run
 * in after() (supervisor, 2026-10-15: the PSC should not wait ~5s per trip). The
 * branch therefore never hears about a failed create — it lands in the run log as an
 * ERROR line for the dispatcher, who is the one acting on these trips anyway.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const route = PSC_ROUTES.find((r) => r.pickup === body?.pickup);
  if (!route) return NextResponse.json({ error: "Chi nhánh không hợp lệ." }, { status: 400 });
  const deliveries = parse(body);
  if (typeof deliveries === "string") return NextResponse.json({ error: deliveries }, { status: 400 });
  if (deliveries.some((d) => !UUID.test(d.customer_id))) {
    return NextResponse.json({ error: "Khách hàng không hợp lệ." }, { status: 400 });
  }
  const allFiles = deliveries.flatMap((d) => d.files);
  if (allFiles.length && !proofUploadConfigured()) {
    return NextResponse.json({ error: "Chưa gửi được ảnh lúc này — báo điều phối." }, { status: 503 });
  }
  // A double tap re-sends the same set; one lock over the whole booking stops the twin.
  const lockKey = `psc-delivery:${route.pickup}:${deliveries.map((d) => d.customer_id).sort().join(",")}`;
  try {
    if (!(await acquireCreateLock(lockKey))) {
      return NextResponse.json({ error: "Yêu cầu này vừa được gửi. Đợi một lát rồi thử lại." }, { status: 409 });
    }
  } catch {
    return NextResponse.json({ error: "Không gửi được yêu cầu. Thử lại sau." }, { status: 502 });
  }

  const psc = shortCode(route.psc_pickup);
  const { hours, minutes } = vnHoursMinutes();
  const hm = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  const failed = (who: string, why: string) =>
    pushRunLog([{ ts: vnTimestamp(), level: "ERROR", msg: `Giao KQ/VT FAILED - ${why} | ${psc} → ${who}` }]).catch(() => {});

  after(async () => {
    let sent = false;
    try {
      const known = await directory();
      // One upload for the whole booking (one login, one lock), split back per client.
      // Only when there are files: the uploader refuses outright where it is not configured.
      const links = allFiles.length ? await uploadToCartrack(allFiles) : [];
      let li = 0;
      for (const d of deliveries) {
        const mine = links.slice(li, li += d.files.length);
        const full = known.get(d.customer_id)?.customer_name;
        if (!full) { await failed(d.customer_id, "không có khách hàng này trên Cartrack"); continue; }
        const client = placeLabel(full);
        const reference = `${psc}→${client.slice(0, 60)}_${hm}`;
        const icon = d.kind === "KQ" ? "📄" : "📦";
        const note = [`${icon} ${KINDS[d.kind]}${d.note ? ` — ${d.note}` : ""}`, ...mine.map((u, i) => `Ảnh ${i + 1}: ${u}`)].join("\n");
        sent = true;
        const res = await createJob({
          job_type_id: 1,
          schedule_type_id: 1,
          reference_number: reference,
          labels: [PSC_DELIVERY_LABEL],
          stops: [
            { stop_type_id: 1, customer_id: route.pickup, duration: 5, note, todos: [PICKUP_PHOTO_TODO] },
            { stop_type_id: 2, customer_id: d.customer_id, duration: 10, note, todos: [] },
          ],
          items: [{ description: `${icon} ${KINDS[d.kind]}`, weight: 0, item_type_id: 1, quantity: 1, tracking_number: "" }],
        });
        if (res.ok) {
          await pushRunLog([{ ts: vnTimestamp(), level: "INFO", msg: `Job ${res.body?.data?.job_id} - ${KINDS[d.kind]} chờ điều phối | ${psc} → ${client}` }]).catch(() => {});
        } else {
          console.error("[psc-delivery] create failed:", res.status, JSON.stringify(res.body).slice(0, 300));
          await failed(client, res.status >= 500 ? `chưa xác nhận được (${res.status}), kiểm tra trước khi tạo lại` : `Cartrack từ chối (${res.status})`);
        }
      }
    } catch (e) {
      console.error("[psc-delivery] error:", e);
      await failed(deliveries.length === 1 ? deliveries[0].customer_id : `${deliveries.length} khách hàng`, String(e).slice(0, 120));
      // Nothing created yet (directory or upload failed) → free the booking to retry at once.
      if (!sent) await releaseCreateLock(lockKey).catch(() => {});
    }
  });

  return NextResponse.json({ accepted: true, count: deliveries.length }, { status: 202 });
}
