import "next/dist/server/node-environment-baseline";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { env } from "@/lib/env";
import { ok } from "@/lib/api-response";
import { authCookieSettings, encodeAuthCookie } from "@/server/auth/cookie";
import { adminApiKeysFailure, createAdminApiKeysService } from "@/server/admin/api-keys";
import { adminLogsFailure, createAdminLogsService } from "@/server/admin/logs";
import { GET, POST } from "@/app/api/admin/api-keys/route";
import { PATCH } from "@/app/api/admin/api-keys/[id]/route";
import { POST as ROTATE } from "@/app/api/admin/api-keys/[id]/rotate/route";
import { GET as LOGS } from "@/app/api/admin/logs/route";
import type { WorkerRequest, WorkerResponse } from "./api-key-fixture";

async function makeRequest(input: WorkerRequest): Promise<NextRequest> {
  const settings = authCookieSettings(),
    csrf = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(`${csrf}${env.AUTH_SECRET}`).digest("hex"),
    cookies: string[] = [];
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
  return new NextRequest(new URL(input.path ?? "/api/admin/api-keys", env.AUTH_URL), {
    method: input.method,
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
}

async function handle(input: WorkerRequest): Promise<WorkerResponse> {
  const request = await makeRequest(input),
    queries: string[] = [];
  let response: Response;
  if (input.mode === "observed-list") {
    const service = createAdminApiKeysService({ queryObserver: (query) => queries.push(query) });
    try {
      response = Response.json(ok(await service.list(request), randomUUID()), {
        headers: { "cache-control": "no-store" },
      });
    } catch (error) {
      response = adminApiKeysFailure(error, randomUUID());
    } finally {
      await service.disconnect();
    }
  } else if (input.mode === "observed-logs") {
    const service = createAdminLogsService({ queryObserver: (query) => queries.push(query) });
    try {
      response = Response.json(ok(await service.list(request), randomUUID()), {
        headers: { "cache-control": "no-store" },
      });
    } catch (error) {
      response = adminLogsFailure(error, randomUUID());
    } finally {
      await service.disconnect();
    }
  } else {
    const parts = new URL(request.url).pathname.split("/");
    if (parts.at(-1) === "logs") response = await LOGS(request);
    else if (input.method === "GET") response = await GET(request);
    else if (input.method === "PATCH")
      response = await PATCH(request, {
        params: Promise.resolve({ id: decodeURIComponent(parts.at(-1) ?? "") }),
      });
    else if (parts.at(-1) === "rotate")
      response = await ROTATE(request, {
        params: Promise.resolve({ id: decodeURIComponent(parts.at(-2) ?? "") }),
      });
    else response = await POST(request);
  }
  return {
    status: response.status,
    body: await response.json(),
    headers: Object.fromEntries(response.headers),
    ...(input.mode?.startsWith("observed-") ? { queries } : {}),
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
    (error) =>
      process.send?.({
        type: "worker-error",
        id: message.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
  );
});
process.on("disconnect", () => process.exit(0));
process.send?.({ type: "ready" });
