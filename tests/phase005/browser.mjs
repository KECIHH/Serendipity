import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { renderToStaticMarkup } from "react-dom/server";
import {
  root,
  directory,
  read,
  hash,
  json,
  inventory,
  write,
  httpMatrix,
} from "../../docs/phase-plans/phase005-runtime.mjs";

const productionRows = [
  ["/admin", 404],
  ["/admin/settings", 404],
  ["/", 200],
];

async function metrics(page) {
  return await page.evaluate(() => {
    const overflow = [...document.body.querySelectorAll("*")].flatMap((element) => {
      const rectangle = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rectangle.width > 0 &&
        rectangle.height > 0 &&
        style.position !== "fixed" &&
        (rectangle.right > innerWidth + 1 || rectangle.left < -1)
        ? [
            {
              tag: element.tagName,
              className: element.className,
              left: rectangle.left,
              right: rectangle.right,
            },
          ]
        : [];
    });
    const sidebar = document.querySelector("aside");
    return {
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      overflow,
      mainLandmarks: document.querySelectorAll("main").length,
      headings: [...document.querySelectorAll("h1")].map((element) => element.textContent),
      links: [...document.querySelectorAll("a")].map((element) => ({
        text: element.textContent,
        href: element.getAttribute("href"),
      })),
      sidebarWidth: sidebar?.getBoundingClientRect().width ?? null,
      sidebarDirection: sidebar ? getComputedStyle(sidebar.parentElement).flexDirection : null,
    };
  });
}

async function savePage(page, label, artifacts) {
  const imagePath = `${directory}/${label}.png`;
  const domPath = `${directory}/${label}.html`;
  assert(
    !fs.existsSync(path.join(root, imagePath)),
    `Immutable screenshot already exists: ${imagePath}`,
  );
  await page.screenshot({
    path: path.join(root, imagePath),
    fullPage: true,
    animations: "disabled",
  });
  write(domPath, await page.content());
  for (const file of [imagePath, domPath]) artifacts.push({ path: file, sha256: hash(file) });
}

