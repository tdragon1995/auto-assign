/**
 * One-off discovery probe: fill the MISA login form from .env, submit, and dump
 * whatever screen comes next (structure only — no secrets printed). Used to wire
 * up the 2FA step in lib/misa.mjs. Safe to delete once login is finalized.
 *
 *   node scripts/login-probe.mjs          (headed)
 *   node scripts/login-probe.mjs --headless
 */
process.env.TZ = "Asia/Ho_Chi_Minh";
import "dotenv/config";
import { chromium } from "playwright";

const ORIGIN = "https://amisapp.misa.vn";
const headless = process.argv.includes("--headless");

const dumpState = async (page, label) => {
  const url = page.url();
  const inputs = await page.$$eval("input", (els) =>
    els
      .filter((e) => e.offsetParent !== null || e.type === "hidden")
      .map((e) => ({
        type: e.type,
        name: e.name || null,
        placeholder: e.placeholder || null,
        maxlength: e.getAttribute("maxlength"),
        id: e.id || null,
        ariaLabel: e.getAttribute("aria-label"),
      })),
  );
  const buttons = await page.$$eval("button, a[role=button], [class*=btn]", (els) =>
    [...new Set(els.map((e) => (e.innerText || e.textContent || "").trim()).filter(Boolean))].slice(0, 30),
  );
  const bodyText = (await page.$eval("body", (b) => b.innerText).catch(() => "")).slice(0, 600);
  console.log(`\n===== ${label} =====`);
  console.log("URL:", url);
  console.log("INPUTS:", JSON.stringify(inputs, null, 2));
  console.log("BUTTONS/LINKS:", JSON.stringify(buttons));
  console.log("BODY TEXT (first 600):\n", bodyText.replace(/\n{2,}/g, "\n"));
};

const browser = await chromium.launch({ headless });
const context = await browser.newContext({
  locale: "vi-VN",
  timezoneId: "Asia/Ho_Chi_Minh",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});
const page = await context.newPage();

try {
  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2500);
  await dumpState(page, "LOGIN PAGE");

  const user = page.getByPlaceholder("Số điện thoại/email");
  const pass = page.getByPlaceholder("Mật khẩu");
  await user.waitFor({ timeout: 20_000 });
  await user.fill(process.env.MISA_USERNAME);
  await pass.fill(process.env.MISA_PASSWORD);
  console.log("\n[probe] credentials filled, clicking Đăng nhập...");
  await page.getByRole("button", { name: "Đăng nhập" }).click();

  // Wait for navigation OR an OTP field OR an error toast to appear.
  await page.waitForTimeout(6000);
  await dumpState(page, "AFTER SUBMIT");

  // Give a slow 2FA screen a little more time, then dump again.
  await page.waitForTimeout(4000);
  await dumpState(page, "AFTER SUBMIT (+4s)");
} catch (e) {
  console.error("[probe] error:", e.message);
} finally {
  if (!headless) {
    console.log("\n[probe] leaving browser open 20s for inspection...");
    await page.waitForTimeout(20_000);
  }
  await browser.close();
}
