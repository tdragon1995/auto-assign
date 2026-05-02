import { NextRequest, NextResponse } from "next/server";
import { getDrivers, type Env } from "@/lib/cartrack";

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  try {
    const drivers = await getDrivers(env);
    return NextResponse.json({ data: drivers });
  } catch (e) {
    return NextResponse.json(
      { data: [], error: String(e) },
      { status: 500 }
    );
  }
}
