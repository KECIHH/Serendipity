import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  root,
  directory,
  json,
  hash,
  write,
  environment,
  npmCli,
  scanSensitiveText,
  safeDiagnostics,
  terminateChild,
} from "../../docs/phase-plans/phase014-runtime.mjs";

const load = createRequire(import.meta.url);
const { withApiKeyDatabase, registerCanary, createSubject } = load(
  "../phase013/api-key-fixture.ts",
);
const { populateSettings } = load("./fixture.ts");
const outputArg = process.argv.indexOf("--output");
assert(outputArg >= 0);
const outputPath = path.resolve(process.argv[outputArg + 1]);
assert(outputPath.startsWith(path.join(root, ".scaffold", "phase014") + path.sep));
assert(!fs.existsSync(outputPath));
const diagnostic = process.argv.includes("--diagnostic");
const artifactRoot = diagnostic
  ? path.relative(root, outputPath.replace(/\.json$/, "-assets")).replaceAll("\\", "/")
  : `${directory}/browser`;
const loginAttempts = [];
const results = [],
  artifacts = [],
  commands = [],
  responseEvidence = [],
  responseChecks = [];
let externalRequestCount = 0,
  localRequestCount = 0,
  privacyFailures = 0,
  browserVersion = null,
  serverOrigin = null;
const secretScans = {
  httpBodies: 0,
  html: 0,
  browserStorage: 0,
  logs: 0,
  audit: 0,
  trace: 0,
  evidence: 0,
  hits: 0,
};
function scan(value, category) {
  secretScans[category]++;
  try {
    scanSensitiveText(
      typeof value === "string" ? value : JSON.stringify(value),
      `browser:${category}`,
    );
  } catch (error) {
    secretScans.hits++;
    throw error;
  }
}
async function caseRun(id, operation) {
  try {
    const observations = await operation();
    results.push({ id, status: "PASS", observations });
  } catch (error) {
    results.push({ id, status: "FAIL", diagnostic: safeDiagnostics(error.stack ?? error) });
    throw new Error(`Browser case ${id} failed`);
  }
}
function saveReport(status, error) {
  const report = {
    phase: 14,
    status,
    simulation: true,
    productionTraffic: false,
    notGate: diagnostic,
    verificationScope: "AUTOMATED_BROWSER_A11Y",
    humanScreenReaderExperience: "NOT_EVALUATED",
    results,
    artifacts,
    commands,
    responseEvidence,
    loginAttempts,
    browserVersion,
    serverOrigin,
    externalRequestCount,
    localRequestCount,
    privacyFailures,
    secretScans,
    credentials: "SYNTHETIC_NOT_ARCHIVED",
    ...(error ? { diagnostic: safeDiagnostics(error) } : {}),
  };
  scan(report, "evidence");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
}

