import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  root,
  directory,
  json,
  hash,
  write,
  environment,
  npm,
  npmCli,
  scanSensitiveText,
  safeDiagnostics,
  terminateChild,
} from "../../docs/phase-plans/phase012-runtime.mjs";

const load = createRequire(import.meta.url);
const { withAdminDatabase, registerCanary, issueSession } = load("./admin-fixture.ts");
const outputArgument = process.argv[process.argv.indexOf("--output") + 1];
assert(
  process.argv.includes("--output") && outputArgument,
  "An exclusive output report path is required",
);
const outputPath = path.resolve(outputArgument);
assert(
  outputPath.startsWith(path.join(root, ".scaffold", "phase012") + path.sep),
  "Browser report must stay in the task preparation directory",
);
assert(!fs.existsSync(outputPath), "Browser reports cannot be overwritten");

const results = [],
  artifacts = [],
  commands = [],
  blockedRequestDestinations = [];
let externalRequestCount = 0,
  localRequestCount = 0;
let browserVersion = null;
let configuredBrowserOrigin = null;
let activeCase = null;

function safeBlockedDestination(value) {
  try {
    const target = new URL(value);
    const fixedPaths = [
      "/",
      "/admin",
      "/admin/login",
      "/admin/users",
      "/api/admin/users",
      "/login",
      "/favicon.ico",
      "/favicon.svg",
      "/api/auth/csrf",
      "/api/auth/providers",
      "/api/auth/callback/credentials",
      "/api/auth/session",
      "/api/auth/signout",
      "/api/auth/error",
    ];
    const routePath = ["http:", "https:", "ws:", "wss:"].includes(target.protocol)
      ? fixedPaths.includes(target.pathname)
        ? { pathname: target.pathname }
        : { pathnameSha256: createHash("sha256").update(target.pathname).digest("hex") }
      : target.protocol === "about:" && ["blank", "srcdoc"].includes(target.pathname)
        ? { pathname: target.pathname }
        : { pathname: "<non-network-payload-omitted>" };
    // Only fixed route paths or a path hash are saved. origin excludes userinfo; query/hash,
    // bodies and headers are never recorded. Scan encoded and decoded origin bytes as well.
    const destination = { protocol: target.protocol, origin: target.origin, ...routePath };
    let checked = JSON.stringify(destination);
    for (let round = 0; round < 8; round++) {
      scanSensitiveText(checked, "blocked-browser-destination");
      const decoded = decodeURIComponent(checked);
      if (decoded === checked) return destination;
      checked = decoded;
    }
  } catch {
    // Never include a URL parser error: it may reflect the original untrusted URL.
  }
  return {
    protocol: "<withheld>",
    origin: "<withheld>",
    pathname: "<withheld-by-sensitive-output-scan>",
  };
}

function recordBlockedDestination(request) {
  const destination = {
    ...safeBlockedDestination(request.url()),
    observedDuringCase: activeCase,
    resourceType: request.resourceType(),
    isNavigationRequest: request.isNavigationRequest(),
  };
  const existing = blockedRequestDestinations.find((item) =>
    Object.entries(destination).every(([key, value]) => item[key] === value),
  );
  if (existing) existing.count++;
  else blockedRequestDestinations.push({ ...destination, count: 1 });
}

async function caseRun(id, operation) {
  activeCase = id;
  try {
    const observations = await operation();
    results.push({ id, status: "PASS", observations });
  } catch (error) {
    results.push({ id, status: "FAIL", diagnostic: safeDiagnostics(error.stack ?? error) });
    throw new Error(`Browser case ${id} failed.`);
  } finally {
    activeCase = null;
  }
}

function saveReport(status, diagnostic) {
  const report = {
    schemaVersion: 1,
    phase: 12,
    status,
    simulation: true,
    productionTraffic: false,
    verificationScope: "AUTOMATED_BROWSER_A11Y",
    humanScreenReaderExperience: "NOT_EVALUATED",
    caseCount: results.length,
    results,
    artifacts,
    commands,
    browserVersion,
    configuredBrowserOrigin,
    localRequestCount,
    externalRequestCount,
    blockedRequestDestinations,
    credentials: "SYNTHETIC_NOT_ARCHIVED",
    ...(diagnostic ? { diagnostic } : {}),
  };
  const content = `${JSON.stringify(report, null, 2)}\n`;
  scanSensitiveText(content, "browser-report");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content, { flag: "wx" });
}

