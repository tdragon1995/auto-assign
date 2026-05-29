import { NextRequest, NextResponse } from "next/server";
import { getArmState, setArmState, clearArmState, type ArmState } from "@/lib/smart-log-kv";
import { vnDate, parseVnTimestamp } from "@/lib/time";

// The switch auto-disarms at 22:00 Asia/Ho_Chi_Minh each day (end of the
// 04:55–22:00 operating window). Arming is refused once past this time.
const AUTO_OFF_HHMMSS = "22:00:00";

function endOfBusinessDayMs(): number {
  return parseVnTimestamp(`${vnDate()} ${AUTO_OFF_HHMMSS}`).getTime();
}

/** Current switch state. */
export async function GET() {
  const state = await getArmState();
  return NextResponse.json({ armed: !!state, state });
}

/** Turn the switch ON until end of business day (18:00 VN). */
export async function POST(req: NextRequest) {
  let body: { env?: string; mode?: string; by?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — defaults applied below */
  }

  const armedUntil = endOfBusinessDayMs();
  if (Date.now() >= armedUntil) {
    return NextResponse.json(
      { armed: false, error: "Đã quá 18:00 — vui lòng bật lại vào sáng mai." },
      { status: 409 }
    );
  }

  const state: ArmState = {
    armedUntil,
    armedTs: new Date().toISOString(),
    armedBy: (body.by ?? "").trim().slice(0, 60),
    env: body.env === "uat" ? "uat" : "prod",
    mode: body.mode === "autoplan" ? "autoplan" : "smart",
  };

  await setArmState(state);
  return NextResponse.json({ armed: true, state });
}

/** Turn the switch OFF immediately. */
export async function DELETE() {
  await clearArmState();
  return NextResponse.json({ armed: false, state: null });
}
