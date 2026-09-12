import "next/dist/server/node-environment-baseline";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { env } from "@/lib/env";
import { fail, ok } from "@/lib/api-response";
import { authCookieSettings, encodeAuthCookie } from "@/server/auth/cookie";
import { AdminUsersError, createAdminUsersService } from "@/server/admin/users";
import { GET } from "@/app/api/admin/users/route";
import { PATCH } from "@/app/api/admin/users/[id]/route";
import type { WorkerRequest, WorkerResponse } from "./admin-fixture";

async function makeRequest(input: WorkerRequest): Promise<NextRequest> {
  const settings = authCookieSettings();
  const csrf = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(`${csrf}${env.AUTH_SECRET}`).digest("hex");
  const cookies: string[] = [];
  if (input.session) {
    const value = await encodeAuthCookie({
      token: {
        opaqueToken: input.session.opaqueToken,
        absoluteExpiresAt: new Date(input.session.expiresAt).getTime(),
      },
      secret: env.AUTH_SECRET,
      salt: settings.sessionToken.name,
    });
    cookies.push(`${settings.sessionToken.name}=${value}`);
  }
  const headers = new Headers({
    origin: input.origin ?? env.AUTH_URL,
    "sec-fetch-site": "same-origin",
  });
  if (input.csrf !== "missing") {
    cookies.push(`${settings.csrfToken.name}=${csrf}%7C${hash}`);
    headers.set("x-csrf-token", input.csrf === "mismatch" ? randomBytes(32).toString("hex") : csrf);
  }
  if (cookies.length) headers.set("cookie", cookies.join("; "));
  if (input.idempotencyKey !== undefined) headers.set("Idempotency-Key", input.idempotencyKey);
  if (input.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(new URL(input.path ?? "/api/admin/users", env.AUTH_URL), {
    method: input.method,
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
}

async function handle(input: WorkerRequest): Promise<WorkerResponse> {
  const request = await makeRequest(input);
  const queries: string[] = [];
  let response: Response;
  if (input.mode === "observed-list") {
    const service = createAdminUsersService({ queryObserver: (query) => queries.push(query) });
    try {
      response = Response.json(ok(await service.list(request), randomUUID()), {
        headers: { "cache-control": "no-store" },
      });
    } catch (error) {
      if (!(error instanceof AdminUsersError)) throw error;
      response = Response.json(fail(error.code, "合成验证请求失败", randomUUID(), error.details), {
        status: error.status,
      });
    } finally {
      await service.disconnect();
    }
  } else if (input.method === "GET") {
    response = await GET(request);
  } else {
    const id = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1) ?? "");
    response = await PATCH(request, { params: Promise.resolve({ id }) });
  }
  return {
    status: response.status,
    body: await response.json(),
    headers: Object.fromEntries(response.headers),
    ...(input.mode === "observed-list" ? { queries } : {}),
  };
}

process.on("message", (message: { type: string; id?: number; input?: WorkerRequest }) => {
  if (message.type === "shutdown") {
    process.exit(0);
    return;
  }
  if (message.type !== "request" || message.id === undefined || !message.input) return;
  void handle(message.input).then(
    (response) => process.send?.({ type: "response", id: message.id, response }),
    (error: unknown) =>
      process.send?.({
        type: "worker-error",
        id: message.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
  );
});
process.on("disconnect", () => process.exit(0));
process.send?.({ type: "ready" });
