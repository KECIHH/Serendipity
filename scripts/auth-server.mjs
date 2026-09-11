import http from "node:http";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import next from "next";

const load = createRequire(import.meta.url);
const { readAuthServerEnv } = load("../src/lib/env-cli.ts");
const { parseTrustedProxyCidrs, stampTrustedRequest, runWithTrustedRequest } = load(
  "../src/server/ingress.ts",
);

const { values } = parseArgs({
  options: {
    dev: { type: "boolean", default: false },
    port: { type: "string", short: "p" },
    hostname: { type: "string", short: "H", default: "127.0.0.1" },
  },
});

const bootstrapPort = values.port ?? "3000";
if (
  !/^[0-9]{1,5}$/.test(bootstrapPort) ||
  Number(bootstrapPort) < 1 ||
  Number(bootstrapPort) > 65535
) {
  throw new Error("A valid listening port is required.");
}
const port = Number(bootstrapPort),
  hostname = values.hostname;
const app = next({ dev: values.dev, hostname, port });
await app.prepare();
const config = readAuthServerEnv();
const trustedProxyCidrs = parseTrustedProxyCidrs(String(config.AUTH_TRUSTED_PROXY_CIDRS));
const origin = new URL(String(config.AUTH_URL));
const handler = app.getRequestHandler();
const upgrade = app.getUpgradeHandler();

function prepareRequest(request) {
  stampTrustedRequest(request, { secret: String(config.AUTH_SECRET), trustedProxyCidrs });
  // Pin framework URL inference as well as the explicit Auth.js callbacks to server configuration.
  request.headers.host = origin.host;
  request.headers["x-forwarded-proto"] = origin.protocol.slice(0, -1);
}

const server = http.createServer(
  { maxHeaderSize: 16_384, requestTimeout: 30_000 },
  (request, response) => {
    try {
      prepareRequest(request);
      void runWithTrustedRequest(request, () => handler(request, response)).catch(() => {
        if (!response.headersSent)
          response.writeHead(503, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          });
        response.end("服务暂不可用");
      });
    } catch {
      response.writeHead(503, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end("服务暂不可用");
    }
  },
);
server.on("upgrade", (request, socket, head) => {
  try {
    prepareRequest(request);
    void upgrade(request, socket, head);
  } catch {
    socket.destroy();
  }
});
server.listen(port, hostname, () => console.log(`Serendipity listening on ${hostname}:${port}`));

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  server.close();
  await app.close();
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
