import { NextResponse } from "next/server";
import { shadowSnapshot } from "@/lib/shadow-compare";

export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.VERCEL_ENV !== "preview" || process.env.VERCEL_GIT_COMMIT_REF !== "codex/shadow-assignment") {
    return new NextResponse("Not found", { status: 404 });
  }
  try {
    return NextResponse.json(await shadowSnapshot(), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Read-only shadow snapshot failed:", error);
    return NextResponse.json({ error: "Shadow snapshot unavailable" }, { status: 503 });
  }
}
