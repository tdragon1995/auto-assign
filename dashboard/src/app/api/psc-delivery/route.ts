/**
 * /qr "Giao Kết Quả / Vật Tư": a PSC sends results or supplies out to clients.
 *
 *   GET  ?q=…  search the Cartrack customer directory (accent-insensitive, 15 hits)
 *   POST       { pickup, deliveries: [{ customer_id, kind, note, files }] }
 *              → ONE trip per client, PSC → client, created UNASSIGNED with
 *                PSC_DELIVERY_LABEL so the engine leaves it to the dispatcher.
 *
 * Photos/files ride as public links in the drop-off note, uploaded through the same
 * Cartrack carrier as "Cập nhật công" (lib/cartrack-files.ts). The /qr page is open
 * to anyone with the link, so the pickup must be a known PSC and every client a real
 * Cartrack customer; the search never hands out the whole directory.
 */
import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, createJob } from "@/lib/cartrack";
import { PSC_ROUTES } from "@/lib/psc-routes-data";
import { PSC_DELIVERY_LABEL, PICKUP_PHOTO_TODO } from "@/lib/job-filters";
import { shortCode } from "@/lib/psc-dup";
import { foldName } from "@/lib/driver-cell";
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

interface Customer { customer_id: string; customer_name: string; address_line_1?: string | null }

// ponytail: per-instance directory cache; a cold instance pays ~2–5 pages of Cartrack.
let dir: { at: number; rows: Map<string, Customer & { key: string }> } | null = null;
const DIR_TTL_MS = 10 * 60_000;

async function directory(): Promise<Map<string, Customer & { key: string }>> {
  if (dir && Date.now() - dir.at < DIR_TTL_MS) return dir.rows;
  const rows = new Map<string, Customer & { key: string }>();
  for (let page = 1; page <= 30; page++) {
    const res = await fetch(`${BASE_URL}/customers?page=${page}&limit=1000`, { headers: getHeaders("prod"), cache: "no-store" });
    if (!res.ok) throw new Error(`Cartrack HTTP ${res.status}`);
    const list: Customer[] = (await res.json()).data ?? [];
    for (const c of list) {
      rows.set(c.customer_id, { customer_id: c.customer_id, customer_name: c.customer_name, address_line_1: c.address_line_1, key: foldName(`${c.customer_name} ${c.address_line_1 ?? ""}`) });
    }
    if (list.length < 1000) break;
  }
  dir = { at: Date.now(), rows };
  return rows;
}

export async function GET(req: NextRequest) {
  const words = foldName(req.nextUrl.searchParams.get("q") ?? "").split(/\s+/).filter(Boolean);
  if (words.join("").length < 2) return NextResponse.json({ customers: [] });
  try {
    const hits: Customer[] = [];
    for (const c of (await directory()).values()) {
      if (words.every((w) => c.key.includes(w))) hits.push({ customer_id: c.customer_id, customer_name: c.customer_name, address_line_1: c.address_line_1 });
      if (hits.length >= 15) break;
    }
    return NextResponse.json({ customers: hits });
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

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const route = PSC_ROUTES.find((r) => r.pickup === body?.pickup);
  if (!route) return NextResponse.json({ error: "Chi nhánh không hợp lệ." }, { status: 400 });
  const deliveries = parse(body);
  if (typeof deliveries === "string") return NextResponse.json({ error: deliveries }, { status: 400 });

  let lockKey: string | null = null;
  let sent = false;
  try {
    const known = await directory();
    if (deliveries.some((d) => !known.has(d.customer_id))) {
      return NextResponse.json({ error: "Không tìm thấy khách hàng trên Cartrack." }, { status: 400 });
    }
    const allFiles = deliveries.flatMap((d) => d.files);
    if (allFiles.length && !proofUploadConfigured()) {
      return NextResponse.json({ error: "Chưa gửi được ảnh lúc này — báo điều phối." }, { status: 503 });
    }
    // A double tap re-sends the same set; one lock over the whole booking stops the twin.
    const ids = deliveries.map((d) => d.customer_id).sort().join(",");
    lockKey = `psc-delivery:${route.pickup}:${ids}`;
    if (!(await acquireCreateLock(lockKey))) {
      lockKey = null;
      return NextResponse.json({ error: "Yêu cầu này vừa được gửi. Đợi một lát rồi thử lại." }, { status: 409 });
    }

    // One upload for the whole booking (one login, one lock), split back per client.
    // Only when there are files: the uploader refuses outright where it is not configured.
    const links = allFiles.length ? await uploadToCartrack(allFiles) : [];
    const psc = shortCode(route.psc_pickup);
    const { hours, minutes } = vnHoursMinutes();
    const hm = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;

    let li = 0;
    const results: { customer_id: string; ok: boolean; job_id?: number; reference?: string; error?: string }[] = [];
    for (const d of deliveries) {
      const mine = links.slice(li, li += d.files.length);
      const client = known.get(d.customer_id)!.customer_name;
      const reference = `${d.kind} ${psc}→${client.slice(0, 40)}_${hm}`;
      const note = [`${d.kind === "KQ" ? "📄" : "📦"} ${KINDS[d.kind]}${d.note ? ` — ${d.note}` : ""}`, ...mine.map((u, i) => `Ảnh ${i + 1}: ${u}`)].join("\n");
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
        items: [{ description: `${d.kind === "KQ" ? "📄" : "📦"} ${KINDS[d.kind]}`, weight: 0, item_type_id: 1, quantity: 1, tracking_number: "" }],
      });
      const job_id = res.ok ? res.body?.data?.job_id : undefined;
      results.push(res.ok
        ? { customer_id: d.customer_id, ok: true, job_id, reference }
        : { customer_id: d.customer_id, ok: false, error: res.status >= 500 ? "Chưa xác nhận được — kiểm tra trước khi gửi lại." : "Không tạo được chuyến." });
      if (res.ok) {
        pushRunLog([{ ts: vnTimestamp(), level: "INFO", msg: `Job ${job_id} - ${KINDS[d.kind]} chờ điều phối | ${psc} → ${client}` }]).catch(() => {});
      }
    }
    return NextResponse.json({ results });
  } catch (e) {
    console.error("[psc-delivery] error:", e);
    // Nothing created yet (search or upload failed) → free the booking to retry at once.
    if (lockKey && !sent) void releaseCreateLock(lockKey);
    return NextResponse.json({ error: "Không gửi được yêu cầu. Thử lại sau." }, { status: 502 });
  }
}
