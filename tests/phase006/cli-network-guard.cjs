// Node preload inherited by Prisma's forked checkpoint process. Never record request payloads.
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS preload for Node --require and inherited child processes. */
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { syncBuiltinESMExports } = require("node:module");

const output = path.resolve(process.env.PHASE006_NETWORK_LOG || "");
const permittedRoot = path.resolve(__dirname, "../../.scaffold/phase006");
if (!output.startsWith(`${permittedRoot}${path.sep}`))
  throw new Error("Probe log must stay inside the Phase006 temporary directory");
const emit = (event) =>
  fs.appendFileSync(output, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function inspectRequest(input, options, protocol) {
  if (input instanceof URL || typeof input === "string") {
    const url = new URL(input);
    return {
      protocol: url.protocol,
      hostname: url.hostname,
      pathname: url.pathname,
      method: options?.method || "GET",
    };
  }
  const request = input || {};
  return {
    protocol: request.protocol || protocol,
    hostname: request.hostname || request.host || "localhost",
    pathname: String(request.path || "/").split("?")[0],
    method: request.method || "GET",
  };
}

function permit(destination, layer) {
  const blocked = !loopback.has(destination.hostname);
  emit({ kind: "request", layer, ...destination, blockedBeforeNetwork: blocked });
  if (blocked)
    throw Object.assign(new Error("Phase006 probe blocked public network access"), {
      code: "PHASE006_PUBLIC_NETWORK_BLOCKED",
    });
}

for (const [client, protocol] of [
  [http, "http:"],
  [https, "https:"],
]) {
  const request = client.request;
  client.request = function (...args) {
    permit(inspectRequest(args[0], args[1], protocol), "http");
    return request.apply(this, args);
  };
  client.get = function (...args) {
    const outgoing = client.request(...args);
    outgoing.end();
    return outgoing;
  };
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof options === "number")
    permit(
      { hostname: typeof args[1] === "string" ? args[1] : "localhost", port: options },
      "socket",
    );
  else if (options && typeof options === "object" && !options.path)
    permit(
      { hostname: options.hostname || options.host || "localhost", port: options.port },
      "socket",
    );
  return connect.apply(this, args);
};

const nativeFetch = globalThis.fetch;
globalThis.fetch = function (input, options) {
  permit(inspectRequest(input instanceof Request ? input.url : input, options, "https:"), "fetch");
  return nativeFetch.call(this, input, options);
};
syncBuiltinESMExports();
emit({
  kind: "process",
  program: path.basename(process.argv[1] || ""),
  checkpointDisabled: Boolean(process.env.CHECKPOINT_DISABLE),
});
