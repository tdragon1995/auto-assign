import { NextRequest, NextResponse } from "next/server";

/**
 * Kick off the MISA shift sync from the dashboard's Refresh button.
 *
 * The sync itself can't run here: logging into MISA needs a real browser
 * (Playwright), because the TimeSheet APIs sit behind Cloudflare + reCAPTCHA
 * that reject a plain HTTP client. So this route only *dispatches* the GitHub
 * Actions workflow that owns the browser, and returns immediately — the sheet
 * updates a couple of minutes later.
 *
 * GET  → status of the most recent run (for polling / display)
 * POST → dispatch a run, unless one is already in flight
 *
 * Requires GITHUB_DISPATCH_TOKEN (fine-grained PAT, Actions: read+write on this
 * repo). Without it the route reports `disabled` and the caller stays quiet, so
 * deploying this ahead of the token is harmless.
 */

/**
 * How long after a finished run the next dispatch is refused.
 *
 * A MISA sync is not a cache reload: it drives a real browser, rewrites the
 * shift tab and re-submits every upcoming leave day. One click per Refresh was
 * fine while each re-submission was rejected as a duplicate — until the leave
 * tab went unreadable on 30/08 and the rejection stopped happening, at which
 * point 21 Refresh clicks became 21 identical copies of the same eight rows.
 * MISA data changes a few times a day, so a quarter of an hour costs nothing
 * and takes the amplifier out of the loop.
 */
const COOLDOWN_MINUTES = 15;

const REPO = process.env.GITHUB_REPO ?? "tdragon1995/auto-assign";
const WORKFLOW = "misa-shifts.yml";
const BRANCH = process.env.GITHUB_REF_NAME ?? "master";

function ghHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "diag-logistics-dashboard",
  };
}

type Run = {
  id: number;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | …
  created_at: string;
  html_url: string;
};

async function latestRun(token: string): Promise<Run | null> {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`,
    { headers: ghHeaders(token), cache: "no-store" },
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.workflow_runs?.[0] ?? null;
}

/** Minutes left on the cooldown for a finished run — 0 once it has lapsed, and
 *  0 for a run still going (that case is reported as already_running instead). */
function cooldownLeft(run: Run): number {
  if (run.status !== "completed") return 0;
  const started = Date.parse(run.created_at);
  if (!Number.isFinite(started)) return 0;
  const elapsedMin = (Date.now() - started) / 60_000;
  return Math.max(0, Math.ceil(COOLDOWN_MINUTES - elapsedMin));
}

export async function GET() {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) return NextResponse.json({ status: "disabled" });

  const run = await latestRun(token);
  if (!run) return NextResponse.json({ status: "unknown", cooldown_minutes: COOLDOWN_MINUTES });
  const wait = cooldownLeft(run);
  return NextResponse.json({
    status: run.status,
    conclusion: run.conclusion,
    started: run.created_at,
    url: run.html_url,
    cooldown_minutes: COOLDOWN_MINUTES,
    // Minutes until Refresh will dispatch again; 0 when it would go now.
    cooldown_remaining: wait,
  });
}

export async function POST(req: NextRequest) {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    // Not configured — the Refresh button carries on as before.
    return NextResponse.json({ status: "disabled" });
  }

  try {
    // Don't stack runs: a second dispatch while one is mid-flight would race
    // the same sheet writes, and the whole tab is cleared and rewritten.
    const running = await latestRun(token);
    if (running && (running.status === "queued" || running.status === "in_progress")) {
      return NextResponse.json({ status: "already_running", url: running.html_url });
    }

    // Ran recently enough — say so rather than starting another one. The caller
    // is told how long is left so a Refresh never looks like it did nothing.
    const wait = running ? cooldownLeft(running) : 0;
    if (wait > 0) {
      return NextResponse.json({
        status: "cooldown",
        cooldown_minutes: COOLDOWN_MINUTES,
        cooldown_remaining: wait,
        started: running!.created_at,
        url: running!.html_url,
      });
    }

    const month = req.nextUrl.searchParams.get("month");
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: { ...ghHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          ref: BRANCH,
          inputs: month ? { month } : {},
        }),
      },
    );

    // GitHub answers a successful dispatch with 204 and an empty body.
    if (res.status !== 204) {
      const body = await res.text();
      console.error(`[misa-sync] dispatch failed ${res.status}: ${body.slice(0, 300)}`);
      return NextResponse.json(
        { status: "error", error: `GitHub returned ${res.status}` },
        { status: 502 },
      );
    }

    return NextResponse.json({ status: "dispatched" });
  } catch (e) {
    console.error("[misa-sync]", e);
    return NextResponse.json({ status: "error", error: String(e) }, { status: 500 });
  }
}
