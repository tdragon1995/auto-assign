import { NextRequest, NextResponse } from "next/server";
import { lookupBatch } from "@/lib/batch-lookup";

export const runtime = "nodejs";
export const preferredRegion = "sin1";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const vid = req.nextUrl.searchParams.get("vid")?.trim() ?? "";
  if (!/^\d{8,20}$/.test(vid)) {
    return NextResponse.json({ error: "VID phải gồm 8–20 chữ số." }, { status: 400 });
  }
  const abort = new AbortController();
  const signal = AbortSignal.any([req.signal, abort.signal, AbortSignal.timeout(240_000)]);
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        const result = await lookupBatch(vid, send, signal);
        send("done", result);
      } finally {
        if (!closed) { closed = true; controller.close(); }
      }
    },
    cancel() { closed = true; abort.abort(); },
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
  } });
}
