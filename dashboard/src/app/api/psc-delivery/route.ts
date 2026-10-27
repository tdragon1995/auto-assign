/**
 * /qr "Giao Kết Quả / Vật Tư": a PSC sends results or supplies out to clients.
 *
 *   GET  ?q=…  search the Cartrack customer directory (accent-insensitive, 15 hits)
 *   POST       { pickup, deliveries: [{ customer_id, kind, note, files }] }
 *              → 202 at once; then per client a ONE-STOP collect job at the PSC,
 *                given to the client's driver — or a photo to-do added to the open
 *                one for that client. The hand-over at the client: lib/kqvt.ts.
 *                Reference "D002→Mai Hoàng Anh_05:43" (short client name).
 *
 * Photos/files ride as public links in the drop-off note, uploaded through the same
 * Cartrack carrier as "Cập nhật công" (lib/cartrack-files.ts). The /qr page is open
 * to anyone with the link, so the pickup must be a known PSC and every client a real
 * Cartrack customer; the search never hands out the whole directory.
 */
import { NextRequest, NextResponse, after } from "next/server";
import { BASE_URL, getHeaders, getCustomerById } from "@/lib/cartrack";
import { PSC_ROUTES } from "@/lib/psc-routes-data";
import { appendStopTodos, cancelBooking, collectTodo, createCollectJob, defaultDropoff, deliverTodo, isNear, loadBooked, loadPending, logBooking, pickCollector, planDelivery, pscName, savePending, waitingKey, type KqvtEntry, type KqvtItem } from "@/lib/kqvt";
import { loadConfigFromSheets } from "@/lib/config";
import { loadLeaveEntries } from "@/lib/leave-config";
import { shortCode } from "@/lib/psc-dup";
import { placeLabel } from "@/lib/place-label";
import { LAB_CUSTOMER_ID } from "@/lib/job-filters";
import { indexCustomer, rankCustomers, type Customer, type Indexed } from "@/lib/customer-search";
import { vnDate, vnTimestamp } from "@/lib/time";
import { acquireCreateLock, releaseCreateLock, pushRunLog } from "@/lib/smart-log-kv";
import { uploadToCartrack, proofUploadConfigured, type UploadFile } from "@/lib/cartrack-files";
import { MAX_PROOF_FILES, MAX_PROOF_BYTES } from "@/lib/pay-corrections";

export const runtime = "nodejs";
export const preferredRegion = "sin1";
export const maxDuration = 60;

// What the PSC sends; KV is both at once — one trip carrying both items.
const KINDS = {
  KQ: { text: "Kết quả", items: ["📄 Kết quả"] },
  VT: { text: "Vật tư", items: ["📦 Vật tư"] },
  KV: { text: "Kết quả + Vật tư", items: ["📄 Kết quả", "📦 Vật tư"] },
} as const;
type Kind = keyof typeof KINDS;
const MAX_CLIENTS = 10;
const NOTE_MAX = 300;
const DATA_URL = /^data:(image\/(png|jpe?g|webp|gif|heic)|application\/pdf);base64,[A-Za-z0-9+/=]+$/;

// Economy over speed (supervisor, 2026-10-15): ~2,300 customers is 3 Cartrack pages
// (~1.3 MB), fetched one after another, kept an HOUR per instance, and only when someone
// actually searches. A client created in Cartrack today can take up to that hour to
// appear. ponytail: per-instance; share it through Redis only if cold loads add up.
let dir: { at: number; rows: Map<string, Indexed> } | null = null;
let loading: Promise<Map<string, Indexed>> | null = null;
const DIR_TTL_MS = 60 * 60_000;
const PAGE = 1000;

async function page(n: number): Promise<Customer[]> {
  const res = await fetch(`${BASE_URL}/customers?page=${n}&limit=${PAGE}`, { headers: getHeaders("prod"), cache: "no-store" });
  if (!res.ok) throw new Error(`Cartrack HTTP ${res.status}`);
  return (await res.json()).data ?? [];
}

/** All customers, indexed; concurrent callers share one load. ~6.5s cold. */
function directory(): Promise<Map<string, Indexed>> {
  if (dir && Date.now() - dir.at < DIR_TTL_MS) return Promise.resolve(dir.rows);
  loading ??= (async () => {
    const rows = new Map<string, Indexed>();
    for (let n = 1; n <= 30; n++) {
      const list = await page(n);
      for (const c of list) rows.set(c.customer_id, indexCustomer(c));
      if (list.length < PAGE) break;
    }
    dir = { at: Date.now(), rows };
    return rows;
  })().finally(() => { loading = null; });
  return loading;
}

