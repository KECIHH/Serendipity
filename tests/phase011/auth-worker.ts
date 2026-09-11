import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store";
import { createWorkStore } from "next/dist/server/async-storage/work-store";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { env } from "@/lib/env";
import { createLoginThrottle } from "@/server/auth/login-throttle";
import { encodeAuthCookie, authCookieSettings } from "@/server/auth/cookie";
import { withAdminAction, withAdminRoute } from "@/server/auth/guards";
import { requireAdmin } from "@/server/auth/require-admin";

type WorkerInput = {
  mode: "throttle" | "guards";
  account?: string;
  clientAddress?: string;
  adminToken?: string;
  userToken?: string;
  expiresAt?: string;
};

let workerStage = "read-input";
const observedStatuses: Record<string, number[]> = {};

async function run(): Promise<void> {
  const input = JSON.parse(fs.readFileSync(0, "utf8")) as WorkerInput;
  if (input.mode === "throttle") {
    const throttle = createLoginThrottle();
    try {
      const result = await throttle.admit({
        account: input.account!,
        clientAddress: input.clientAddress!,
        requestId: randomUUID(),
      });
      process.stdout.write(
        JSON.stringify({
          kind: result.kind,
          retryAfter: result.kind === "RATE_LIMITED" ? result.retryAfter : null,
        }),
      );
    } finally {
      await throttle.disconnect();
    }
    return;
  }
  assert.equal(input.mode, "guards");
  workerStage = "encrypt-cookies";
  const client = new PrismaClient({ datasourceUrl: env.DATABASE_URL, log: [] });
  const csrfToken = randomBytes(32).toString("hex");
  const csrfHash = createHash("sha256").update(`${csrfToken}${env.AUTH_SECRET}`).digest("hex");
  const settings = authCookieSettings();
  const makeCookie = async (token?: string) => {
    if (!token) return "";
    const encrypted = await encodeAuthCookie({
      token: { opaqueToken: token, absoluteExpiresAt: new Date(input.expiresAt!).getTime() },
      secret: env.AUTH_SECRET,
      salt: settings.sessionToken.name,
    });
    return `${settings.sessionToken.name}=${encrypted}; ${settings.csrfToken.name}=${csrfToken}%7C${csrfHash}`;
  };
  const adminCookie = await makeCookie(input.adminToken),
    userCookie = await makeCookie(input.userToken);
  const duplicateCookie = `${adminCookie}; ${settings.sessionToken.name}=invalid-duplicate`;
  let queries = 0,
    writes = 0;
  async function businessOperation() {
    queries += 1;
    await client.systemConfig.count();
    writes += 1;
    await client.systemConfig.create({
      data: {
        key: `guard-${randomUUID()}`,
        valueJson: true,
        group: "GENERAL",
        description: "Synthetic authorization fixture",
      },
    });
    return { reached: true };
  }
  const route = withAdminRoute(async () => Response.json(await businessOperation()));
  const action = withAdminAction(async (input: string) => {
    assert.equal(input, "synthetic fixture");
    return businessOperation();
  });
  const makeRequest = (cookie: string) =>
    new NextRequest(`${env.AUTH_URL}/api/admin/test-harness`, {
      method: "POST",
      headers: {
        cookie,
        origin: env.AUTH_URL,
        "sec-fetch-site": "same-origin",
        "x-csrf-token": csrfToken,
      },
    });
  async function actionStatus(cookie: string): Promise<number> {
    const request = makeRequest(cookie);
    const lifecycle = new EventTarget();
    const store = createRequestStoreForAPI(
      request,
      new URL(request.url),
      { tags: [], expirationsByCacheKind: new Map() },
      undefined,
      undefined,
    );
    const workStore = createWorkStore({
      page: "/api/admin/test-harness/route",
      buildId: "phase011-guard-fixture",
      previouslyRevalidatedTags: [],
      renderOpts: {
        supportsDynamicResponse: true,
        isPossibleServerAction: true,
        experimental: { isRoutePPREnabled: false, cacheComponents: false, authInterrupts: false },
        waitUntil: undefined,
        onAfterTaskError: undefined,
        onClose: (callback) => lifecycle.addEventListener("close", callback, { once: true }),
      },
    });
    try {
      await workAsyncStorage.run(workStore, () =>
        workUnitAsyncStorage.run(store, () => action("synthetic fixture", csrfToken)),
      );
      return 200;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 401 && status !== 403 && status !== 503) throw error;
      return status;
    } finally {
      lifecycle.dispatchEvent(new Event("close"));
    }
  }
  try {
    workerStage = "denied-routes";
    const deniedRoute = [
      (await route(makeRequest(""), undefined)).status,
      (await route(makeRequest(userCookie), undefined)).status,
      (await route(makeRequest(duplicateCookie), undefined)).status,
    ];
    observedStatuses.deniedRoute = deniedRoute;
    workerStage = "denied-actions";
    const deniedAction = [
      await actionStatus(""),
      await actionStatus(userCookie),
      await actionStatus(duplicateCookie),
    ];
    observedStatuses.deniedAction = deniedAction;
    workerStage = "assert-denied";
    assert.deepEqual(deniedRoute, [401, 403, 401]);
    assert.deepEqual(deniedAction, [401, 403, 401]);
    assert.equal(queries, 0);
    assert.equal(writes, 0);
    const before = await client.systemConfig.count();
    workerStage = "authorized-principal";
    const principal = await requireAdmin(makeRequest(adminCookie));
    assert.equal(principal.role, "ADMIN");
    workerStage = "authorized-route";
    assert.equal((await route(makeRequest(adminCookie), undefined)).status, 200);
    workerStage = "authorized-action";
    assert.equal(await actionStatus(adminCookie), 200);
    workerStage = "assert-authorized";
    assert.equal(queries, 2);
    assert.equal(writes, 2);
    assert.equal(await client.systemConfig.count(), before + 2);
    workerStage = "invalidate-session";
    await client.user.update({
      where: { id: principal.id },
      data: { sessionVersion: { increment: 1 } },
    });
    workerStage = "revoked-route";
    const revokedRoute = (await route(makeRequest(adminCookie), undefined)).status;
    workerStage = "revoked-action";
    const revokedAction = await actionStatus(adminCookie);
    workerStage = "assert-revoked";
    assert.equal(revokedRoute, 401);
    assert.equal(revokedAction, 401);
    assert.equal(queries, 2);
    assert.equal(writes, 2);
    process.stdout.write(
      JSON.stringify({
        status: "PASS",
        deniedRoute,
        deniedAction,
        unauthorizedQueries: 0,
        unauthorizedWrites: 0,
        authorizedQueries: queries,
        authorizedWrites: writes,
        revokedRoute,
        revokedAction,
        requestContext: "REAL_NEXT_REQUEST_STORE",
        database: "REAL_POSTGRESQL17",
      }),
    );
  } finally {
    await client.$disconnect();
  }
}

run()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(
      JSON.stringify({
        status: "FAIL",
        stage: workerStage,
        observedStatuses,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    process.exit(1);
  });