async function fixtureHtml() {
  const bundle = path.join(
    root,
    `.scaffold/phase005-${json("docs/phase-plans/Phase005.json").attemptId}-components.cjs`,
  );
  await build({
    entryPoints: [path.join(root, "tests/phase005/components-fixture.tsx")],
    outfile: bundle,
    platform: "node",
    format: "cjs",
    bundle: true,
    packages: "external",
    alias: { "@": path.join(root, "src") },
    jsx: "automatic",
    tsconfig: path.join(root, "tsconfig.json"),
    logLevel: "silent",
  });
  const require = createRequire(import.meta.url);
  const fixture = require(bundle).default;
  const styles = inventory(".next/static/css").filter((file) => file.endsWith(".css"));
  assert(styles.length > 0, "Build CSS required for the real component fixture");
  const css = styles.map((file) => read(file).toString()).join("\n");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>公共组件测试</title><style>${css}</style></head><body>${renderToStaticMarkup(fixture)}</body></html>`;
}

export async function browserLayout(baseUrl) {
  const baseline = json("docs/runtime-baseline.json");
  const { chromium } = await import(
    pathToFileURL(path.join(root, baseline.toolPaths.playwright)).href
  );
  const executablePath = path.join(
    root,
    baseline.toolPaths.playwrightBrowsers,
    `chromium-${baseline.browser.build}`,
    "chrome-win/chrome.exe",
  );
  const browser = await chromium.launch({ executablePath, headless: true });
  const artifacts = [];
  const observations = [];
  const externalRequests = [];
  const errors = [];
  const html = await fixtureHtml();
  try {
    assert.equal(browser.version(), baseline.browser.chromiumVersion);
    const context = await browser.newContext({
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      reducedMotion: "reduce",
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(baseUrl).origin) await route.continue();
      else {
        externalRequests.push(url.origin);
        await route.abort();
      }
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    for (const width of [320, 375, 768, 1280, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      const response = await page.goto(baseUrl, { waitUntil: "networkidle" });
      assert.equal(response.status(), 200);
      assert.equal(await page.title(), "Serendipity · 际遇");
      assert.equal(
        await page.getByRole("heading", { level: 1, name: "Serendipity · 际遇" }).count(),
        1,
      );
      assert.equal(
        await page
          .getByRole("link", { name: "Serendipity · 际遇", exact: true })
          .getAttribute("href"),
        "/",
      );
      assert.equal(await page.getByRole("button", { name: "开始规划", exact: true }).count(), 1);
      const site = await metrics(page);
      assert.equal(site.mainLandmarks, 1);
      assert(site.links.every((link) => link.href === "/"));
      assert(site.documentWidth <= width && site.bodyWidth <= width);
      assert.deepEqual(site.overflow, []);
      await savePage(page, `site-${width}`, artifacts);
      if (width === 1280) {
        await page.keyboard.press("Tab");
        assert.equal(
          await page
            .getByRole("link", { name: "Serendipity · 际遇", exact: true })
            .evaluate((element) => element === document.activeElement),
          true,
        );
        const outline = await page.locator(":focus").evaluate((element) => ({
          width: getComputedStyle(element).outlineWidth,
          style: getComputedStyle(element).outlineStyle,
        }));
        assert.equal(outline.width, "2px");
        assert.equal(outline.style, "solid");
        await savePage(page, "site-focus-1280", artifacts);
        site.keyboardFocus = outline;
      }
      await page.setContent(html, { waitUntil: "load" });
      assert.equal(
        await page.getByRole("heading", { level: 1, name: "公共组件", exact: true }).count(),
        1,
      );
      assert.equal(await page.getByRole("status").getAttribute("aria-live"), "polite");
      assert.equal(await page.getByRole("alert").count(), 2);
      assert.equal(
        await page
          .getByRole("region", { name: "只读错误状态", exact: true })
          .getByRole("button")
          .count(),
        0,
      );
      const adminNavigation = page.getByRole("navigation", { name: "后台导航", exact: true });
      assert.equal(await adminNavigation.getByRole("link").count(), 0);
      assert.equal(await adminNavigation.getByRole("button").count(), 0);
      for (const label of ["概览", "用户", "AI 配置", "审计日志"])
        assert.equal(await adminNavigation.getByText(label, { exact: true }).count(), 1);
      const fixture = await metrics(page);
      assert.equal(fixture.mainLandmarks, 1);
      assert(fixture.documentWidth <= width && fixture.bodyWidth <= width);
      assert.deepEqual(fixture.overflow, []);
      assert.equal(fixture.sidebarDirection, width >= 768 ? "row" : "column");
      if (width >= 768) assert.equal(fixture.sidebarWidth, 224);
      const spinnerAnimation = await page
        .getByRole("status")
        .locator("svg")
        .evaluate((element) => getComputedStyle(element).animationName);
      assert.equal(spinnerAnimation, "none");
      await savePage(page, `components-${width}`, artifacts);
      if (width === 1280) {
        await page.getByRole("button", { name: "重试", exact: true }).focus();
        assert.equal(
          await page
            .getByRole("button", { name: "重试", exact: true })
            .evaluate((element) => element === document.activeElement),
          true,
        );
        await savePage(page, "components-focus-1280", artifacts);
      }
      observations.push({ width, site, fixture, reducedMotionAnimation: spinnerAnimation });
    }
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(errors, []);
    await context.close();
    return {
      observations,
      artifacts,
      chromiumVersion: browser.version(),
      playwrightVersion: baseline.browser.playwrightVersion,
      externalRequests,
      pageErrors: errors,
      a11yMode: "AUTOMATED_BROWSER_A11Y",
      checks: [
        "landmarks",
        "accessible-names",
        "ARIA-status-alert",
        "static-navigation",
        "keyboard-focus",
        "visible-focus-ring",
        "reduced-motion",
        "responsive-overflow",
      ],
      screenReader: "NOT_EVALUATED",
      fixtureMode: "REAL_REACT_STATIC_RENDER_WITH_PRODUCTION_CSS",
    };
  } finally {
    await browser.close();
  }
}

if (process.argv.includes("--http-only")) {
  try {
    const rows = await httpMatrix(
      process.argv[process.argv.indexOf("--http-only") + 1],
      productionRows,
    );
    console.log(JSON.stringify({ rows, status: "PASS" }));
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  }
}