async function portAvailable() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function startServer(baseUrl, env, port) {
  const args = [npmCli, "run", "start", "--", "--port", String(port), "--hostname", "127.0.0.1"];
  const started = Date.now();
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: environment(env),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  let startupError = null;
  child.once("error", (error) => {
    startupError = error;
  });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (startupError || child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/admin/login`, {
        signal: AbortSignal.timeout(1_000),
        redirect: "manual",
      });
      if (response.status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* Startup polling is bounded and remains on the reserved loopback address. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) {
    terminateChild(child);
    scanSensitiveText(stdout);
    scanSensitiveText(stderr);
    commands.push({
      command: "npm start (browser fixture)",
      exitCode: child.exitCode,
      ready: false,
      stdout,
      stderr,
      durationMs: Date.now() - started,
    });
    throw new Error("The real Next.js authentication server did not become ready.");
  }
  return async () => {
    terminateChild(child);
    scanSensitiveText(stdout);
    scanSensitiveText(stderr);
    commands.push({
      command: "npm start (browser fixture)",
      ready: true,
      stoppedByFixture: true,
      stdout,
      stderr,
      durationMs: Date.now() - started,
    });
  };
}

async function csrf(api) {
  const response = await api.get("/api/auth/csrf");
  assert.equal(response.status(), 200, "Auth.js CSRF endpoint must be reachable");
  const body = await response.json();
  assert(
    typeof body.csrfToken === "string" && /^[a-f0-9]{64}$/.test(body.csrfToken),
    "Auth.js must issue a CSRF token",
  );
  registerCanary({ csrfToken: body.csrfToken });
  return body.csrfToken;
}

async function saveCleanPage(page, label) {
  assert(
    await page
      .locator("input")
      .evaluateAll((inputs) => inputs.every((input) => input.value === "")),
    "Never capture populated credential fields",
  );
  const html = await page.content();
  scanSensitiveText(html, label);
  const pngPath = `${directory}/${label}.png`,
    htmlPath = `${directory}/${label}.html`;
  assert(!fs.existsSync(path.join(root, pngPath)), "Screenshots cannot be overwritten");
  await page.screenshot({ path: path.join(root, pngPath), fullPage: true, animations: "disabled" });
  write(htmlPath, html);
  for (const file of [pngPath, htmlPath]) artifacts.push({ path: file, sha256: hash(file) });
}

async function accessibility(page, label) {
  const axePath = load.resolve("axe-core/axe.min.js");
  const script = await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(async () =>
    window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    }),
  );
  await script.evaluate((element) => element.remove());
  const file = `${directory}/${label}-axe.json`;
  scanSensitiveText(JSON.stringify(result), label);
  write(file, result);
  artifacts.push({ path: file, sha256: hash(file) });
  assert.equal(
    result.violations.length,
    0,
    "Admin page must have zero automated WCAG A/AA violations",
  );
  return {
    violations: 0,
    passes: result.passes.length,
    incomplete: result.incomplete.length,
    version: result.testEngine.version,
  };
}
async function runBrowser() {
  const baseline = json("docs/runtime-baseline.json");
  const { chromium } = await import(
    pathToFileURL(path.join(root, baseline.toolPaths.playwright)).href
  );
  const executablePath = path.join(
    root,
    baseline.toolPaths.playwrightBrowsers,
    "chromium-" + baseline.browser.build,
    "chrome-win",
    "chrome.exe",
  );
  await withAdminDatabase(async (fixture) => {
    // Display-only fixture identities are fixed, synthetic .invalid values. Generated login
    // passwords and session tokens remain canaries and are never captured or archived.
    const adminEmail = "admin-ui@phase012.invalid";
    await fixture.admin.user.update({
      where: { id: fixture.seed.userId },
      data: {
        email: adminEmail,
        name: "验收管理员",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    const credential = await fixture.admin.user.findUniqueOrThrow({
      where: { id: fixture.seed.userId },
      select: { passwordHash: true },
    });
    const rows = Array.from({ length: 25 }, (_, index) => ({
      id: "phase012_ui_" + String(index).padStart(3, "0"),
      email: "user" + String(index).padStart(2, "0") + "@phase012.invalid",
      name: "合成用户 " + String(index + 1).padStart(2, "0"),
      passwordHash: credential.passwordHash,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    }));
    await fixture.admin.user.createMany({ data: rows });
    const target = rows.at(-1);
    await issueSession(fixture, target.id, "USER");
    const port = await portAvailable();
    const baseUrl = "http://127.0.0.1:" + port;
    configuredBrowserOrigin = baseUrl;
    const serverEnv = {
      DATABASE_URL: fixture.url,
      AUTH_URL: baseUrl,
      AUTH_SECRET: fixture.config.authSecret,
      AUTH_TRUSTED_PROXY_CIDRS: "",
      NODE_ENV: "production",
    };
    const build = await npm(["run", "build"], { env: serverEnv });
    commands.push(build);
    const stopServer = await startServer(baseUrl, serverEnv, port);
    let browser;
    try {
      browser = await chromium.launch({ executablePath, headless: true });
      browserVersion = browser.version();
      assert.equal(browserVersion, baseline.browser.chromiumVersion);
      const context = await browser.newContext({
        baseURL: baseUrl,
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        reducedMotion: "reduce",
        viewport: { width: 375, height: 812 },
      });
      await context.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin === baseUrl) {
          localRequestCount++;
          await route.continue();
        } else {
          externalRequestCount++;
          recordBlockedDestination(route.request());
          await route.abort();
        }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(safeDiagnostics(error.message)));
      const api = context.request;
      let patchCount = 0;
      page.on("request", (request) => {
        if (
          request.method() === "PATCH" &&
          new URL(request.url()).pathname.startsWith("/api/admin/users/")
        )
          patchCount++;
      });
      const loaded = async () => {
        await page.getByRole("region", { name: "用户列表，可横向滚动" }).waitFor();
        await page.waitForFunction(
          () =>
            document
              .querySelector('[aria-label="用户列表，可横向滚动"]')
              ?.getAttribute("aria-busy") === "false",
        );
      };
      const applyFilters = async (role, status = "") => {
        await page.getByLabel("筛选角色", { exact: true }).selectOption(role);
        await page.getByLabel("筛选状态", { exact: true }).selectOption(status);
        const response = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/admin/users" &&
            response.request().method() === "GET",
        );
        await page.getByRole("button", { name: "应用筛选", exact: true }).click();
        assert.equal((await response).status(), 200);
        await loaded();
      };
      await caseRun("public-login-layout-375", async () => {
        const redirect = await api.get("/admin", { maxRedirects: 0 });
        assert.equal(redirect.status(), 307);
        assert.equal(new URL(redirect.headers().location, baseUrl).pathname, "/admin/login");
        await page.goto("/admin/login", { waitUntil: "networkidle" });
        assert.equal(await page.locator("[data-admin-shell]").count(), 0);
        assert.equal(await page.getByRole("navigation", { name: "后台导航" }).count(), 0);
        const a11y = await accessibility(page, "admin-login-375");
        await saveCleanPage(page, "admin-login-375");
        return { noShell: true, viewport: 375, a11y };
      });
      await caseRun("real-login-protected-shell", async () => {
        await page.getByLabel("邮箱", { exact: true }).fill(adminEmail);
        await page.getByLabel("密码", { exact: true }).fill(fixture.seed.password);
        await page.getByRole("button", { name: "登录", exact: true }).click();
        await page.waitForURL("**/admin/users");
        await loaded();
        assert.equal(await page.getByRole("heading", { name: "用户管理", exact: true }).count(), 1);
        assert.equal(await page.locator("[data-admin-shell]").count(), 1);
        const redirect = await api.get("/admin", { maxRedirects: 0 });
        assert.equal(redirect.status(), 307);
        assert.equal(new URL(redirect.headers().location, baseUrl).pathname, "/admin/users");
        const links = await page
          .getByRole("navigation", { name: "后台导航" })
          .locator("a[href]")
          .evaluateAll((items) => items.map((item) => item.getAttribute("href")));
        assert.deepEqual(links, ["/admin/users"]);
        assert.equal(
          await page
            .getByRole("link", { name: "用户管理", exact: true })
            .getAttribute("aria-current"),
          "page",
        );
        assert.equal((await api.get("/admin/users")).status(), 200);
        assert.equal((await api.get("/admin/not-implemented")).status(), 404);
        for (const cookie of await context.cookies()) registerCanary({ cookie: cookie.value });
        return {
          shellCount: 1,
          links,
          deterministicRedirect: "/admin/users",
          syntheticDisplayIdentities: true,
        };
      });
      await caseRun("filter-keyset-pagination", async () => {
        await applyFilters("USER");
        const first = await page
          .locator("tbody tr[data-user-id]")
          .evaluateAll((items) => items.map((item) => item.getAttribute("data-user-id")));
        assert.equal(first.length, 20);
        const response = page.waitForResponse(
          (response) => new URL(response.url()).pathname === "/api/admin/users",
        );
        await page.getByRole("button", { name: "下一页", exact: true }).click();
        assert.equal((await response).status(), 200);
        await loaded();
        const second = await page
          .locator("tbody tr[data-user-id]")
          .evaluateAll((items) => items.map((item) => item.getAttribute("data-user-id")));
        assert.equal(second.length, 5);
        assert.equal(new Set([...first, ...second]).size, 25);
        assert.equal(
          await page.getByRole("button", { name: "下一页", exact: true }).isDisabled(),
          true,
        );
        await page.getByRole("button", { name: "上一页", exact: true }).click();
        await loaded();
        await applyFilters("ADMIN", "DISABLED");
        assert.match(await page.locator("tbody").innerText(), /当前筛选下无用户/);
        await applyFilters("");
        return { firstPage: 20, secondPage: 5, uniqueRows: 25, emptyIsExplicit: true };
      });
      await caseRun("edit-save-session-audit", async () => {
        const before = await fixture.admin.user.findUniqueOrThrow({
          where: { id: target.id },
          select: { revision: true, sessionVersion: true },
        });
        const trigger = page.getByRole("button", { name: "编辑 " + target.email, exact: true });
        await trigger.click();
        assert.equal(
          await page
            .getByLabel("角色", { exact: true })
            .evaluate((element) => element === document.activeElement),
          true,
        );
        await page.getByLabel("状态", { exact: true }).selectOption("DISABLED");
        await page.getByLabel("变更原因", { exact: true }).fill("调整合成账户的访问权限");
        const response = page.waitForResponse(
          (response) => response.request().method() === "PATCH",
        );
        const previousCount = patchCount;
        await page.getByRole("button", { name: "保存变更", exact: true }).click();
        assert.equal((await response).status(), 200);
        await page.getByText("用户权限已更新，原有登录已失效。", { exact: true }).waitFor();
        assert.equal(patchCount - previousCount, 1);
        const after = await fixture.admin.user.findUniqueOrThrow({
          where: { id: target.id },
          select: { revision: true, sessionVersion: true, status: true },
        });
        assert.equal(after.revision, before.revision + 1);
        assert.equal(after.sessionVersion, before.sessionVersion + 1);
        assert.equal(after.status, "DISABLED");
        assert.equal(
          await fixture.admin.authSession.count({ where: { userId: target.id, status: "ACTIVE" } }),
          0,
        );
        assert.equal(
          await fixture.admin.auditLog.count({
            where: { action: "USER_UPDATE", targetId: target.id },
          }),
          1,
        );
        assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
        return {
          revisionBefore: before.revision,
          revisionAfter: after.revision,
          sessionVersionIncrement: 1,
          activeSessionsAfter: 0,
          auditCount: 1,
          patchRequests: 1,
          focusRestored: true,
        };
      });
      await caseRun("stale-edit-requires-new-selection", async () => {
        await page.getByRole("button", { name: "编辑 " + target.email, exact: true }).click();
        await page.getByLabel("角色", { exact: true }).selectOption("ADMIN");
        await page.getByLabel("变更原因", { exact: true }).fill("演示并发修改");
        const token = await csrf(api);
        const concurrent = await api.patch("/api/admin/users/" + target.id, {
          headers: {
            origin: baseUrl,
            "sec-fetch-site": "same-origin",
            "x-csrf-token": token,
            "Idempotency-Key": "phase012-browser-concurrent",
          },
          data: {
            role: "USER",
            status: "ACTIVE",
            expectedVersion: 1,
            reason: "先完成的合成管理操作",
          },
        });
        assert.equal(concurrent.status(), 200);
        const response = page.waitForResponse(
          (response) => response.request().method() === "PATCH",
        );
        await page.getByRole("button", { name: "保存变更", exact: true }).click();
        assert.equal((await response).status(), 409);
        const message = page.getByRole("alert").filter({ hasText: "记录已被其他管理员更新" });
        await message.waitFor();
        assert.equal(await page.getByRole("form", { name: "编辑用户" }).count(), 0);
        assert.equal(await message.evaluate((element) => element === document.activeElement), true);
        assert.match(await message.innerText(), /普通用户.*正常.*版本 2/);
        await saveCleanPage(page, "admin-users-conflict-375");
        await page.getByRole("button", { name: "编辑 " + target.email, exact: true }).click();
        assert.equal(await page.getByLabel("角色", { exact: true }).inputValue(), "USER");
        assert.equal(await page.getByLabel("变更原因", { exact: true }).inputValue(), "");
        await page.getByRole("button", { name: "取消编辑", exact: true }).click();
        return {
          httpStatus: 409,
          latestVersion: 2,
          staleIntentCleared: true,
          conflictFocused: true,
        };
      });
      await caseRun("responsive-keyboard-axe", async () => {
        const nav = page.getByRole("navigation", { name: "后台导航" });
        const link = nav.getByRole("link", { name: "用户管理", exact: true });
        await link.focus();
        await page.keyboard.press("Tab");
        assert.equal(
          await nav
            .getByRole("button", { name: "退出登录" })
            .evaluate((element) => element === document.activeElement),
          true,
        );
        await page.keyboard.press("Shift+Tab");
        assert.equal(await link.evaluate((element) => element === document.activeElement), true);
        await page.keyboard.press("End");
        assert.equal(
          await nav
            .getByRole("button", { name: "退出登录" })
            .evaluate((element) => element === document.activeElement),
          true,
        );
        await page.keyboard.press("Home");
        assert.equal(await link.evaluate((element) => element === document.activeElement), true);
        await page.keyboard.press("Escape");
        const open = page.getByRole("button", { name: "展开后台导航" });
        assert.equal(await open.evaluate((element) => element === document.activeElement), true);
        assert.equal(await nav.isVisible(), false);
        await open.click();
        const observations = [];
        for (const width of [375, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(() => window.scrollTo(0, 0));
          const bounds = await page.evaluate(() => ({
            viewport: innerWidth,
            scroll: document.documentElement.scrollWidth,
          }));
          assert(
            bounds.scroll <= bounds.viewport + 1,
            "Only the table region may scroll horizontally",
          );
          const a11y = await accessibility(page, "admin-users-" + width);
          await saveCleanPage(page, "admin-users-" + width);
          observations.push({ width, documentScrollWidth: bounds.scroll, a11y });
        }
        return { observations, keyboard: ["Tab", "Home", "End", "Escape"], focusReturn: true };
      });
      await caseRun("database-failure-retry", async () => {
        await fixture.admin.$executeRawUnsafe('REVOKE SELECT ON TABLE "User" FROM phase012_app');
        try {
          const response = page.waitForResponse(
            (response) => new URL(response.url()).pathname === "/api/admin/users",
          );
          await page.getByRole("button", { name: "刷新列表", exact: true }).click();
          assert.equal((await response).status(), 503);
          await page.getByRole("alert").filter({ hasText: "用户列表暂时不可用" }).waitFor();
          assert.equal(await page.getByText("当前筛选下无用户。", { exact: true }).count(), 0);
        } finally {
          await fixture.admin.$executeRawUnsafe('GRANT SELECT ON TABLE "User" TO phase012_app');
        }
        const response = page.waitForResponse(
          (response) => new URL(response.url()).pathname === "/api/admin/users",
        );
        await page.getByRole("button", { name: "刷新列表", exact: true }).click();
        assert.equal((await response).status(), 200);
        await loaded();
        assert.equal(await page.getByRole("main").getByRole("alert").count(), 0);
        // Next.js keeps a separate accessibility announcer in an open shadow root.
        assert.equal(await page.locator("next-route-announcer").getByRole("alert").count(), 1);
        return {
          injectedDatabaseFailure: 503,
          retryStatus: 200,
          emptyStateNotUsedForFailure: true,
          managementAlertsAfterRetry: 0,
          separateRouteAnnouncer: true,
        };
      });
      await caseRun("logout-closes-management-access", async () => {
        await page
          .getByRole("navigation", { name: "后台导航" })
          .getByRole("button", { name: "退出登录" })
          .click();
        await page.waitForURL("**/admin/login");
        assert.equal(await page.locator("[data-admin-shell]").count(), 0);
        assert.equal((await api.get("/api/admin/users")).status(), 401);
        assert.equal(
          await fixture.admin.authSession.count({
            where: { userId: fixture.seed.userId, status: "ACTIVE" },
          }),
          0,
        );
        return { revokedSessions: true, nextProtectedRequest: 401, publicLoginHasNoShell: true };
      });
      assert.deepEqual(pageErrors, []);
      assert.equal(externalRequestCount, 0);
      await context.close();
    } finally {
      if (browser) await browser.close();
      await stopServer();
    }
  });
}

try {
  await runBrowser();
  saveReport("PASS");
  console.warn(
    JSON.stringify({ status: "PASS", phase: 12, cases: results.length, externalRequestCount }),
  );
} catch (error) {
  saveReport("FAIL", safeDiagnostics(error.stack ?? error));
  console.error(safeDiagnostics(error.stack ?? error));
  process.exitCode = 1;
}
