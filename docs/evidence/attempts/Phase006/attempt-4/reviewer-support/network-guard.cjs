// Review-only probe: record request destinations and block before public network I/O.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');
const logPath = process.env.PHASE006_REVIEW_NETWORK_LOG;
if (!logPath || !path.resolve(logPath).includes(`${path.sep}.scaffold${path.sep}`)) {
  throw new Error('Review log must be in .scaffold');
}
const log = (event) => fs.appendFileSync(logPath, JSON.stringify({at:new Date().toISOString(),pid:process.pid,...event}) + '\n');
const isLocal = (host) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
function target(input, options = {}, protocol = 'http:') {
  if (typeof input === 'string' || input instanceof URL) {
    const url = new URL(input);
    return {protocol:url.protocol,hostname:url.hostname,pathname:url.pathname,method:options.method || 'GET'};
  }
  const value = input || {};
  return {protocol:value.protocol || protocol,hostname:value.hostname || value.host || 'localhost',pathname:String(value.path || '/').split('?')[0],method:value.method || 'GET'};
}
function guard(info, layer) {
  const blocked = !isLocal(info.hostname);
  log({event:'network-request',layer,...info,blocked});
  if (blocked) throw Object.assign(new Error('Independent review blocked public network request'),{code:'REVIEW_PUBLIC_NETWORK_BLOCKED'});
}
for (const [module, protocol] of [[http,'http:'],[https,'https:']]) {
  const original = module.request;
  module.request = function (...args) {
    guard(target(args[0],args[1],protocol),'http-request');
    return original.apply(this,args);
  };
  module.get = function (...args) { const request = module.request(...args); request.end(); return request; };
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof options === 'object' && options !== null && !options.path) {
    guard({hostname:options.host || options.hostname || 'localhost',port:options.port},'socket-connect');
  } else if (typeof options === 'number') {
    guard({hostname:typeof args[1] === 'string' ? args[1] : 'localhost',port:options},'socket-connect');
  }
  return originalConnect.apply(this,args);
};
if (globalThis.fetch) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (input, options) {
    guard(target(input instanceof Request ? input.url : input, options),'fetch');
    return originalFetch.call(this,input,options);
  };
}
syncBuiltinESMExports();
log({event:'process-start',program:path.basename(process.argv[1] || ''),checkpointDisable:Boolean(process.env.CHECKPOINT_DISABLE),checkpointDisableTelemetry:process.env.CHECKPOINT_DISABLE_TELEMETRY === '1'});
