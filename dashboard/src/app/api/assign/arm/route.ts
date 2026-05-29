import { NextRequest, NextResponse } from "next/server";
import { getArmState, setArmState, clearArmState, type ArmState } from "@/lib/smart-log-kv";
import { vnDate, parseVnTimestamp } from "@/lib/time";

// The switch auto-disarms at 22:00 Asia/Ho_Chi_Minh. Arming always succeeds:
// before 22:00 → armed until today's 22:00; after 22:00 → armed until the NEXT
// day's 22:00 (so you can turn it on late; it just runs until tomorrow's
// auto-off). Turn it off manually anytime.
const AUTO_OFF_HHMMSS = "22:00:00";

function nextAutoOffMs(): number {
  const todayOff = parseVnTimestamp(`${vnDate()} ${AUTO_OFF_HHMMSS}`).getTime();
  if (Date.now() < todayOff) return todayOff;
  const tomorrow = vnDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
  return parseVnTimestamp(`${tomorrow} ${AUTO_OFF_HHMMSS}`).getTime();
}

/** Current switch state. */
export async function GET() {
  const state = await getArmState();
  return NextResponse.json({ armed: !!state, state });
}

/** Turn the switch ON until the next 22:00 VN auto-off. */
export async function POST(req: NextRequest) {
  let body: { env?: string; mode?: string; by?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — defaults applied below */
  }

  const armedUntil = nextAutoOffMs();

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
