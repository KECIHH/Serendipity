import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
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
} from "../../docs/phase-plans/phase013-runtime.mjs";

const load = createRequire(import.meta.url);
const { withApiKeyDatabase, registerCanary } = load("./api-key-fixture.ts");
const { decryptSecret } = load("../../src/server/security/secret-envelope.ts");
const argument = process.argv.indexOf("--output");
assert(argument >= 0 && process.argv[argument + 1], "An exclusive output report is required");
const outputPath = path.resolve(process.argv[argument + 1]);
assert(outputPath.startsWith(path.join(root, ".scaffold", "phase013") + path.sep));
assert(!fs.existsSync(outputPath), "Do not overwrite browser reports");
const diagnostic = process.argv.includes("--diagnostic");
const artifactRoot = diagnostic
  ? path
      .relative(
        root,
        path.join(path.dirname(outputPath), path.basename(outputPath, ".json") + "-assets"),
      )
      .replaceAll("\\", "/")
  : directory;
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
  dbSafeProjection: 0,
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
function requestKey() {
  const key = randomUUID();
  registerCanary({ idempotencyKey: key });
  return key;
}
function secret() {
  const plainKey = `fixture-only::${randomBytes(24).toString("hex")}`;
  registerCanary({ plainKey });
  return plainKey;
}
function safeKey(value) {
  assert(value && typeof value === "object");
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      "id",
      "name",
      "provider",
      "keyFingerprintDisplay",
      "status",
      "revision",
      "lastUsedAt",
      "revokedAt",
      "createdAt",
      "updatedAt",
    ].sort(),
  );
  assert(/^[a-f0-9]{12}…$/.test(value.keyFingerprintDisplay));
  scan(value, "dbSafeProjection");
  return value;
}
async function caseRun(id, operation) {
  try {
    const observations = await operation();
    results.push({ id, status: "PASS", observations });
  } catch (error) {
    results.push({ id, status: "FAIL", diagnostic: safeDiagnostics(error.stack ?? error) });
    throw new Error(`Browser case ${id} failed.`);
  }
}
function saveReport(status, error) {
  const report = {
    schemaVersion: 1,
    phase: 13,
    status,
    simulation: true,
    productionTraffic: false,
    notGate: diagnostic,
    verificationScope: "AUTOMATED_BROWSER_A11Y",
    humanScreenReaderExperience: "NOT_EVALUATED",
    caseCount: results.length,
    results,
    artifacts,
    commands,
    browserVersion,
    serverOrigin,
    externalRequestCount,
    localRequestCount,
    privacyFailures,
    secretScans,
    responseEvidence,
    credentials: "SYNTHETIC_NOT_ARCHIVED",
    ...(error ? { diagnostic: safeDiagnostics(error) } : {}),
  };
  scan(report, "evidence");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
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
    "phase013",
    `browser-network-${randomBytes(5).toString("hex")}`,
  );
  fs.mkdirSync(scope, { recursive: true });
  const guardPath = path.join(scope, "guard.cjs"),
    networkLog = path.join(scope, "network.jsonl");
  const source = fs
    .readFileSync(path.join(root, "tests/phase006/cli-network-guard.cjs"), "utf8")
    .replaceAll("PHASE006_NETWORK_LOG", "PHASE013_BROWSER_NETWORK_LOG")
    .replace(
      'path.resolve(__dirname, "../../.scaffold/phase006")',
      `path.resolve(${JSON.stringify(path.join(root, ".scaffold", "phase013"))})`,
    )
    .replaceAll("Phase006", "Phase013");
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
        PHASE013_BROWSER_NETWORK_LOG: networkLog,
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
  assert(
    fs.existsSync(path.join(root, ".next", "BUILD_ID")),
    "Run the planned build before the browser check",
  );
  await withApiKeyDatabase(async (fixture) => {
    const email = "admin-ui@phase013.invalid";
    await fixture.admin.user.update({
      where: { id: fixture.seed.userId },
      data: { email, name: "验收管理员" },
    });
    // Use the real PostgreSQL clock in the interactive browser; deterministic clocks remain in unit/integration fixtures.
    await fixture.admin.$executeRawUnsafe(
      "CREATE OR REPLACE FUNCTION public.auth_now() RETURNS TIMESTAMPTZ LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT now(); $$",
    );
    const port = await freePort(),
      baseUrl = `http://127.0.0.1:${port}`;
    serverOrigin = baseUrl;
    const stopServer = await startServer(fixture, baseUrl, port);
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
      const page = await context.newPage(),
        api = context.request;
      page.setDefaultTimeout(15_000);
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(safeDiagnostics(error.message)));
      page.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning") {
          try {
            scan(message.text(), "logs");
          } catch {
            privacyFailures++;
          }
        }
      });
      page.on("response", (response) => {
        const url = new URL(response.url());
        if (!url.pathname.startsWith("/api/admin/api-keys") && url.pathname !== "/api/admin/logs")
          return;
        const check = response
          .text()
          .then((body) => {
            scan(body, "httpBodies");
            responseEvidence.push({
              route: url.pathname.replace(/\/api-keys\/[^/]+/, "/api-keys/{id}"),
              method: response.request().method(),
              status: response.status(),
              bytes: Buffer.byteLength(body),
              sha256: createHash("sha256").update(body).digest("hex"),
            });
          })
          .catch(() => {
            privacyFailures++;
          });
        responseChecks.push(check);
      });
      const responseFor = (method, url) =>
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === url && response.request().method() === method,
        );
      const keyLoaded = () => page.getByRole("region", { name: "密钥列表", exact: true }).waitFor();
      const logLoaded = () =>
        page.getByRole("region", { name: "审计日志列表", exact: true }).waitFor();
      const managedKey = async (id) => {
        const row = await fixture.admin.apiKeyConfig.findUniqueOrThrow({ where: { id } });
        const envelope = JSON.parse(row.encryptedKey);
        registerCanary({
          encryptedKey: row.encryptedKey,
          keyFingerprint: row.keyFingerprint,
          encryptionKeyId: row.encryptionKeyId,
          ciphertext: envelope.ciphertext,
        });
        return row;
      };
      let currentKey;
      await caseRun("unauthorized-reads-and-login", async () => {
        for (const url of ["/api/admin/api-keys", "/api/admin/logs"]) {
          const response = await api.get(url);
          assert.equal(response.status(), 401);
          scan(await response.text(), "httpBodies");
        }
        const redirect = await api.get("/admin/api-keys", { maxRedirects: 0 });
        assert.equal(redirect.status(), 307);
        await page.goto("/admin/login", { waitUntil: "networkidle" });
        assert.equal(await page.locator("[data-admin-shell]").count(), 0);
        await page.getByLabel("邮箱", { exact: true }).fill(email);
        await page.getByLabel("密码", { exact: true }).fill(fixture.seed.password);
        await page.getByRole("button", { name: "登录", exact: true }).click();
        await page.waitForURL("**/admin/users");
        await page
          .getByRole("navigation", { name: "后台导航" })
          .getByRole("link", { name: "密钥管理" })
          .click();
        await page.getByText("没有符合条件的密钥。", { exact: true }).waitFor();
        await screenshot(page, "api-keys-empty");
        return {
          unauthorizedStatuses: [401, 401],
          pageRedirect: 307,
          realLogin: true,
          initialKeys: 0,
        };
      });
      await caseRun("create-read", async () => {
        const plainKey = secret();
        await page.getByRole("button", { name: "录入密钥", exact: true }).click();
        const form = page.getByRole("form", { name: "录入密钥" });
        await form.getByLabel("名称", { exact: true }).fill("验收密钥");
        await form.getByLabel("提供方标识", { exact: true }).fill("fixture-provider");
        await form.getByLabel("密钥", { exact: true }).fill(plainKey);
        const pending = responseFor("POST", "/api/admin/api-keys");
        await form.getByRole("button", { name: "确认保存" }).click();
        const response = await pending;
        assert.equal(response.status(), 201);
        currentKey = safeKey((await response.json()).data);
        await keyLoaded();
        const row = await managedKey(currentKey.id);
        assert(
          decryptSecret(row, fixture.resolver) === plainKey,
          "Database envelope must authenticate with the original row AAD",
        );
        assert.equal(await page.locator('input[type="password"]').count(), 0);
        const token = await csrf(api);
        const duplicate = await api.post("/api/admin/api-keys", {
          headers: { "x-csrf-token": token, "Idempotency-Key": requestKey(), origin: baseUrl },
          data: { name: "重复输入", provider: "fixture-provider", plainKey },
        });
        assert.equal(duplicate.status(), 409);
        scan(await duplicate.text(), "httpBodies");
        assert.equal(await fixture.admin.apiKeyConfig.count(), 1);
        return {
          createStatus: 201,
          duplicateStatus: 409,
          rows: 1,
          safeDtoFields: 10,
          roundTrip: true,
        };
      });
      await caseRun("disable-enable", async () => {
        for (const [action, next] of [
          ["停用", "DISABLED"],
          ["启用", "ACTIVE"],
        ]) {
          await page
            .getByRole("button", { name: `${action} ${currentKey.name}`, exact: true })
            .click();
          const pending = responseFor("PATCH", `/api/admin/api-keys/${currentKey.id}`);
          await page
            .getByRole("form", { name: `${action}密钥` })
            .getByRole("button", { name: "确认保存" })
            .click();
          const response = await pending;
          assert.equal(response.status(), 200);
          currentKey = safeKey((await response.json()).data);
          assert.equal(currentKey.status, next);
          await keyLoaded();
        }
        const rows = await fixture.admin.auditLog.findMany({
          where: { targetId: currentKey.id },
          select: { action: true, detailJson: true },
        });
        scan(rows, "audit");
        assert(rows.length >= 3);
        return {
          transitions: ["ACTIVE", "DISABLED", "ACTIVE"],
          revision: currentKey.revision,
          auditedChanges: rows.length,
        };
      });
      await caseRun("rotate-revoke", async () => {
        const oldId = currentKey.id,
          plainKey = secret();
        await page.getByRole("button", { name: `轮换 ${currentKey.name}`, exact: true }).click();
        const form = page.getByRole("form", { name: "轮换密钥" });
        await form.getByLabel("名称", { exact: true }).fill("轮换后的密钥");
        await form.getByLabel("新密钥", { exact: true }).fill(plainKey);
        const pending = responseFor("POST", `/api/admin/api-keys/${oldId}/rotate`);
        await form.getByRole("button", { name: "验证并轮换" }).click();
        const response = await pending;
        assert.equal(response.status(), 202);
        const receipt = (await response.json()).data;
        assert.equal(receipt.stage, "ACTIVATED");
        assert.equal(receipt.affectedConfigCount, 0);
        currentKey = safeKey(receipt.key);
        assert.notEqual(currentKey.id, oldId);
        assert.equal((await managedKey(oldId)).status, "REVOKED");
        assert(decryptSecret(await managedKey(currentKey.id), fixture.resolver) === plainKey);
        await keyLoaded();
        await page.getByRole("button", { name: `撤销 ${currentKey.name}`, exact: true }).click();
        const revoked = responseFor("PATCH", `/api/admin/api-keys/${currentKey.id}`);
        await page.getByRole("button", { name: "确认永久撤销", exact: true }).click();
        const revokedResponse = await revoked;
        assert.equal(revokedResponse.status(), 200);
        currentKey = safeKey((await revokedResponse.json()).data);
        assert.equal(currentKey.status, "REVOKED");
        await keyLoaded();
        assert.equal(
          await page.getByRole("button", { name: `启用 ${currentKey.name}`, exact: true }).count(),
          0,
        );
        const token = await csrf(api);
        const restored = await api.patch(`/api/admin/api-keys/${currentKey.id}`, {
          headers: { "x-csrf-token": token, "Idempotency-Key": requestKey(), origin: baseUrl },
          data: { expectedVersion: currentKey.revision, status: "ACTIVE" },
        });
        assert.equal(restored.status(), 409);
        scan(await restored.text(), "httpBodies");
        return {
          rotateStatus: 202,
          stage: "ACTIVATED",
          actualProviderReferences: 0,
          oldKeyRevoked: true,
          emergencyRevoked: true,
          restoreStatus: 409,
        };
      });
      await caseRun("audit-filters-pagination", async () => {
        const token = await csrf(api);
        for (let index = 0; index < 23; index++) {
          const response = await api.post("/api/admin/api-keys", {
            headers: { "x-csrf-token": token, "Idempotency-Key": requestKey(), origin: baseUrl },
            data: {
              name: `合成密钥 ${String(index + 1).padStart(2, "0")}`,
              provider: "fixture-provider",
              plainKey: secret(),
            },
          });
          assert.equal(response.status(), 201);
          const body = await response.json();
          safeKey(body.data);
          scan(body, "httpBodies");
          await managedKey(body.data.id);
        }
        await page
          .getByRole("navigation", { name: "后台导航" })
          .getByRole("link", { name: "审计日志", exact: true })
          .click();
        await logLoaded();
        const first = await page
          .getByRole("region", { name: "审计日志列表" })
          .locator("tbody tr")
          .count();
        assert.equal(first, 20);
        const next = responseFor("GET", "/api/admin/logs");
        await page.getByRole("button", { name: "下一页", exact: true }).click();
        assert.equal((await next).status(), 200);
        await logLoaded();
        assert(
          (await page.getByRole("region", { name: "审计日志列表" }).locator("tbody tr").count()) >
            0,
        );
        const form = page.getByRole("form", { name: "筛选审计日志" });
        await form.getByLabel("目标 ID", { exact: true }).fill(currentKey.id);
        const filtered = responseFor("GET", "/api/admin/logs");
        await form.getByRole("button", { name: "查询日志" }).click();
        const response = await filtered;
        assert.equal(response.status(), 200);
        const body = await response.json();
        scan(body, "audit");
        assert(
          body.data.items.length > 0 &&
            body.data.items.every((item) => item.targetId === currentKey.id),
        );
        await logLoaded();
        const reset = responseFor("GET", "/api/admin/logs");
        await page.getByRole("button", { name: "重置筛选", exact: true }).click();
        assert.equal((await reset).status(), 200);
        await logLoaded();
        return {
          firstPage: first,
          secondPageNonempty: true,
          targetFilterMatched: true,
          readOnly: true,
        };
      });
      await caseRun("responsive-keyboard", async () => {
        const observations = [];
        for (const route of [
          { url: "/admin/api-keys", name: "密钥管理", label: "api-keys", loaded: keyLoaded },
          { url: "/admin/logs", name: "审计日志", label: "audit-logs", loaded: logLoaded },
        ]) {
          await page.goto(route.url);
          await route.loaded();
          const current = page
            .getByRole("navigation", { name: "后台导航" })
            .getByRole("link", { name: route.name, exact: true });
          assert.equal(await current.getAttribute("aria-current"), "page");
          for (const width of [375, 1280]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => scrollTo(0, 0));
            const bounds = await page.evaluate(() => ({
              viewport: innerWidth,
              scroll: document.documentElement.scrollWidth,
            }));
            assert(bounds.scroll <= width + 1, "Only table regions may scroll horizontally");
            const accessibility = await a11y(page, `${route.label}-${width}`);
            await screenshot(page, `${route.label}-${width}`);
            observations.push({
              route: route.url,
              width,
              documentScrollWidth: bounds.scroll,
              accessibility,
            });
          }
        }
        const navigation = page.getByRole("navigation", { name: "后台导航" });
        const first = navigation.getByRole("link", { name: "用户管理" });
        await first.focus();
        await page.keyboard.press("ArrowDown");
        assert(
          await navigation
            .getByRole("link", { name: "密钥管理" })
            .evaluate((element) => element === document.activeElement),
        );
        await page.keyboard.press("End");
        assert(
          await navigation
            .getByRole("button", { name: "退出登录" })
            .evaluate((element) => element === document.activeElement),
        );
        await page.keyboard.press("Escape");
        const toggle = page.getByRole("button", { name: "展开后台导航" });
        assert(await toggle.evaluate((element) => element === document.activeElement));
        await toggle.click();
        await page.getByRole("link", { name: "跳到主要内容" }).focus();
        await page.keyboard.press("Enter");
        assert(
          await page
            .locator("#admin-main-content")
            .evaluate((element) => element === document.activeElement),
        );
        return {
          observations,
          keyboard: ["ArrowDown", "End", "Escape", "Enter"],
          focusReturn: true,
          skipLink: true,
        };
      });
      await caseRun("failed-read-retry", async () => {
        await fixture.admin.$executeRawUnsafe(
          'REVOKE SELECT ON TABLE "AuditLog" FROM phase013_app',
        );
        try {
          const failed = responseFor("GET", "/api/admin/logs");
          await page.getByRole("button", { name: "刷新日志" }).click();
          assert.equal((await failed).status(), 503);
          await page.getByRole("alert").filter({ hasText: "审计日志暂时无法加载" }).waitFor();
          await screenshot(page, "audit-logs-unavailable");
          assert.equal(
            await page.getByText("没有符合条件的审计日志。", { exact: true }).count(),
            0,
          );
        } finally {
          await fixture.admin.$executeRawUnsafe('GRANT SELECT ON TABLE "AuditLog" TO phase013_app');
        }
        const retried = responseFor("GET", "/api/admin/logs");
        await page.getByRole("button", { name: "重试", exact: true }).click();
        assert.equal((await retried).status(), 200);
        await logLoaded();
        return { databasePermissionFault: 503, recovered: 200, failureNotEmpty: true };
      });
      await caseRun("logout-and-safe-pages", async () => {
        const storage = await page.evaluate(() => ({
          local: Object.fromEntries(Object.entries(localStorage)),
          session: Object.fromEntries(Object.entries(sessionStorage)),
        }));
        scan(storage, "browserStorage");
        assert.equal(Object.keys(storage.local).length + Object.keys(storage.session).length, 0);
        await page
          .getByRole("navigation", { name: "后台导航" })
          .getByRole("button", { name: "退出登录" })
          .click();
        await page.waitForURL("**/admin/login");
        for (const url of ["/api/admin/api-keys", "/api/admin/logs"]) {
          const response = await api.get(url);
          assert.equal(response.status(), 401);
          scan(await response.text(), "httpBodies");
        }
        const response = await page.goto("/phase013-missing-page");
        assert.equal(response.status(), 404);
        await page.getByRole("heading", { name: "页面未找到" }).waitFor();
        scan(await page.content(), "html");
        return {
          storageHits: 0,
          protectedResponses: [401, 401],
          notFound: 404,
          safeErrorComponent: "covered by the tagged Vitest assertion",
        };
      });
      await Promise.all(responseChecks);
      assert.equal(privacyFailures, 0);
      assert.equal(externalRequestCount, 0);
      assert.deepEqual(pageErrors, []);
      await context.close();
    } finally {
      if (browser) await browser.close();
      await stopServer();
    }
  });
}

try {
  await run();
  saveReport("PASS");
  console.warn(
    JSON.stringify({
      phase: 13,
      status: "PASS",
      cases: results.length,
      externalRequestCount,
      secretHits: 0,
      notGate: diagnostic,
    }),
  );
} catch (error) {
  saveReport("FAIL", error.stack ?? error);
  console.error(safeDiagnostics(error.stack ?? error));
  process.exitCode = 1;
}
