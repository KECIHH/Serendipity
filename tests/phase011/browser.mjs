import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { randomBytes, createHash } from "node:crypto";
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
} from "../../docs/phase-plans/phase011-runtime.mjs";

const load = createRequire(import.meta.url);
const { withAuthDatabase, registerCanary } = load("./auth-fixture.ts");
const outputArgument = process.argv[process.argv.indexOf("--output") + 1];
assert(
  process.argv.includes("--output") && outputArgument,
  "An exclusive output report path is required",
);
const outputPath = path.resolve(outputArgument);
assert(
  outputPath.startsWith(path.join(root, ".scaffold", "phase011") + path.sep),
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
    phase: 11,
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

function privateEmail(label) {
  const email = `${label}-${randomBytes(8).toString("hex")}@example.invalid`;
  registerCanary({ email });
  return email;
}

function privatePassword() {
  const password = `${randomBytes(24).toString("base64url")}Aa1!`;
  registerCanary({ password });
  return password;
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

async function credentials(api, baseUrl, email, password, audience = "ADMIN", extraHeaders = {}) {
  const csrfToken = await csrf(api);
  return api.post("/api/auth/callback/credentials", {
    headers: {
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      "X-Auth-Return-Redirect": "1",
      ...extraHeaders,
    },
    form: {
      csrfToken,
      email,
      password,
      audience,
      role: "ADMIN",
      userId: "client_identity_ignored",
      sessionVersion: "999",
    },
    maxRedirects: 0,
  });
}

function stableFailureHeaders(response) {
  // HTTP Date changes with wall time; every other response header remains observable.
  return Object.fromEntries(
    Object.entries(response.headers())
      .filter(([name]) => name !== "date")
      .sort(([a], [b]) => a.localeCompare(b)),
  );
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
    "Authentication page must have zero automated WCAG A/AA violations",
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
  const { decode } = await import("next-auth/jwt");
  const executablePath = path.join(
    root,
    baseline.toolPaths.playwrightBrowsers,
    `chromium-${baseline.browser.build}`,
    "chrome-win",
    "chrome.exe",
  );
  await withAuthDatabase(async (fixture) => {
    const port = await portAvailable();
    const baseUrl = `http://127.0.0.1:${port}`;
    configuredBrowserOrigin = baseUrl;
    const serverEnv = {
      DATABASE_URL: fixture.url,
      AUTH_URL: baseUrl,
      AUTH_SECRET: fixture.config.authSecret,
      AUTH_TRUSTED_PROXY_CIDRS: "",
      NODE_ENV: "production",
      ADMIN_PREVIEW: "true",
      ALLOW_ADMIN: "true",
      ENABLE_ADMIN: "true",
      ADMIN_ENABLED: "true",
    };
    try {
      const build = await npm(["run", "build"], { env: serverEnv });
      commands.push(build);
    } catch (error) {
      if (error.observation) commands.push(error.observation);
      throw error;
    }
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
      let issuedCookie, issuedTokenHash;
      const currentAdminSession = async () => {
        const cookie = (await context.cookies()).find(
          (value) => value.name === "authjs.session-token",
        );
        assert(cookie && cookie.value, "Successful login must create the session cookie");
        registerCanary({ sessionCookie: cookie.value });
        const payload = await decode({
          token: cookie.value,
          secret: fixture.config.authSecret,
          salt: cookie.name,
        });
        assert(
          payload && typeof payload.opaqueToken === "string",
          "Auth.js must encrypt an opaque database session reference",
        );
        registerCanary({ opaqueToken: payload.opaqueToken });
        const tokenHash = createHash("sha256").update(payload.opaqueToken).digest("hex");
        const row = await fixture.app.authSession.findUniqueOrThrow({ where: { tokenHash } });
        assert(
          !JSON.stringify(row).includes(payload.opaqueToken),
          "The database may not persist the opaque session token",
        );
        return { cookie, payload, row, tokenHash };
      };

      await caseRun("public-routing", async () => {
        const initialRedirect = await api.get("/admin", { maxRedirects: 0 });
        assert.equal(initialRedirect.status(), 307);
        const location = initialRedirect.headers().location;
        assert(location, "Unauthenticated admin requests must include a redirect target");
        assert.equal(
          new URL(location, `${baseUrl}/admin`).href,
          `${baseUrl}/admin/login`,
          "The middleware adapter must preserve the exact configured authentication origin",
        );
        const login = await page.goto("/admin", { waitUntil: "networkidle" });
        assert.equal(login.status(), 200);
        assert.equal(new URL(page.url()).origin, baseUrl);
        assert.equal(new URL(page.url()).pathname, "/admin/login");
        assert.equal(
          await page.getByRole("heading", { name: "管理员登录", exact: true }).count(),
          1,
        );
        assert.equal(await page.getByRole("navigation").count(), 0);
        assert.equal((await api.get("/login")).status(), 200);
        assert.equal((await api.get("/api/auth/providers")).status(), 200);
        for (const pathname of [
          "/api/login",
          "/api/admin/login",
          "/api/auth/register",
          "/this-route-does-not-exist",
        ]) {
          const response = await api.get(pathname, { maxRedirects: 0 });
          if (pathname.startsWith("/api/auth/"))
            assert(response.status() >= 400, "Unregistered Auth.js action must not succeed");
          else assert.equal(response.status(), 404);
        }
        return {
          loginPage: 200,
          unauthenticatedAdmin: 307,
          userLoginPage: 200,
          providerReachable: true,
          businessAliases: "ABSENT",
          redirectLoop: false,
          initialRedirectOriginPreserved: true,
          finalPageOriginPreserved: true,
        };
      });

      await caseRun("login-keyboard-and-accessibility", async () => {
        const views = [];
        for (const width of [375, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto("/admin/login", { waitUntil: "networkidle" });
          assert.equal(await page.locator("main").count(), 1);
          assert.equal(
            await page.getByLabel("密码", { exact: true }).getAttribute("type"),
            "password",
          );
          await page.keyboard.press("Tab");
          assert(
            await page
              .getByLabel("邮箱", { exact: true })
              .evaluate((element) => element === document.activeElement),
          );
          const focus = await page.locator(":focus").evaluate((element) => ({
            outline: getComputedStyle(element).outlineStyle,
            shadow: getComputedStyle(element).boxShadow,
          }));
          assert(
            focus.outline !== "none" || focus.shadow !== "none",
            "Keyboard focus must be visible",
          );
          await page.keyboard.press("Tab");
          assert(
            await page
              .getByLabel("密码", { exact: true })
              .evaluate((element) => element === document.activeElement),
          );
          await page.keyboard.press("Tab");
          assert(
            await page
              .getByRole("button", { name: "登录", exact: true })
              .evaluate((element) => element === document.activeElement),
          );
          const metrics = await page.evaluate(() => ({
            width: innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            bodyWidth: document.body.scrollWidth,
          }));
          assert(
            metrics.documentWidth <= width && metrics.bodyWidth <= width,
            "Authentication page must not overflow horizontally",
          );
          const tree = await page.locator("main").ariaSnapshot();
          assert(
            tree.includes("管理员登录") && tree.includes("邮箱") && tree.includes("密码"),
            "Accessibility tree must identify the login controls",
          );
          const treePath = `${directory}/auth-login-${width}-a11y.txt`;
          write(treePath, tree);
          artifacts.push({ path: treePath, sha256: hash(treePath) });
          const axe = await accessibility(page, `auth-login-${width}`);
          await saveCleanPage(page, `auth-login-${width}`);
          views.push({
            width,
            focusVisible: true,
            tabOrder: ["email", "password", "submit"],
            metrics,
            axe,
          });
        }
        return { views, screenshotsExcludeCredentials: true };
      });

      await caseRun("valid-admin-login-and-fixed-session", async () => {
        await page.getByLabel("邮箱", { exact: true }).fill(fixture.seed.email);
        await page.getByLabel("密码", { exact: true }).fill(fixture.seed.password);
        await page.getByRole("button", { name: "登录", exact: true }).click();
        await page.waitForURL(`${baseUrl}/admin`);
        await page.getByRole("heading", { name: "登录成功", exact: true }).waitFor();
        assert.equal((await api.get("/admin", { maxRedirects: 0 })).status(), 200);
        const current = await currentAdminSession();
        issuedCookie = current.cookie;
        issuedTokenHash = current.tokenHash;
        assert.deepEqual(Object.keys(current.payload).sort(), [
          "absoluteExpiresAt",
          "exp",
          "iat",
          "jti",
          "opaqueToken",
        ]);
        assert(
          current.cookie.httpOnly &&
            current.cookie.sameSite === "Lax" &&
            current.cookie.path === "/",
        );
        assert.equal(
          current.cookie.secure,
          false,
          "Only the controlled loopback HTTP fixture may omit Secure",
        );
        assert.equal(current.row.expiresAt.getTime() - current.row.issuedAt.getTime(), 43_200_000);
        assert(current.cookie.expires * 1_000 <= current.row.expiresAt.getTime() + 1_000);
        assert.equal(current.row.audience, "ADMIN");
        assert.equal(current.row.status, "ACTIVE");
        const user = await fixture.app.user.findUniqueOrThrow({
          where: { id: fixture.seed.userId },
        });
        assert(user.lastLoginAt instanceof Date, "Successful login must persist lastLoginAt");
        assert.equal(
          await fixture.app.auditLog.count({
            where: { action: "LOGIN_SUCCESS", targetType: "User", targetId: fixture.seed.userId },
          }),
          1,
        );
        const first = await api.get("/api/auth/session");
        const session = await first.json();
        assert(
          session.user.email === fixture.seed.email,
          "Session must project the verified account",
        );
        assert.equal(session.expires, current.row.expiresAt.toISOString());
        assert(
          !JSON.stringify(session).includes(current.payload.opaqueToken),
          "Public session JSON must not reveal its bearer value",
        );
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        const refresh = await api.get("/api/auth/session");
        assert.equal((await refresh.json()).expires, current.row.expiresAt.toISOString());
        const refreshed = await currentAdminSession();
        assert.equal(refreshed.payload.absoluteExpiresAt, current.row.expiresAt.getTime());
        assert(refreshed.cookie.expires * 1_000 <= current.row.expiresAt.getTime() + 1_000);
        await accessibility(page, "auth-admin-success");
        await saveCleanPage(page, "auth-admin-success");
        return {
          pageStatus: 200,
          absoluteMaxAgeSeconds: 43_200,
          httpOnly: true,
          sameSite: "Lax",
          path: "/",
          secure: false,
          environment: "LOOPBACK_HTTP",
          rawTokenPersisted: false,
          publicTokenExposure: false,
          refreshExtendsExpiry: false,
          lastLoginUpdated: true,
          loginAuditCount: 1,
        };
      });

      const userEmail = privateEmail("user"),
        disabledEmail = privateEmail("disabled"),
        missingEmail = privateEmail("missing");
      const passwordSource = await fixture.app.user.findUniqueOrThrow({
        where: { id: fixture.seed.userId },
        select: { passwordHash: true },
      });
      await fixture.admin.user.create({
        data: {
          email: userEmail,
          passwordHash: passwordSource.passwordHash,
          role: "USER",
          status: "ACTIVE",
        },
      });
      await fixture.admin.user.create({
        data: {
          email: disabledEmail,
          passwordHash: passwordSource.passwordHash,
          role: "ADMIN",
          status: "DISABLED",
        },
      });

      await caseRun("uniform-http-credential-failures", async () => {
        const observations = [];
        for (const [category, email, password] of [
          ["UNKNOWN_ACCOUNT", missingEmail, fixture.seed.password],
          ["PASSWORD_MISMATCH", fixture.seed.email, privatePassword()],
          ["USER_ACCOUNT", userEmail, fixture.seed.password],
          ["DISABLED_ADMIN", disabledEmail, fixture.seed.password],
        ]) {
          const response = await credentials(api, baseUrl, email, password);
          const body = await response.text();
          assert.equal(
            response.status(),
            401,
            "All credential failures must use the same HTTP status",
          );
          const headers = stableFailureHeaders(response);
          observations.push({ category, body, headers });
        }
        for (const item of observations) {
          assert.equal(item.body, observations[0].body);
          assert.deepEqual(item.headers, observations[0].headers);
        }
        assert.equal(JSON.parse(observations[0].body).error.message, "邮箱或密码错误");
        return {
          categories: observations.map((item) => item.category),
          status: 401,
          bodyHash: createHash("sha256").update(observations[0].body).digest("hex"),
          headerNames: Object.keys(observations[0].headers),
          observableDifferences: 0,
          excludedTransportHeaderValues: ["date"],
        };
      });

      await caseRun("csrf-origin-and-fetch-metadata", async () => {
        const proof = await csrf(api);
        const before = await fixture.app.authLoginAttempt.count();
        for (const [token, headers] of [
          [null, { origin: baseUrl }],
          ["0".repeat(64), { origin: baseUrl }],
          [proof, { origin: "https://foreign.invalid" }],
          [proof, { origin: baseUrl, "sec-fetch-site": "cross-site" }],
        ]) {
          const response = await api.post("/api/auth/callback/credentials", {
            form: {
              ...(token === null ? {} : { csrfToken: token }),
              email: fixture.seed.email,
              password: fixture.seed.password,
              audience: "ADMIN",
            },
            headers: { "X-Auth-Return-Redirect": "1", ...headers },
            maxRedirects: 0,
          });
          assert.equal(response.status(), 403);
        }
        assert.equal(await fixture.app.authLoginAttempt.count(), before);
        return { rejectedCases: 4, unauthorizedAdmissions: 0 };
      });

      await caseRun("logout-revokes-before-cookie-clear", async () => {
        await context.addCookies([
          { name: "authjs.session-token-foreign", value: "untrusted-suffix", url: baseUrl },
        ]);
        const signoutReply = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/auth/signout" &&
            response.request().method() === "POST",
        );
        await page.getByRole("button", { name: "退出登录", exact: true }).click();
        const signoutResponse = await signoutReply;
        assert.equal(signoutResponse.status(), 200);
        assert.equal(signoutResponse.headers()["x-auth-session-cleared"], "1");
        await page.waitForURL(`${baseUrl}/admin/login`);
        assert(!(await context.cookies()).some((item) => item.name === "authjs.session-token"));
        assert.equal(
          (
            await fixture.app.authSession.findUniqueOrThrow({
              where: { tokenHash: issuedTokenHash },
            })
          ).status,
          "REVOKED",
        );
        const oldSession = await api.get("/api/auth/session", {
          headers: { cookie: `${issuedCookie.name}=${issuedCookie.value}` },
        });
        assert.equal(
          await oldSession.json(),
          null,
          "A copied pre-logout cookie must be rejected immediately",
        );
        assert.equal((await api.get("/admin", { maxRedirects: 0 })).status(), 307);
        return {
          sessionRevoked: true,
          cookieCleared: true,
          cookieCleanupReceipt: true,
          oldCookieAuthorizedRequests: 0,
          loginReachable: true,
          pollutedCookiePrefixBypass: false,
        };
      });

      await caseRun("logout-database-failure-is-visible", async () => {
        await page.getByLabel("邮箱", { exact: true }).fill(fixture.seed.email);
        await page.getByLabel("密码", { exact: true }).fill(fixture.seed.password);
        await page.getByRole("button", { name: "登录", exact: true }).click();
        await page.waitForURL(`${baseUrl}/admin`);
        const current = await currentAdminSession();
        await fixture.admin.$executeRawUnsafe(
          'REVOKE UPDATE (status,"lastSeenAt","revokedAt") ON "AuthSession" FROM phase011_app',
        );
        try {
          const reply = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === "/api/auth/signout" &&
              response.request().method() === "POST",
          );
          await page.getByRole("button", { name: "退出登录", exact: true }).click();
          const failureResponse = await reply;
          assert.equal(failureResponse.status(), 503);
          assert.equal(failureResponse.headers()["x-auth-session-cleared"], "1");
          await page.getByRole("alert").filter({ hasText: "服务端退出暂未完成" }).waitFor();
          assert.equal(new URL(page.url()).pathname, "/admin");
          assert(await page.getByRole("button", { name: "退出登录", exact: true }).isDisabled());
          assert.equal(
            await page.getByRole("link", { name: "返回登录" }).getAttribute("href"),
            "/admin/login",
          );
          assert(!(await context.cookies()).some((item) => item.name === "authjs.session-token"));
          assert.equal(
            (
              await fixture.app.authSession.findUniqueOrThrow({
                where: { tokenHash: current.tokenHash },
              })
            ).status,
            "ACTIVE",
          );
          await saveCleanPage(page, "auth-logout-unavailable");
        } finally {
          await fixture.admin.$executeRawUnsafe(
            'GRANT UPDATE (status,"lastSeenAt","revokedAt") ON "AuthSession" TO phase011_app',
          );
        }
        // The isolated fixture retains the copied Cookie solely to verify recovery and cleanup.
        await context.addCookies([current.cookie]);
        const proof = await csrf(api);
        const recovery = await api.post("/api/auth/signout", {
          headers: { origin: baseUrl, "X-Auth-Return-Redirect": "1" },
          form: { csrfToken: proof, callbackUrl: "https://foreign.invalid/untrusted-destination" },
          maxRedirects: 0,
        });
        assert.equal(recovery.status(), 200);
        assert.deepEqual(await recovery.json(), { url: `${baseUrl}/admin/login` });
        assert.equal(
          (
            await fixture.app.authSession.findUniqueOrThrow({
              where: { tokenHash: current.tokenHash },
            })
          ).status,
          "REVOKED",
        );
        return {
          failureStatus: 503,
          cookieClearedOnFailure: true,
          cookieCleanupReceipt: true,
          serverSuccessClaimed: false,
          serverSessionUnchangedDuringFailure: true,
          recoveryRevoked: true,
          externalCallbackFollowed: false,
        };
      });

      await caseRun("cookie-and-preview-bypass-rejection", async () => {
        await context.clearCookies();
        const response = await api.get("/admin?preview=true&bypass=1&admin=true", {
          headers: { cookie: "admin=true; preview=true; bypass=1; role=ADMIN" },
          maxRedirects: 0,
        });
        assert.equal(response.status(), 307);
        await context.addCookies([
          {
            name: "authjs.session-token",
            value: "role.ADMIN.sessionVersion.0",
            url: baseUrl,
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);
        const pageResponse = await page.goto("/admin", { waitUntil: "networkidle" });
        assert.equal(pageResponse.status(), 200);
        assert.equal(new URL(page.url()).pathname, "/admin/login");
        await context.clearCookies();
        return {
          previewEnvironmentEnabledForProbe: true,
          queryBypass: false,
          previewCookieBypass: false,
          forgedAuthCookieBypass: false,
          redirectLoop: false,
        };
      });

      await caseRun("shared-user-login-has-no-admin-authority", async () => {
        await page.goto("/login", { waitUntil: "networkidle" });
        await page.getByLabel("邮箱", { exact: true }).fill(userEmail);
        await page.getByLabel("密码", { exact: true }).fill(fixture.seed.password);
        await page.getByRole("button", { name: "登录", exact: true }).click();
        await page.waitForURL(`${baseUrl}/`);
        const current = await currentAdminSession();
        assert.equal(current.row.audience, "USER");
        const response = await page.goto("/admin", { waitUntil: "networkidle" });
        assert.equal(response.status(), 200);
        assert.equal(new URL(page.url()).pathname, "/admin/login");
        const proof = await csrf(api);
        assert.equal(
          (
            await api.post("/api/auth/signout", {
              headers: { origin: baseUrl, "X-Auth-Return-Redirect": "1" },
              form: { csrfToken: proof },
              maxRedirects: 0,
            })
          ).status(),
          200,
        );
        return {
          provider: "credentials",
          userAudience: "USER",
          adminPageAuthorized: false,
          userLandingStatus: 200,
        };
      });

      await caseRun("durable-dual-throttle-http-responses", async () => {
        await context.clearCookies();
        await fixture.setClock(new Date(fixture.clock.getTime() + 16 * 60_000));
        const account = privateEmail("account-limit");
        const wrong = privatePassword();
        for (let index = 0; index < 5; index++) {
          const response = await credentials(api, baseUrl, account, wrong, "ADMIN", {
            "x-forwarded-for": `198.51.100.${index + 1}`,
          });
          assert.equal(response.status(), 401);
        }
        const accountLimited = await credentials(api, baseUrl, account, wrong);
        assert.equal(accountLimited.status(), 429);
        assert.equal(accountLimited.headers()["retry-after"], "900");
        const accountBody = await accountLimited.text();
        await fixture.setClock(new Date(fixture.clock.getTime() + 32 * 60_000));
        for (let index = 0; index < 20; index++) {
          assert.equal(
            (
              await credentials(api, baseUrl, privateEmail("ip-limit"), wrong, "ADMIN", {
                "x-forwarded-for": `203.0.113.${index + 1}`,
              })
            ).status(),
            401,
          );
        }
        const ipLimited = await credentials(api, baseUrl, privateEmail("ip-overflow"), wrong);
        assert.equal(ipLimited.status(), 429);
        assert.equal(ipLimited.headers()["retry-after"], "900");
        assert.equal(await ipLimited.text(), accountBody);
        assert.deepEqual(stableFailureHeaders(ipLimited), stableFailureHeaders(accountLimited));
        const identities = await fixture.app.authLoginAttempt.findMany({
          select: { ipHash: true },
          distinct: ["ipHash"],
        });
        assert.equal(
          identities.length,
          1,
          "Forged forwarding headers must not change the direct-client throttle key",
        );
        return {
          accountAdmitted: 5,
          accountNextStatus: 429,
          ipAdmitted: 20,
          ipNextStatus: 429,
          retryAfterSeconds: 900,
          publicBucketDifferences: 0,
          forwardingSpoofChangesKey: false,
          distinctDirectClientBuckets: 1,
        };
      });

      assert.equal(externalRequestCount, 0, "Browser must not contact public services");
      assert.equal(pageErrors.length, 0, "Real authentication pages must not emit runtime errors");
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
  console.log(
    JSON.stringify({
      status: "PASS",
      caseCount: results.length,
      report: path.relative(root, outputPath).replaceAll("\\", "/"),
    }),
  );
} catch (error) {
  saveReport("FAIL", safeDiagnostics(error.stack ?? error));
  console.error(
    JSON.stringify({
      status: "FAIL",
      report: path.relative(root, outputPath).replaceAll("\\", "/"),
    }),
  );
  process.exitCode = 1;
}
