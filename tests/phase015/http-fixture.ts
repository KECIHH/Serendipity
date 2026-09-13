import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { createIsolatedHttpTransport } from "@/server/ai/deepseek-provider";

export const publicDns = (async () => [
  { address: "93.184.216.34", family: 4 },
]) as unknown as typeof import("node:dns/promises").lookup;
export interface HttpObservation {
  path: string;
  method: string;
  headers: IncomingHttpHeaders;
  body: string;
}
export async function startHttpFixture(
  handler: (request: HttpObservation, response: ServerResponse) => void | Promise<void>,
) {
  const requests: HttpObservation[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const row = {
      path: request.url!,
      method: request.method!,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    requests.push(row);
    try {
      await handler(row, response);
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listen failed");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    requests,
    transport: createIsolatedHttpTransport(origin),
    dnsLookup: publicDns,
    async waitForRequests(count: number) {
      const deadline = Date.now() + 3000;
      while (requests.length < count) {
        if (Date.now() > deadline) throw new Error("Expected isolated request was not dispatched");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export function sendCompletion(
  response: ServerResponse,
  output: unknown,
  usage = { prompt_tokens: 10, completion_tokens: 10 },
) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: "synthetic_request",
      choices: [{ message: { content: JSON.stringify(output) } }],
      usage,
    }),
  );
}
