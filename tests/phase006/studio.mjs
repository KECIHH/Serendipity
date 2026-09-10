import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "../../.scaffold/tools/node_modules/playwright/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = process.argv[2];
const directory = process.argv[3];
assert.equal(new URL(baseUrl).hostname, "127.0.0.1");
assert.match(directory, /^docs\/evidence\/attempts\/Phase006\/attempt-\d+$/);
const output = path.resolve(root, directory);
const fields = [
  "id",
  "email",
  "phone",
  "name",
  "avatarUrl",
  "passwordHash",
  "role",
  "status",
  "sessionVersion",
  "revision",
  "lastLoginAt",
  "createdAt",
  "updatedAt",
];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 3200, height: 1000 },
  reducedMotion: "reduce",
});
const requests = [],
  blocked = [],
  pageErrors = [];
await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === new URL(baseUrl).origin) {
    requests.push({ method: route.request().method(), path: url.pathname });
    await route.continue();
  } else {
    blocked.push(url.origin);
    await route.abort();
  }
});
const page = await context.newPage();
page.on("pageerror", (error) => pageErrors.push(error.message));
try {
  const response = await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 60_000 });
  assert.equal(response.status(), 200);
  await page.getByText("User", { exact: true }).first().click();
  await page.waitForLoadState("networkidle");
  await page
    .getByText("Fetching rows in this table...", { exact: true })
    .waitFor({ state: "hidden", timeout: 30_000 });
  const verifiedFields = [];
  for (const field of fields) {
    const locator = page.locator(`[role="columnheader"][col-id="User.${field}"]`);
    await locator.waitFor({ state: "visible", timeout: 30_000 });
    assert(await locator.isVisible(), `Studio missing visible User field ${field}`);
    verifiedFields.push(field);
  }
  const text = await page.locator("body").innerText();
  assert(
    !text.includes("Fetching rows in this table..."),
    "Studio must finish the real database query",
  );
  assert(
    !/Error querying the database|Unable to run script|PrismaClientInitializationError/.test(text),
  );
  assert.deepEqual(pageErrors, []);
  const rawHtml = await page.content();
  const html = rawHtml.replaceAll("\r\n", "\n").replace(/[\t ]+$/gm, "");
  fs.writeFileSync(path.join(output, "studio.html"), html, { flag: "wx" });
  const screenshot = await page.screenshot({
    path: path.join(output, "studio.png"),
    fullPage: true,
    animations: "disabled",
  });
  const report = {
    status: "PASS",
    baseUrl,
    browserVersion: browser.version(),
    viewport: { width: 3200, height: 1000 },
    model: "User",
    verifiedFields,
    requests,
    blockedPublicOrigins: blocked,
    publicRequestsCompleted: 0,
    pageErrors,
    screenshotHash: createHash("sha256").update(screenshot).digest("hex"),
    domHash: createHash("sha256").update(html).digest("hex"),
    rawDomHash: createHash("sha256").update(rawHtml).digest("hex"),
    domNormalization: "LF_AND_TRIM_LINE_END_WHITESPACE_BEFORE_HASHING",
    productionTraffic: false,
    syntheticUsers: true,
  };
  fs.writeFileSync(path.join(output, "studio.json"), `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  console.warn(
    JSON.stringify({
      status: "PASS",
      fields: verifiedFields.length,
      browser: report.browserVersion,
    }),
  );
} catch (error) {
  fs.writeFileSync(path.join(output, "studio-failure.html"), await page.content(), { flag: "wx" });
  fs.writeFileSync(
    path.join(output, "studio-failure.txt"),
    await page.locator("body").innerText(),
    { flag: "wx" },
  );
  await page.screenshot({ path: path.join(output, "studio-failure.png"), fullPage: true });
  throw error;
} finally {
  await context.close();
  await browser.close();
}
