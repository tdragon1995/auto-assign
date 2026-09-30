// Run: node --import tsx scripts/mobile-pickup.test.mts
// Open http://127.0.0.1:4321 at mobile and desktop widths; assertions run on resize.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { FailedJobsPanel } from "../src/components/failed-jobs-panel";

const name = "25854 - D5 - PCDieu - CÔNG TY CỔ PHẦN BỆNH VIỆN ĐA KHOA HOÀN MỸ MINH HẢI";
const noop = () => {};
const baseJob = {
  job_id: 34472760, reference_number: "D001-request", reason: "NO_MAPPING" as const,
  customer: `BRA - D001 → ${name}`, detail: `Chưa cấu hình tuyến tới ${name} — cần thêm dòng dropoff_id trong Google Sheet`,
  level: "WARN" as const, ts: "2026-09-30 10:57:08", scheduled_delivery_ts: "2026-09-30 14:00:00",
  delivery_window: "14:00–14:30", route_gps: "10.775086,106.672714;10.756574,106.657205",
};
const html = renderToStaticMarkup(createElement(FailedJobsPanel, {
  held: [], env: "prod", onNoteRefresh: noop, onNoteAssigned: noop, onNoteManualAssign: noop,
  failed: [baseJob, {...baseJob, job_id: 34472761, customer: `${name} → BRA - D001`},
    {...baseJob, job_id: 34472762, customer: `${"Pickup".repeat(30)} → BRA - D001`}],
  warnings: [{job_id: 34472763, reference_number: null, pickup_customer_name: name,
    dropoff_customer_name: "BRA - D001", driver_id: "test", driver_name: null,
    reason: "overdue", minutes_late: 125, window_time_from: "14:00:00+07:00"}],
  warningsAt: null, scheduleErrors: [], drivers: [], onAssign: noop, onScheduleFailed: noop,
  onRetrySchedule: noop, retryingSchedule: false, leaveToday: [], leaveTomorrow: [],
  onLeaveRefresh: noop, onOpenJob: noop,
}));
const cssPath = resolve("src/app/globals.css");
const {css} = await postcss([tailwind({base: process.cwd()})]).process(readFileSync(cssPath, "utf8"), {from: cssPath});
const assertions = `
function check() {
  const routes = [...document.querySelectorAll('span[title]')].filter(e => e.textContent.includes('→'));
  const mobile = innerWidth < 768;
  const failures = [];
  for (const e of routes) {
    const r = e.getBoundingClientRect(), p = e.parentElement.getBoundingClientRect();
    if (r.width < (mobile ? p.width - 1 : 1)) failures.push('Route squeezed: ' + e.textContent);
    if (mobile && e.scrollWidth > e.clientWidth + 1) failures.push('Route overflow');
    if (mobile && r.top < e.parentElement.firstElementChild.getBoundingClientRect().bottom) failures.push('Route overlaps controls');
  }
  const details = [...document.querySelectorAll('span')].filter(e => e.textContent.startsWith('Chưa cấu hình tuyến'));
  if (details.some(e => e.hasAttribute('title'))) failures.push('Unwanted detail tooltip');
  if (mobile && details.some(e => e.scrollWidth > e.clientWidth + 1)) failures.push('Detail overflow');
  if (document.documentElement.scrollWidth > innerWidth) failures.push('Page overflow');
  if (routes.length !== 4) failures.push('Missing route');
  document.body.dataset.result = JSON.stringify({width:innerWidth,routes:routes.length,failures});
  console.assert(failures.length === 0, failures);
}
addEventListener('load',check); addEventListener('resize',check);`;
const page = `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pickup layout regression</title><style>${css}</style><body style="font-family:Arial,sans-serif;padding:8px"><main style="height:calc(100vh - 16px)">${html}</main><script>${assertions}</script></body></html>`;
createServer((_req, res) => {res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(page);}).listen(4321, "127.0.0.1", () => console.log("Fixture ready: http://127.0.0.1:4321"));
