import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const appData = process.env.APPDATA;
if (!appData) throw new Error("APPDATA is required");
const serverPath = join(
  appData,
  "npm",
  "node_modules",
  "claude-code-cache-fix",
  "proxy",
  "server.mjs",
);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

const scratch = mkdtempSync(join(tmpdir(), "cache-fix-proxy-resilience-"));
const extensionsDir = join(scratch, "extensions");
await import("node:fs/promises").then(({ mkdir }) => mkdir(extensionsDir));
const extensionsConfig = join(extensionsDir, "extensions.json");
writeFileSync(extensionsConfig, "{}\n");

let upstreamCalls = 0;
const upstream = createServer(async (req, res) => {
  for await (const _chunk of req) {}
  upstreamCalls++;
  res.setHeader("content-type", "application/json");
  res.setHeader("ah-request-id", `ar-${upstreamCalls}`);
  if (upstreamCalls <= 5) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: { code: "SQLITE_BUSY", message: "database is locked" } }));
  } else {
    res.statusCode = 200;
    res.end(JSON.stringify({ id: "ok", type: "message", content: [] }));
  }
});

let proxy;
try {
  const upstreamPort = await listen(upstream);
  process.env.CACHE_FIX_PROXY_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
  const { startProxy } = await import(`${pathToFileURL(serverPath).href}?resilience=${Date.now()}`);
  proxy = await startProxy({
    port: 0,
    bind: "127.0.0.1",
    watch: false,
    extensionsDir,
    extensionsConfig,
  });
  const base = `http://127.0.0.1:${proxy.port}`;

  for (let index = 1; index <= 5; index++) {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }),
    });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, "SQLITE_BUSY");
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");
  }

  const recovered = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }),
  });
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).id, "ok");
  assert.equal(upstreamCalls, 6);
  console.log("PASS proxy survives repeated upstream 500 responses and recovers");
} finally {
  if (proxy) await proxy.close();
  await close(upstream);
  rmSync(scratch, { recursive: true, force: true });
}
