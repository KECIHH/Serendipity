import "next/dist/server/node-environment-baseline";
import { NextRequest } from "next/server";
import { GET as SETTINGS } from "@/app/api/admin/settings/route";
import { PATCH } from "@/app/api/admin/settings/[key]/route";
import { GET as DASHBOARD } from "@/app/api/admin/dashboard/stats/route";
import { GET as PUBLIC } from "@/app/api/config/public/route";
import {
  makeApiKeyRequest,
  type WorkerRequest,
  type WorkerResponse,
} from "../phase013/api-key-fixture";

async function handle(input: WorkerRequest): Promise<WorkerResponse> {
  const base = await makeApiKeyRequest(input);
  const headers = new Headers(base.headers);
  for (const [key, value] of Object.entries(input.headers ?? {})) headers.set(key, value);
  const request = new NextRequest(base.url, {
    method: base.method,
    headers,
    ...(base.method === "GET" ? {} : { body: input.rawBody ?? (await base.text()) }),
  });
  const pathname = new URL(request.url).pathname;
  let response: Response;
  if (pathname === "/api/config/public") response = await PUBLIC(request);
  else if (pathname === "/api/admin/dashboard/stats")
    response = await DASHBOARD(request, undefined);
  else if (pathname === "/api/admin/settings") response = await SETTINGS(request, undefined);
  else
    response = await PATCH(request, {
      params: Promise.resolve({ key: decodeURIComponent(pathname.split("/").at(-1)!) }),
    });
  return {
    status: response.status,
    body: response.status === 304 ? null : await response.json(),
    headers: Object.fromEntries(response.headers),
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