export async function GET(req: NextRequest) {
  // ?booked=<PSC id>&date=YYYY-MM-DD → what that PSC booked that day, with where each is now.
  const booked = req.nextUrl.searchParams.get("booked");
  if (booked) {
    const date = req.nextUrl.searchParams.get("date") ?? vnDate();
    if (!PSC_ROUTES.some((r) => r.pickup === booked) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Yêu cầu không hợp lệ." }, { status: 400 });
    }
    try {
      return NextResponse.json({ bookings: await loadBooked(booked, date) });
    } catch (e) {
      return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 502 });
    }
  }
  const q = req.nextUrl.searchParams.get("q") ?? "";
  if (q.trim().length < 3) return NextResponse.json({ customers: [] });
  try {
    return NextResponse.json({ customers: rankCustomers((await directory()).values(), q) });
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
    if (typeof d.kind !== "string" || !Object.hasOwn(KINDS, d.kind)) return "Chọn Kết quả, Vật tư hoặc cả hai.";
    const note = typeof d.note === "string" ? d.note.trim() : "";
    if (note.length > NOTE_MAX) return `Ghi chú tối đa ${NOTE_MAX} ký tự.`;
    const files = Array.isArray(d.files) ? (d.files as UploadFile[]) : [];
    if (files.length > MAX_PROOF_FILES) return `Tối đa ${MAX_PROOF_FILES} ảnh mỗi khách hàng.`;
    for (const f of files) {
      if (typeof f?.name !== "string" || f.name.length > 120 || typeof f.dataUrl !== "string" || !DATA_URL.test(f.dataUrl)) return "Chỉ nhận ảnh hoặc PDF.";
      bytes += Math.floor((f.dataUrl.length - f.dataUrl.indexOf(",") - 1) * 3 / 4);
    }
    out.push({ customer_id: d.customer_id, kind: d.kind as Kind, note, files });
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
  const failed = (who: string, why: string) =>
    pushRunLog([{ ts: vnTimestamp(), level: "ERROR", msg: `Giao KQ/VT FAILED - ${why} | ${psc} → ${who}` }]).catch(() => {});

  after(async () => {
    let sent = false;
    try {
      // The client's name: from this instance's directory if it holds one, else one
      // small lookup per client — never a whole-directory load just to name a trip.
      const infoOf = async (id: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c: any = dir?.rows.get(id) ?? (await getCustomerById(id, "prod"))?.data;
        const lat = Number(c?.latitude), lon = Number(c?.longitude);
        return c?.customer_name
          ? { name: c.customer_name as string, at: Number.isFinite(lat) && Number.isFinite(lon) && lat && lon ? { lat, lon } : null }
          : null;
      };
      // One upload for the whole booking (one login, one lock), split back per client.
      // Only when there are files: the uploader refuses outright where it is not configured.
      const links = allFiles.length ? await uploadToCartrack(allFiles) : [];
      // Today's roster or none, and an unreadable leave sheet is not an empty one: either
      // missing → the collect job goes out driverless, for the dispatcher.
      const [config, leave] = await Promise.all([
        loadConfigFromSheets({ requireCurrentDay: true }).catch(() => null),
        loadLeaveEntries().catch(() => null),
      ]);
      const pending = await loadPending();
      const log = `${route.pickup}:${vnDate()}`;
      let li = 0;
      for (const d of deliveries) {
        const mine = links.slice(li, li += d.files.length);
        const info = await infoOf(d.customer_id);
        const full = info?.name;
        if (!full) { await failed(d.customer_id, "không có khách hàng này trên Cartrack"); continue; }
        const client = placeLabel(full);
        const item: KqvtItem = { text: KINDS[d.kind].items.join(" + "), note: d.note, links: mine, log, bid: crypto.randomUUID().slice(0, 8) };
        // The PSC's own record (shown on /qr), written once the booking is safely held.
        const record = () => logBooking(log, { bid: item.bid!, ts: vnTimestamp().slice(11, 16), client, text: item.text, note: item.note, links: mine }).catch(() => {});
        // Under NEAR_KM by road → one direct PSC → client job; else multi-leg clients ride
        // the return trips to their default drop-off (lib/kqvt.ts). Near wins.
        const dropoff = await defaultDropoff(d.customer_id);
        const near = route.lat != null && route.lon != null && await isNear({ lat: route.lat, lon: route.lon }, info.at).catch(() => false);
        const plan = near
          ? { collectAt: route.pickup, hops: [] as string[], autoAssign: (dropoff ?? LAB_CUSTOMER_ID) !== LAB_CUSTOMER_ID }
          : planDelivery(route.pickup, dropoff);
        const route_ = plan.hops.map(pscName).join(" → ");
        const noteLine = [collectTodo(item, client), ...mine.map((u, i) => `Ảnh ${i + 1}: ${u}`)].join("\n");

        // Same client, collect job not yet set off → add to it rather than make another.
        // The NEWEST one: an older one that set off stays on the list until collected.
        // A multi-leg one only while its items still wait here for their first ride —
        // it has no job yet, so the item just joins the list.
        const open = pending.filter((e) => e.client_id === d.customer_id && !e.holder && e.psc === plan.collectAt && !!e.direct === near &&
          (e.origin ? e.job_id < 0 && e.at === route.pickup && !e.leg_job : e.psc === route.pickup))
          .sort((a, b) => b.created_ms - a.created_ms)[0];
        if (open) {
          const adds = { [open.psc]: [collectTodo(item, client)], ...(open.direct ? { [open.client_id]: [deliverTodo(item)] } : {}) };
          const r = open.job_id < 0 ? "ok" : await appendStopTodos(open.job_id, adds, "prod", noteLine).catch(() => "failed" as const);
          if (r === "ok") {
            open.items.push(item);
            await savePending(open);
            await record();
            await pushRunLog([{ ts: vnTimestamp(), level: "INFO", msg: `${open.job_id < 0 ? "KQ/VT" : `Job ${open.job_id}`} - thêm ${item.text} vào chuyến lấy KQ/VT | ${psc} → ${client}` }]).catch(() => {});
            continue;
          }
          // Set off already, gone, or the write did not hold: a new collect job below.
        }

        const base: KqvtEntry = {
          job_id: 0, psc: plan.collectAt, psc_name: pscName(plan.collectAt), client_id: d.customer_id, client_name: client,
          items: [item], created_ms: Date.now(),
        };
        sent = true;

        // Multi-leg: no job yet. The item waits on the list and rides the return trips;
        // its collect job is made at the drop-off when it arrives (lib/kqvt.ts).
        if (plan.hops.length) {
          const entry: KqvtEntry = { ...base, job_id: waitingKey(), origin: route.pickup, at: route.pickup, hops: plan.hops };
          await savePending(entry);
          pending.push(entry);
          await record();
          await pushRunLog([{ ts: vnTimestamp(), level: "INFO", msg: `KQ/VT ${item.text} chờ chuyến về qua ${route_} | ${psc} → ${client}` }]).catch(() => {});
          continue;
        }

        const who = plan.autoAssign && config && leave ? await pickCollector(config, leave, d.customer_id, route, "prod").catch(() => null) : null;
        const res = await createCollectJob(base, "", who, "prod", near);
        if (!res.jobId) {
          console.error("[psc-delivery] create failed:", res.status, JSON.stringify(res.body).slice(0, 300));
          await failed(client, res.status >= 500 ? `chưa xác nhận được (${res.status}), kiểm tra trước khi tạo lại` : `Cartrack từ chối (${res.status})`);
          continue;
        }
        const entry: KqvtEntry = {
          ...base, job_id: res.jobId, collector: res.driverId ?? undefined, collector_name: res.driverId ? who?.name ?? undefined : undefined,
          ...(near ? { direct: true } : {}),
        };
        await savePending(entry);
        pending.push(entry);
        await record();
        await pushRunLog([{ ts: vnTimestamp(), level: "INFO", msg: `Job ${res.jobId} - ${near ? "giao trực tiếp" : "lấy"} ${item.text}${near ? "" : " tại PSC"}: ${res.driverId ? who?.name ?? "tài xế" : "chờ điều phối"} | ${psc} → ${client}` }]).catch(() => {});
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

/** The PSC calls off one of its own bookings: ?booked=<PSC id>&date=YYYY-MM-DD&bid=… —
 *  only while nobody has taken the item (lib/kqvt.ts cancelBooking). */
export async function DELETE(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const psc = p.get("booked") ?? "";
  const date = p.get("date") ?? "";
  const bid = p.get("bid") ?? "";
  const route = PSC_ROUTES.find((r) => r.pickup === psc);
  if (!route || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[0-9a-f]{8}$/.test(bid)) {
    return NextResponse.json({ error: "Yêu cầu không hợp lệ." }, { status: 400 });
  }
  try {
    const r = await cancelBooking(psc, date, bid, "prod");
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    await pushRunLog([{ ts: vnTimestamp(), level: "INFO", msg: `KQ/VT ${r.text} - PSC huỷ | ${shortCode(route.psc_pickup)} → ${r.client}` }]).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 502 });
  }
}
