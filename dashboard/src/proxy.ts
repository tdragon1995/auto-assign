import { NextResponse, type NextRequest } from "next/server";

export function proxy(req: NextRequest) {
  if (process.env.VERCEL_ENV !== "preview" || process.env.VERCEL_GIT_COMMIT_REF !== "codex/shadow-assignment") {
    return NextResponse.next();
  }
  const path = req.nextUrl.pathname;
  if (path === "/" && req.method === "GET") return NextResponse.redirect(new URL("/shadow", req.url));
  if ((path === "/shadow" || path === "/api/shadow") && req.method === "GET") return NextResponse.next();
  if (path.startsWith("/_next/") || path === "/favicon.ico") return NextResponse.next();
  return new NextResponse("Shadow deployment is read-only", { status: 403 });
}

export const config = { matcher: "/:path*" };
