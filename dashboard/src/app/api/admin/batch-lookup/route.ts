import { NextRequest, NextResponse } from "next/server";
import { LOOKUP_QUERY_ERROR, lookupBatch, normalizeLookupQuery } from "@/lib/batch-lookup";

export const runtime = "nodejs";
export const preferredRegion = "sin1";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const vid = normalizeLookupQuery(req.nextUrl.searchParams.get("vid") ?? "");
  if (!vid) return NextResponse.json({ error: LOOKUP_QUERY_ERROR }, { status: 400 });
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