async function freePort() {
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
async function startServer(fixture, baseUrl, port) {
  const scope = path.join(
    root,
    ".scaffold",
    "phase014",
    `browser-network-${randomBytes(5).toString("hex")}`,
  );
  fs.mkdirSync(scope, { recursive: true });
  const guardPath = path.join(scope, "guard.cjs"),
    networkLog = path.join(scope, "network.jsonl");
  const source = fs
    .readFileSync(path.join(root, "tests/phase006/cli-network-guard.cjs"), "utf8")
    .replaceAll("PHASE006_NETWORK_LOG", "PHASE014_BROWSER_NETWORK_LOG")
    .replace(
      'path.resolve(__dirname, "../../.scaffold/phase006")',
      `path.resolve(${JSON.stringify(path.join(root, ".scaffold", "phase014"))})`,
    )
    .replaceAll("Phase006", "Phase014");
  fs.writeFileSync(guardPath, source, { flag: "wx" });
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [npmCli, "run", "start", "--", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment({
        DATABASE_URL: fixture.url,
        AUTH_URL: baseUrl,
        AUTH_SECRET: fixture.config.authSecret,
        ENCRYPTION_KEY: fixture.config.encryptionKey,
        NODE_ENV: "production",
        PHASE014_BROWSER_NETWORK_LOG: networkLog,
        NODE_OPTIONS: `--require ${JSON.stringify(guardPath)}`,
      }),
    },
  );
  let stdout = "",
    stderr = "",
    startupError = false,
    ready = false;
  child.stdout.on("data", (data) => {
    stdout += data.toString();
  });
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  child.once("error", () => {
    startupError = true;
  });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (startupError || child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/admin/login`, {
        redirect: "manual",
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* Bounded loopback readiness probe. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) {
    terminateChild(child);
    scan(stdout, "logs");
    scan(stderr, "logs");
    commands.push({
      command: "npm run start (isolated browser)",
      ready,
      stdout,
      stderr,
      durationMs: Date.now() - started,
    });
    throw new Error("The production Next.js server was not ready");
  }
  return async () => {
    terminateChild(child);
    scan(stdout, "logs");
    scan(stderr, "logs");
    const network = fs
      .readFileSync(networkLog, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert(network.some((item) => item.kind === "process"));
    assert(
      network.every((item) => item.blockedBeforeNetwork !== true),
      "No public server requests are permitted",
    );
    scan(network, "trace");
    commands.push({
      command: "npm run start (isolated browser)",
      ready: true,
      stoppedByFixture: true,
      stdout,
      stderr,
      durationMs: Date.now() - started,
      nodeNetworkGuard: {
        sourcePath: "tests/phase006/cli-network-guard.cjs",
        sourceHash: hash("tests/phase006/cli-network-guard.cjs"),
        preparedHash: createHash("sha256").update(source).digest("hex"),
        requests: network.filter((item) => item.kind === "request").length,
        publicRequests: 0,
      },
    });
  };
}
async function screenshot(page, label) {
  assert(
    await page
      .locator('input[type="password"]')
      .evaluateAll((items) => items.every((item) => item.value === "")),
    "Only empty secret controls may be captured",
  );
  const html = (await page.content()).replaceAll("\r\n", "\n");
  scan(html, "html");
  const png = `${artifactRoot}/${label}.png`,
    dom = `${artifactRoot}/${label}.html`;
  assert(!fs.existsSync(path.join(root, png)) && !fs.existsSync(path.join(root, dom)));
  fs.mkdirSync(path.dirname(path.join(root, png)), { recursive: true });
  await page.screenshot({ path: path.join(root, png), fullPage: true, animations: "disabled" });
  write(dom, html);
  for (const file of [png, dom]) artifacts.push({ path: file, sha256: hash(file) });
}
async function a11y(page, label) {
  // Inspect the settled state after finite CSS transitions; retain the original styles.
  await page.evaluate(async () => {
    await Promise.allSettled(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    );
  });
  const axePath = load.resolve("axe-core/axe.min.js");
  const script = await page.addScriptTag({ path: axePath });
  const report = await page.evaluate(async () =>
    window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    }),
  );
  await script.evaluate((element) => element.remove());
  scan(report, "html");
  const file = `${artifactRoot}/${label}-axe.json`;
  write(file, report);
  artifacts.push({ path: file, sha256: hash(file) });
  assert.equal(report.violations.length, 0, "Automatic browser accessibility must pass");
  return {
    violations: 0,
    passes: report.passes.length,
    incomplete: report.incomplete.length,
    version: report.testEngine.version,
  };
}
async function csrf(api) {
  const response = await api.get("/api/auth/csrf");
  assert.equal(response.status(), 200);
  const value = await response.json();
  assert(typeof value.csrfToken === "string" && /^[a-f0-9]{64}$/.test(value.csrfToken));
  registerCanary({ csrfToken: value.csrfToken });
  return value.csrfToken;
}

async function run() {
  const baseline = json("docs/runtime-baseline.json");
  const { chromium } = await import(
    pathToFileURL(path.join(root, baseline.toolPaths.playwright)).href
  );
  const executablePath = path.join(
    root,
    baseline.toolPaths.playwrightBrowsers,
    `chromium-${baseline.browser.build}`,
    "chrome-win",
    "chrome.exe",
  );
  assert(fs.existsSync(path.join(root, ".next/BUILD_ID")), "Build first");
  await withApiKeyDatabase(async (fixture) => {
    await populateSettings(fixture);
    const email = "admin-ui@phase014.invalid";
    await fixture.admin.user.update({
      where: { id: fixture.seed.userId },
      data: { email, name: "验收管理员" },
    });
    await fixture.admin.$executeRawUnsafe(
      "CREATE OR REPLACE FUNCTION public.auth_now() RETURNS TIMESTAMPTZ LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT now(); $$",
    );
    const port = await freePort(),
      baseUrl = `http://127.0.0.1:${port}`;
    serverOrigin = baseUrl;
    const stop = await startServer(fixture, baseUrl, port);
    let browser;
    try {
      browser = await chromium.launch({ executablePath, headless: true });
      browserVersion = browser.version();
      assert.equal(browserVersion, baseline.browser.chromiumVersion);
      const makeContext = async () => {
        const context = await browser.newContext({
          baseURL: baseUrl,
          locale: "zh-CN",
          timezoneId: "Asia/Shanghai",
          reducedMotion: "reduce",
          viewport: { width: 1280, height: 900 },
        });
        await context.route("**/*", async (route) => {
          if (new URL(route.request().url()).origin === baseUrl) {
            localRequestCount++;
            await route.continue();
          } else {
            externalRequestCount++;
            await route.abort();
          }
        });
        return context;
      };
      const context = await makeContext(),
        api = context.request,
        page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(safeDiagnostics(error.message)));
      page.on("console", (message) => {
        try {
          scan(message.text(), "logs");
        } catch {
          privacyFailures++;
        }
      });
      page.on("response", (response) => {
        const url = new URL(response.url());
        if (!url.pathname.startsWith("/api/admin/") && url.pathname !== "/api/config/public")
          return;
        responseChecks.push(
          response
            .text()
            .then((body) => {
              scan(body, "httpBodies");
              responseEvidence.push({
                path: url.pathname,
                status: response.status(),
                method: response.request().method(),
                bytes: Buffer.byteLength(body),
                sha256: createHash("sha256").update(body).digest("hex"),
              });
            })
            .catch(() => {
              privacyFailures++;
            }),
        );
      });
      const responseFor = (method, pathname) => {
        const pending = page.waitForResponse(
          (response) =>
            response.request().method() === method && new URL(response.url()).pathname === pathname,
        );
        void pending.catch(() => {});
        return pending;
      };
      const navigation = page.getByRole("navigation", { name: "后台导航" });
      const loadedDashboard = () => page.getByText("用户总数", { exact: true }).waitFor();
      const loadedSettings = () =>
        page.getByRole("region", { name: "系统配置列表，可横向滚动" }).waitFor();
      const login = async (target, account, password, audience = "ADMIN") => {
        await target.goto(audience === "ADMIN" ? "/admin/login" : "/login");
        await target.getByLabel("邮箱", { exact: true }).fill(account);
        await target.getByLabel("密码", { exact: true }).fill(password);
        const statuses = [];
        loginAttempts.push({ audience, statuses });
        for (let attempt = 0; attempt < 5; attempt++) {
          const pending = target.waitForResponse(
            (response) =>
              response.request().method() === "POST" &&
              new URL(response.url()).pathname === "/api/auth/callback/credentials",
          );
          void pending.catch(() => {});
          await target.getByRole("button", { name: "登录", exact: true }).click();
          const response = await pending;
          statuses.push(response.status());
          if (response.status() !== 503) break;
          await target.getByRole("alert").filter({ hasText: "登录服务暂时不可用" }).waitFor();
        }
        assert.equal(
          statuses.at(-1),
          200,
          `Real ${audience} login statuses: ${statuses.join(",")}`,
        );
        await target.waitForURL(audience === "ADMIN" ? `${baseUrl}/admin` : `${baseUrl}/`);
      };
      await caseRun("login-navigation", async () => {
        for (const pathname of ["/api/admin/settings", "/api/admin/dashboard/stats"])
          assert.equal((await api.get(pathname)).status(), 401);
        for (const pathname of [
          "/admin",
          "/admin/users",
          "/admin/api-keys",
          "/admin/logs",
          "/admin/settings",
        ]) {
          await page.goto(pathname);
          assert.equal(new URL(page.url()).pathname, "/admin/login");
          assert.equal(await page.locator("[data-admin-shell]").count(), 0);
        }
        await login(page, email, fixture.seed.password);
        await loadedDashboard();
        const links = await navigation
          .getByRole("link")
          .evaluateAll((items) => items.map((item) => item.getAttribute("href")));
        assert.deepEqual(links, [
          "/admin",
          "/admin/users",
          "/admin/api-keys",
          "/admin/logs",
          "/admin/settings",
        ]);
        for (const [name, heading] of [
          ["用户管理", "用户管理"],
          ["密钥管理", "密钥管理"],
          ["审计日志", "审计日志"],
          ["系统配置", "系统配置"],
          ["Dashboard", "Dashboard"],
        ]) {
          await navigation.getByRole("link", { name, exact: true }).click();
          await page.getByRole("heading", { level: 1, name: heading, exact: true }).waitFor();
          assert.equal(await navigation.locator('[aria-current="page"]').count(), 1);
        }
        await loadedDashboard();
        const accessibility = await a11y(page, "dashboard-desktop");
        await screenshot(page, "dashboard-desktop");
        return {
          anonymousApisDenied: 2,
          protectedPagesRedirected: 5,
          liveMenus: links,
          accessibility,
        };
      });
      await caseRun("settings-edit-conflict", async () => {
        await navigation.getByRole("link", { name: "系统配置", exact: true }).click();
        await loadedSettings();
        const row = page.getByRole("row").filter({ hasText: "planner.quick.defaultDurationDays" });
        const edit = row.getByRole("button", { name: /^编辑 / });
        await edit.click();
        const editor = page.getByRole("textbox", { name: "配置值（JSON）" });
        assert(await editor.evaluate((el) => el === document.activeElement));
        await editor.fill("not-json");
        await page.getByRole("button", { name: "保存配置", exact: true }).click();
        await page.getByRole("main").getByRole("alert").filter({ hasText: "有效 JSON" }).waitFor();
        await editor.fill("5");
        let pending = responseFor("PATCH", "/api/admin/settings/planner.quick.defaultDurationDays");
        await page.getByRole("button", { name: "保存配置", exact: true }).click();
        assert.equal((await pending).status(), 200);
        await page.getByText("配置已保存，变更已记录。", { exact: true }).waitFor();
        assert(await edit.evaluate((el) => el === document.activeElement));
        await edit.click();
        await editor.press("Escape");
        assert(await edit.evaluate((el) => el === document.activeElement));
        await edit.click();
        await page.getByRole("button", { name: "取消", exact: true }).click();
        assert(await edit.evaluate((el) => el === document.activeElement));
        await edit.click();
        await editor.fill("6");
        const token = await csrf(api),
          key = randomUUID();
        registerCanary({ idempotencyKey: key });
        const winner = await api.patch("/api/admin/settings/planner.quick.defaultDurationDays", {
          headers: { "x-csrf-token": token, "Idempotency-Key": key, origin: baseUrl },
          data: { valueJson: 8, expectedVersion: 1 },
        });
        assert.equal(winner.status(), 200);
        scan(await winner.text(), "httpBodies");
        pending = responseFor("PATCH", "/api/admin/settings/planner.quick.defaultDurationDays");
        await page.getByRole("button", { name: "保存配置", exact: true }).click();
        assert.equal((await pending).status(), 409);
        await loadedSettings();
        await page.getByText(/配置已被其他操作更新/).waitFor();
        assert.equal(await page.getByRole("textbox").count(), 0);
        await edit.click();
        assert.equal(await editor.inputValue(), "8");
        await editor.press("Escape");
        const target = await fixture.admin.systemConfig.findUniqueOrThrow({
          where: { key: "planner.quick.defaultDurationDays" },
        });
        const audits = await fixture.admin.auditLog.count({
          where: { action: "CONFIG_UPDATE", targetId: target.id },
        });
        assert.equal(target.revision, 2);
        assert.equal(audits, 2);
        const accessibility = await a11y(page, "settings-desktop");
        await screenshot(page, "settings-desktop");
        return {
          validWrites: 2,
          revision: target.revision,
          matchingAudits: audits,
          staleStatus: 409,
          invalidJsonPrevented: true,
          focusRestored: ["save", "escape", "cancel"],
          accessibility,
        };
      });
      await caseRun("dashboard-states", async () => {
        let release;
        const blocker = new Promise((resolve) => {
          release = resolve;
        });
        await page.route("**/api/admin/dashboard/stats", async (route) => {
          await blocker;
          await route.continue();
        });
        await navigation.getByRole("link", { name: "Dashboard", exact: true }).click();
        await page.getByRole("status").filter({ hasText: "正在加载后台概览" }).waitFor();
        await screenshot(page, "dashboard-loading");
        release();
        await loadedDashboard();
        await page.unroute("**/api/admin/dashboard/stats");
        await page.getByRole("heading", { name: "暂无旅行记录", exact: true }).waitFor();
        await screenshot(page, "dashboard-empty-records");
        await fixture.admin.$executeRawUnsafe(
          `REVOKE SELECT ON "TravelRecord" FROM "${fixture.config.appUser}"`,
        );
        try {
          await page.getByRole("button", { name: "刷新概览", exact: true }).click();
          const failed = page.getByRole("region", { name: "旅行记录", exact: true });
          await failed.getByRole("alert").waitFor();
          assert.equal(await failed.getByText("记录总数", { exact: true }).count(), 0);
          await page.getByText("用户总数", { exact: true }).waitFor();
          assert.equal(await page.getByRole("main").getByRole("alert").count(), 1);
          await screenshot(page, "dashboard-partial-failure");
        } finally {
          await fixture.admin.$executeRawUnsafe(
            `GRANT SELECT ON "TravelRecord" TO "${fixture.config.appUser}"`,
          );
        }
        await page.getByRole("button", { name: "刷新概览", exact: true }).click();
        await loadedDashboard();
        const control = new PrismaClient({ datasourceUrl: fixture.config.url, log: [] });
        try {
          await control.$executeRawUnsafe(
            `ALTER DATABASE "${fixture.database}" ALLOW_CONNECTIONS false`,
          );
          await control.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${fixture.database} AND usename=${fixture.config.appUser}`;
          const pending = responseFor("GET", "/api/admin/dashboard/stats");
          await page.getByRole("button", { name: "刷新概览", exact: true }).click();
          assert.equal((await pending).status(), 503);
          await page
            .getByRole("main")
            .getByRole("alert")
            .filter({ hasText: "后台概览暂时无法读取" })
            .waitFor();
          assert.equal(await page.getByText("用户总数", { exact: true }).count(), 0);
          await screenshot(page, "dashboard-database-failure");
        } finally {
          await control.$executeRawUnsafe(
            `ALTER DATABASE "${fixture.database}" ALLOW_CONNECTIONS true`,
          );
          await control.$disconnect();
        }
        for (let i = 0; i < 6; i++) {
          const pending = responseFor("GET", "/api/admin/dashboard/stats");
          await page.getByRole("button", { name: "重试", exact: true }).click();
          if ((await pending).status() === 200) break;
          await page.getByRole("button", { name: "重试", exact: true }).waitFor();
        }
        await loadedDashboard();
        assert.equal(await page.getByRole("main").getByRole("alert").count(), 0);
        return {
          realRequestHeldForLoading: true,
          trueEmptyTravelRecords: true,
          failedWidgets: 1,
          preservedWidgets: 3,
          databaseOutageStatus: 503,
          sameServerRecovered: true,
        };
      });
      await caseRun("settings-states", async () => {
        let release;
        const blocker = new Promise((resolve) => {
          release = resolve;
        });
        await page.route("**/api/admin/settings", async (route) => {
          await blocker;
          await route.continue();
        });
        await navigation.getByRole("link", { name: "系统配置", exact: true }).click();
        await page.getByRole("status").filter({ hasText: "正在加载配置" }).waitFor();
        await screenshot(page, "settings-loading");
        let restoredResponse = responseFor("GET", "/api/admin/settings");
        release();
        const postOutageReads = [(await restoredResponse).status()];
        for (let attempt = 0; postOutageReads.at(-1) === 503 && attempt < 4; attempt++) {
          await page.getByRole("main").getByRole("alert").waitFor();
          restoredResponse = responseFor("GET", "/api/admin/settings");
          await page.getByRole("button", { name: "重试", exact: true }).click();
          postOutageReads.push((await restoredResponse).status());
        }
        assert.equal(postOutageReads.at(-1), 200);
        await loadedSettings();
        await page.unroute("**/api/admin/settings");
        await fixture.admin.$executeRawUnsafe(
          `REVOKE SELECT ON "SystemConfig" FROM "${fixture.config.appUser}"`,
        );
        try {
          await page.getByRole("button", { name: "刷新配置", exact: true }).click();
          await page.getByRole("main").getByRole("alert").waitFor();
          assert.equal(await page.getByRole("heading", { name: "此分组暂无配置" }).count(), 0);
          await screenshot(page, "settings-error");
        } finally {
          await fixture.admin.$executeRawUnsafe(
            `GRANT SELECT ON "SystemConfig" TO "${fixture.config.appUser}"`,
          );
        }
        await page.getByRole("button", { name: "重试", exact: true }).click();
        await loadedSettings();
        await fixture.admin.systemConfig.delete({ where: { key: "ui.notice" } });
        await page.getByRole("button", { name: "刷新配置", exact: true }).click();
        await loadedSettings();
        await page.getByLabel("配置分组", { exact: true }).selectOption("UI");
        await page.getByRole("heading", { name: "此分组暂无配置", exact: true }).waitFor();
        await screenshot(page, "settings-empty");
        await populateSettings(fixture);
        await page.getByLabel("配置分组", { exact: true }).selectOption("");
        await page.getByRole("button", { name: "刷新配置", exact: true }).click();
        await loadedSettings();
        return {
          loading: "REAL_REQUEST_DELAY",
          failure: "POSTGRESQL_PERMISSION_DENIED",
          empty: "REAL_EMPTY_GROUP",
          recovered: true,
          postOutageReads,
        };
      });
      await caseRun("mobile-keyboard", async () => {
        await page.setViewportSize({ width: 375, height: 812 });
        const toggle = page.getByRole("button", { name: /(?:展开|收起)后台导航/, exact: false });
        if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
        await toggle.focus();
        await toggle.press("Enter");
        await navigation.getByRole("link", { name: "Dashboard", exact: true }).focus();
        await page.keyboard.press("End");
        assert(
          await page
            .getByRole("button", { name: "退出登录", exact: true })
            .evaluate((el) => el === document.activeElement),
        );
        await page.keyboard.press("Escape");
        assert(await toggle.evaluate((el) => el === document.activeElement));
        const widths = [];
        for (const [name, pathname] of [
          ["Dashboard", "/admin"],
          ["用户管理", "/admin/users"],
          ["密钥管理", "/admin/api-keys"],
          ["审计日志", "/admin/logs"],
          ["系统配置", "/admin/settings"],
        ]) {
          const apiPath = pathname === "/admin" ? "/api/admin/dashboard/stats" : `/api${pathname}`;
          let response = responseFor("GET", apiPath);
          if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.press("Enter");
          await navigation.getByRole("link", { name, exact: true }).click();
          await page.waitForURL(baseUrl + pathname);
          await page.getByRole("heading", { level: 1, name, exact: true }).waitFor();
          const reads = [(await response).status()];
          for (let attempt = 0; reads.at(-1) === 503 && attempt < 4; attempt++) {
            await page.getByRole("main").getByRole("alert").waitFor();
            response = responseFor("GET", apiPath);
            await page.getByRole("button", { name: /^刷新/ }).click();
            reads.push((await response).status());
          }
          assert.equal(reads.at(-1), 200);
          if (pathname === "/admin/settings") await loadedSettings();
          else if (pathname === "/admin") await loadedDashboard();
          else
            await page
              .getByRole("status")
              .filter({ hasText: /正在加载/ })
              .waitFor({ state: "hidden" });
          const width = await page.evaluate(() => ({
            viewport: window.innerWidth,
            document: document.documentElement.scrollWidth,
          }));
          assert(width.document <= width.viewport + 1);
          assert.equal(await page.getByRole("main").getByRole("alert").count(), 0);
          widths.push({ path: pathname, ...width, reads });
          await a11y(page, `mobile-${pathname.split("/").at(-1) || "dashboard"}`);
          await screenshot(page, `mobile-${pathname.split("/").at(-1) || "dashboard"}`);
        }
        await page.setViewportSize({ width: 1280, height: 900 });
        return {
          widths,
          keyboardNavigation: ["Enter", "End", "Escape"],
          automatedAxeViolations: 0,
        };
      });
      await caseRun("authorization-sessions", async () => {
        const denied = [],
          before = await fixture.admin.auditLog.count({ where: { action: "CONFIG_UPDATE" } });
        const user = await createSubject(fixture);
        const account = await fixture.admin.user.findUniqueOrThrow({ where: { id: user.id } });
        const password = fixture.seed.password;
        const seeded = await fixture.admin.user.findUniqueOrThrow({
          where: { id: fixture.seed.userId },
          select: { passwordHash: true },
        });
        await fixture.admin.user.update({
          where: { id: user.id },
          data: { passwordHash: seeded.passwordHash },
        });
        const userContext = await makeContext(),
          userPage = await userContext.newPage();
        await login(userPage, account.email, password, "USER");
        for (const endpoint of ["/api/admin/settings", "/api/admin/dashboard/stats"]) {
          const response = await userContext.request.get(endpoint);
          assert.equal(response.status(), 403);
          denied.push(response.status());
        }
        await userPage.goto("/admin/settings");
        assert.equal(new URL(userPage.url()).pathname, "/admin/login");
        await userContext.close();
        const staleContext = await makeContext(),
          stalePage = await staleContext.newPage();
        await login(stalePage, email, password);
        await fixture.admin.user.update({
          where: { id: fixture.seed.userId },
          data: { sessionVersion: { increment: 1 } },
        });
        assert.equal((await staleContext.request.get("/api/admin/settings")).status(), 401);
        denied.push(401);
        await staleContext.close();
        await login(page, email, password);
        await loadedDashboard();
        await fixture.admin.user.update({
          where: { id: fixture.seed.userId },
          data: { status: "DISABLED" },
        });
        assert.equal((await api.get("/api/admin/dashboard/stats")).status(), 401);
        denied.push(401);
        await fixture.admin.user.update({
          where: { id: fixture.seed.userId },
          data: { status: "ACTIVE" },
        });
        const response = await api.patch("/api/admin/settings/planner.quick.defaultDurationDays", {
          headers: { origin: baseUrl, "Idempotency-Key": randomUUID() },
          data: { valueJson: 9, expectedVersion: 2 },
        });
        assert.equal(response.status(), 403);
        denied.push(403);
        assert.equal(
          await fixture.admin.auditLog.count({ where: { action: "CONFIG_UPDATE" } }),
          before,
        );
        return {
          deniedStatuses: denied,
          unauthorizedWrites: 0,
          userPageRedirected: true,
          oldSessionRejected: true,
          disabledAdminRejected: true,
        };
      });
      await caseRun("logout", async () => {
        await navigation.getByRole("button", { name: "退出登录", exact: true }).click();
        await page.waitForURL("**/admin/login");
        assert.equal((await api.get("/api/admin/settings")).status(), 401);
        const revoked = await fixture.admin.authSession.count({
          where: { userId: fixture.seed.userId, status: "REVOKED" },
        });
        assert(revoked >= 1);
        await screenshot(page, "logged-out");
        return { apiStatus: 401, databaseRevokedSessions: revoked };
      });
      await Promise.all(responseChecks);
      scan(
        await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
        "browserStorage",
      );
      assert.deepEqual(pageErrors, []);
      assert.equal(externalRequestCount, 0);
      assert.equal(privacyFailures, 0);
      await context.close();
    } finally {
      await browser?.close();
      await stop();
    }
  });
}
try {
  await run();
  saveReport("PASS");
  console.log(JSON.stringify({ status: "PASS", browserCases: results.length }));
} catch (error) {
  saveReport("FAIL", error.stack ?? error);
  console.error(safeDiagnostics(error.stack ?? error));
  process.exitCode = 1;
}
