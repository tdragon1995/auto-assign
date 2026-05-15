import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";
export const preferredRegion = "sin1";

const LOGIN_URL = "https://api-bknd.labcenter.vn/api/v1/auth/login";
const CLIENT_URL = "https://api.labcenter.vn/spc-pos/api/client";

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string | null> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.token;

  const email = process.env.LABCENTER_RECEPTIONIST_EMAIL;
  const password = process.env.LABCENTER_RECEPTIONIST_PASSWORD;
  if (!email || !password) return null;

  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, "g-recaptcha-response": "randString" }),
  });
  if (!res.ok) return null;

  const data = await res.json().catch(() => ({}));
  const token: string | undefined = data?.token;
  if (!token) return null;

  let expiresAt = now + 60 * 60 * 1000;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (payload?.exp) expiresAt = payload.exp * 1000;
  } catch { /* keep default */ }

  tokenCache = { token, expiresAt };
  return token;
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 2) return NextResponse.json({ results: [] });

  const token = await getToken();
  if (!token) return NextResponse.json({ error: "Labcenter login failed" }, { status: 502 });

  const res = await fetch(`${CLIENT_URL}?q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return NextResponse.json({ error: `Labcenter ${res.status}` }, { status: 502 });

  const data = await res.json().catch(() => ({}));
  const results = (data?.data ?? []).map((c: { code: string; client_legal_name: string }) => ({
    code: c.code,
    client_legal_name: c.client_legal_name?.trim() ?? "",
  }));

  return NextResponse.json({ results });
}
