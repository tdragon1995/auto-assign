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

export async function GET() {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) return NextResponse.json({ status: "disabled" });

  const run = await latestRun(token);
  if (!run) return NextResponse.json({ status: "unknown" });
  return NextResponse.json({
    status: run.status,
    conclusion: run.conclusion,
    started: run.created_at,
    url: run.html_url,
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
