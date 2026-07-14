import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extensionPath = join(
  import.meta.dirname,
  "..",
  "extensions",
  "upstream-error-body-log.mjs",
);
const module = await import(pathToFileURL(extensionPath).href);
const extension = module.default;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

await test("captures bounded JSON 500 details without mutating response", async () => {
  const body = {
    error: {
      code: "SQLITE_BUSY",
      message: `database is locked ${"x".repeat(5000)}`,
      api_key: "sk-secret-value",
    },
  };
  const before = JSON.stringify(body);
  const record = module.buildRecord({
    ctx: {
      status: 500,
      headers: { "ah-request-id": "ar-123" },
      body,
      meta: { _requestedModel: "deepseek-v4-flash" },
    },
    now: new Date("2026-07-14T00:00:00Z"),
  });
  assert.equal(record.status, 500);
  assert.equal(record.request_id, "ar-123");
  assert.equal(record.error_code, "SQLITE_BUSY");
  assert.match(record.error_message, /^database is locked/);
  assert.ok(record.body_preview.length <= 4096);
  assert.doesNotMatch(record.body_preview, /sk-secret-value/);
  assert.equal(JSON.stringify(body), before);
});

await test("writes one JSONL record only for non-2xx JSON responses", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "upstream-error-body-"));
  const path = join(scratch, "errors.jsonl");
  const oldGate = process.env.CACHE_FIX_UPSTREAM_ERROR_BODY_LOG;
  const oldPath = process.env.CACHE_FIX_UPSTREAM_ERROR_BODY_LOG_PATH;
  process.env.CACHE_FIX_UPSTREAM_ERROR_BODY_LOG = "on";
  process.env.CACHE_FIX_UPSTREAM_ERROR_BODY_LOG_PATH = path;
  try {
    const meta = {};
    await extension.onRequest({ body: { model: "deepseek-v4-flash" }, meta });
    await extension.onResponse({
      status: 200,
      headers: {},
      body: { ok: true },
      meta,
    });
    await extension.onResponse({
      status: 500,
      headers: { "ah-request-id": "ar-500" },
      body: { error: { message: "database is locked" } },
      meta,
    });
    const lines = readFileSync(path, "utf8").trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.model, "deepseek-v4-flash");
    assert.equal(record.request_id, "ar-500");
  } finally {
    if (oldGate === undefined) delete process.env.CACHE_FIX_UPSTREAM_ERROR_BODY_LOG;
    else process.env.CACHE_FIX_UPSTREAM_ERROR_BODY_LOG = oldGate;
    if (oldPath === undefined) delete process.env.CACHE_FIX_UPSTREAM_ERROR_BODY_LOG_PATH;
    else process.env.CACHE_FIX_UPSTREAM_ERROR_BODY_LOG_PATH = oldPath;
    rmSync(scratch, { recursive: true, force: true });
  }
});

await test("logging failures fail open", async () => {
  const oldGate = process.env.CACHE_FIX_UPSTREAM_ERROR_BODY_LOG;
  const oldPath = process.env.CACHE_FIX_UPSTREAM_ERROR_BODY_LOG_PATH;
  process.env.CACHE_FIX_UPSTREAM_ERROR_BODY_LOG = "on";
  process.env.CACHE_FIX_UPSTREAM_ERROR_BODY_LOG_PATH = tmpdir();
  try {
    await extension.onResponse({
      status: 500,
      headers: {},
      body: { error: { message: "still forwarded" } },
      meta: {},
    });
  } finally {
    if (oldGate === undefined) delete process.env.CACHE_FIX_UPSTREAM_ERROR_BODY_LOG;
    else process.env.CACHE_FIX_UPSTREAM_ERROR_BODY_LOG = oldGate;
    if (oldPath === undefined) delete process.env.CACHE_FIX_UPSTREAM_ERROR_BODY_LOG_PATH;
    else process.env.CACHE_FIX_UPSTREAM_ERROR_BODY_LOG_PATH = oldPath;
  }
});

console.log(`\nUpstream error body log: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
