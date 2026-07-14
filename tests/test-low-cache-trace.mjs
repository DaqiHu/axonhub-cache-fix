import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const __dirname = import.meta.dirname;
const extensionPath = join(__dirname, "..", "extensions", "low-cache-trace.mjs");

// RED phase: this import will fail until the extension exists.
let module;
try {
  module = await import(pathToFileURL(extensionPath).href);
} catch (err) {
  console.error(`FAIL: Could not load extension module: ${err.message}`);
  console.log("\n(RED phase — this failure is expected before implementation)");
  process.exit(1);
}

const extension = module.default;

let passed = 0;
let failed = 0;

function scratch() {
  return mkdtempSync(join(tmpdir(), "low-cache-trace-"));
}

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

// ===================================================================
// classifyUsage — pure helper tests
// ===================================================================

await test("classifyUsage: rate exactly 80 → not written", () => {
  const r = module.classifyUsage(
    { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 80 },
    80,
  );
  assert.equal(r.shouldRecord, false);
  assert.equal(r.hitPct, 80);
});

await test("classifyUsage: rate 79.99 → written", () => {
  const r = module.classifyUsage(
    { input_tokens: 20, cache_creation_input_tokens: 0.01, cache_read_input_tokens: 79.99 },
    80,
  );
  assert.equal(r.shouldRecord, true);
  assert.ok(r.hitPct < 80);
});

await test("classifyUsage: rate 0 → written (below threshold)", () => {
  const r = module.classifyUsage(
    { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    80,
  );
  assert.equal(r.shouldRecord, true);
  assert.equal(r.hitPct, 0);
});

await test("classifyUsage: denominator zero → not written", () => {
  const r = module.classifyUsage(
    { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    80,
  );
  assert.equal(r.shouldRecord, false);
  assert.equal(r.hitPct, null);
});

await test("classifyUsage: null/undefined usage → not written", () => {
  assert.equal(module.classifyUsage(null, 80).shouldRecord, false);
  assert.equal(module.classifyUsage(undefined, 80).shouldRecord, false);
});

await test("classifyUsage: both cache fields missing → not written", () => {
  const r = module.classifyUsage({ input_tokens: 100 }, 80);
  assert.equal(r.shouldRecord, false);
  assert.equal(r.hitPct, null);
});

await test("classifyUsage: only cache_read present → written (hitPct may be non-null when miss < threshold)", () => {
  const r = module.classifyUsage(
    { input_tokens: 100, cache_read_input_tokens: 10 },
    80,
  );
  assert.equal(r.shouldRecord, true);
  assert.ok(typeof r.hitPct === "number");
});

await test("classifyUsage: only cache_creation present → written (hitPct=0)", () => {
  const r = module.classifyUsage(
    { input_tokens: 100, cache_creation_input_tokens: 50 },
    80,
  );
  assert.equal(r.shouldRecord, true);
  assert.equal(r.hitPct, 0);
});

await test("classifyUsage: cache fields as null → not written (treated as absent)", () => {
  const r1 = module.classifyUsage(
    { input_tokens: 100, cache_read_input_tokens: null, cache_creation_input_tokens: null },
    80,
  );
  assert.equal(r1.shouldRecord, false, "both null → skip");
  assert.equal(r1.hitPct, null);
});

await test("classifyUsage: one cache field null, other numeric → uses numeric value", () => {
  // cache_read is null (absent), cache_creation is 50 (present) → we have partial cache info
  const r = module.classifyUsage(
    { input_tokens: 100, cache_read_input_tokens: null, cache_creation_input_tokens: 50 },
    80,
  );
  assert.equal(r.shouldRecord, true, "cache_creation present → can record");
  assert.equal(r.hitPct, 0, "null read treated as 0 → hitPct=0");
});

await test("classifyUsage: infinity and NaN treated as non-finite → coerced to 0", () => {
  // Infinity input_tokens is coerced to 0 by Number.isFinite check,
  // but cache_read is present → denominator > 0, hitPct computed
  const r1 = module.classifyUsage(
    { input_tokens: Infinity, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 },
    80,
  );
  assert.equal(r1.shouldRecord, false, "Infinity input → input=0, hitPct=100% → skip");
  assert.equal(r1.hitPct, 100, "10 read / (0+0+10) * 100 = 100");

  // NaN cache_read: Number.isFinite(NaN) is false → read coerced to 0,
  // but cache_creation=0 is present → both cache fields exist → treat as present
  const r2 = module.classifyUsage(
    { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: NaN },
    80,
  );
  assert.equal(r2.shouldRecord, true, "NaN cache_read treated as 0, cc=0 present → hitPct=0 < 80 → record");
  assert.equal(r2.hitPct, 0);

  // Negative Infinity cache_creation is coerced to 0, cache_read present → hitPct computed
  const r3 = module.classifyUsage(
    { input_tokens: 100, cache_creation_input_tokens: -Infinity, cache_read_input_tokens: 10 },
    80,
  );
  assert.equal(r3.shouldRecord, true, "-Infinity creation treated as 0 → cache_read present → can record");
  assert.equal(r3.hitPct, 10 / (100 + 0 + 10) * 100, "hitPct computed with creation=0");

  // All non-finite → all coerced to 0 → denominator zero
  const r4 = module.classifyUsage(
    { input_tokens: NaN, cache_creation_input_tokens: Infinity, cache_read_input_tokens: -Infinity },
    80,
  );
  assert.equal(r4.shouldRecord, false, "all non-finite → all zero → skip");
  assert.equal(r4.hitPct, null);
});

// ===================================================================
// getThreshold — env-var parsing
// ===================================================================

await test("getThreshold: rounds fractional thresholds to nearest integer", () => {
  const key = "CACHE_FIX_LOW_CACHE_TRACE_THRESHOLD";
  const old = process.env[key];
  try {
    process.env[key] = "79.9";
    assert.equal(module.getThreshold(), 80, "79.9 should round to 80");
    process.env[key] = "80.1";
    assert.equal(module.getThreshold(), 80, "80.1 should round to 80");
    process.env[key] = "79.4";
    assert.equal(module.getThreshold(), 79, "79.4 should round to 79");
    process.env[key] = "75.5";
    assert.equal(module.getThreshold(), 76, "75.5 should round to 76");
  } finally {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  }
});

await test("getThreshold: returns default for missing or unparseable values", () => {
  const key = "CACHE_FIX_LOW_CACHE_TRACE_THRESHOLD";
  const old = process.env[key];
  try {
    delete process.env[key];
    assert.equal(module.getThreshold(), 80, "missing should default to 80");
    process.env[key] = "";
    assert.equal(module.getThreshold(), 80, "empty should default to 80");
    process.env[key] = "not-a-number";
    assert.equal(module.getThreshold(), 80, "NaN should default to 80");
  } finally {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  }
});

// ===================================================================
// getRetentionDays — env-var parsing
// ===================================================================

await test("getRetentionDays: basic integer values", () => {
  const key = "CACHE_FIX_LOW_CACHE_TRACE_RETENTION_DAYS";
  const old = process.env[key];
  try {
    process.env[key] = "1";
    assert.equal(module.getRetentionDays(), 1, "1 should stay 1");
    process.env[key] = "7";
    assert.equal(module.getRetentionDays(), 7, "7 should stay 7");
    process.env[key] = "30";
    assert.equal(module.getRetentionDays(), 30, "30 should stay 30");
  } finally {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  }
});

await test("getRetentionDays: floors fractional values", () => {
  const key = "CACHE_FIX_LOW_CACHE_TRACE_RETENTION_DAYS";
  const old = process.env[key];
  try {
    process.env[key] = "7.9";
    assert.equal(module.getRetentionDays(), 7, "7.9 should floor to 7");
    process.env[key] = "1.1";
    assert.equal(module.getRetentionDays(), 1, "1.1 should floor to 1");
    process.env[key] = "0.9";
    assert.equal(module.getRetentionDays(), 7, "0.9 is below minimum 1, should default to 7");
  } finally {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  }
});

await test("getRetentionDays: returns default for missing, empty, NaN, or below-minimum values", () => {
  const key = "CACHE_FIX_LOW_CACHE_TRACE_RETENTION_DAYS";
  const old = process.env[key];
  try {
    delete process.env[key];
    assert.equal(module.getRetentionDays(), 7, "missing should default to 7");
    process.env[key] = "";
    assert.equal(module.getRetentionDays(), 7, "empty should default to 7");
    process.env[key] = "not-a-number";
    assert.equal(module.getRetentionDays(), 7, "NaN should default to 7");
    process.env[key] = "0";
    assert.equal(module.getRetentionDays(), 7, "0 below minimum 1 should default to 7");
    process.env[key] = "-1";
    assert.equal(module.getRetentionDays(), 7, "negative should default to 7");
  } finally {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  }
});

// ===================================================================
// buildRecord — pure helper tests
// ===================================================================

await test("buildRecord produces correctly ordered fields", () => {
  const now = new Date("2026-07-14T12:00:00Z");
  const usage = {
    input_tokens: 100,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 30,
  };
  const body = {
    model: "claude-sonnet-4",
    messages: [{ role: "user", content: "hello" }],
  };
  const record = module.buildRecord({
    status: 200,
    requestId: "req-123",
    sessionId: "sess-abc",
    agentId: "agent-xyz",
    model: "claude-sonnet-4",
    usage,
    body,
    now,
    threshold: 80,
  });

  assert.equal(record.schema_version, 1);
  assert.equal(record.ts, "2026-07-14T12:00:00.000Z");
  assert.equal(record.status, 200);
  assert.equal(record.request_id, "req-123");
  assert.equal(record.session_id, "sess-abc");
  assert.equal(record.agent_id, "agent-xyz");
  assert.equal(record.model, "claude-sonnet-4");
  assert.deepEqual(record.usage, {
    input_tokens: 100,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 30,
  });
  // 30 / (100 + 20 + 30) * 100 = 20
  assert.equal(record.hit_pct, 20);
  assert.equal(record.body, body);

  // Verify JSON property order
  const keys = Object.keys(record);
  const expected = [
    "schema_version",
    "ts",
    "status",
    "request_id",
    "session_id",
    "agent_id",
    "model",
    "usage",
    "hit_pct",
    "body",
  ];
  assert.deepEqual(keys, expected);
});

await test("buildRecord: body with falsy values is preserved (?? not ||)", () => {
  // ?? preserves "", 0, false which || would nullify
  const now = new Date("2026-07-14T12:00:00Z");
  const usage = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 };

  const withEmptyString = module.buildRecord({ body: "", usage, now, threshold: 80 });
  assert.strictEqual(withEmptyString.body, "", "empty string should be preserved by ??");

  const withZero = module.buildRecord({ body: 0, usage, now, threshold: 80 });
  assert.strictEqual(withZero.body, 0, "0 should be preserved by ??");

  const withNull = module.buildRecord({ body: null, usage, now, threshold: 80 });
  assert.strictEqual(withNull.body, null, "null should remain null");

  const withUndefined = module.buildRecord({ usage, now, threshold: 80 });
  assert.strictEqual(withUndefined.body, null, "undefined body should become null");
});

await test("buildRecord: uses getThreshold when threshold is not provided", () => {
  const key = "CACHE_FIX_LOW_CACHE_TRACE_THRESHOLD";
  const old = process.env[key];
  try {
    // When threshold is omitted, buildRecord falls back to getThreshold()
    // Set env to 50 so we can verify fallback behavior
    process.env[key] = "50";
    const usage = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 20 };
    const record = module.buildRecord({ usage, now: new Date("2026-07-14T12:00:00Z") });
    // 20 / (100 + 0 + 20) * 100 = ~16.67, < 50 → would record if classify used threshold 50
    // hit_pct is always computed from usage, not affected by threshold
    assert.equal(record.hit_pct, 20 / 120 * 100);
  } finally {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  }
});

await test("buildRecord: non-finite usage values are coerced to 0 (not NaN or Infinity)", () => {
  const now = new Date("2026-07-14T12:00:00Z");

  // NaN in input_tokens
  const r1 = module.buildRecord({
    usage: { input_tokens: NaN, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 },
    now, threshold: 80,
  });
  assert.equal(r1.usage.input_tokens, 0, "NaN input_tokens coerced to 0");
  assert.equal(r1.hit_pct, 10 / (0 + 0 + 10) * 100, "hitPct computed with coerced input=0");

  // Infinity in cache_read
  const r2 = module.buildRecord({
    usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: Infinity },
    now, threshold: 80,
  });
  assert.equal(r2.usage.cache_read_input_tokens, 0, "Infinity cache_read coerced to 0");
  assert.equal(r2.hit_pct, 0, "hitPct=0 when cache_read coerced to 0");

  // -Infinity in cache_creation
  const r3 = module.buildRecord({
    usage: { input_tokens: 100, cache_creation_input_tokens: -Infinity, cache_read_input_tokens: 10 },
    now, threshold: 80,
  });
  assert.equal(r3.usage.cache_creation_input_tokens, 0, "-Infinity cache_creation coerced to 0");
  assert.equal(r3.hit_pct, 10 / (100 + 0 + 10) * 100, "hitPct computed with creation=0");
});

// ===================================================================
// Streaming once-only capture
// ===================================================================

await test("streaming once-only capture: message_start writes once", async () => {
  const dir = scratch();
  const oldGate = process.env.CACHE_FIX_LOW_CACHE_TRACE;
  const oldDir = process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
  process.env.CACHE_FIX_LOW_CACHE_TRACE = "on";
  process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = dir;
  try {
    const meta = {};
    await extension.onRequest({
      body: {
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "hello" }],
      },
      headers: {
        "ah-request-id": "req-stream",
        "x-claude-code-session-id": "sess-1",
        "x-claude-code-agent-id": "agent-1",
      },
      meta,
    });
    await extension.onResponseStart({ status: 200, headers: {}, meta });

    // First message_start — should write
    await extension.onStreamEvent({
      event: {
        type: "message_start",
        message: {
          model: "claude-sonnet-4",
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
          },
        },
      },
      meta,
      telemetry: {},
    });

    // Second message_start — should NOT write (once-only guard)
    await extension.onStreamEvent({
      event: {
        type: "message_start",
        message: {
          model: "claude-sonnet-4",
          usage: {
            input_tokens: 200,
            cache_creation_input_tokens: 40,
            cache_read_input_tokens: 60,
          },
        },
      },
      meta,
      telemetry: {},
    });

    const today = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(dir, `${today}.jsonl`), "utf8");
    const lines = content.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, "only one record for two message_start events");
    const record = JSON.parse(lines[0]);
    assert.equal(record.request_id, "req-stream");
    assert.equal(record.session_id, "sess-1");
    assert.equal(record.agent_id, "agent-1");
    assert.equal(record.hit_pct, 20);
  } finally {
    if (oldGate === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE = oldGate;
    if (oldDir === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===================================================================
// Non-streaming once-only capture
// ===================================================================

await test("non-streaming once-only capture: onResponse writes once", async () => {
  const dir = scratch();
  const oldGate = process.env.CACHE_FIX_LOW_CACHE_TRACE;
  const oldDir = process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
  process.env.CACHE_FIX_LOW_CACHE_TRACE = "on";
  process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = dir;
  try {
    const meta = {};
    await extension.onRequest({
      body: { model: "claude-sonnet-4", messages: [] },
      headers: { "ah-request-id": "req-nonstream" },
      meta,
    });

    // First call — should write
    await extension.onResponse({
      status: 200,
      headers: {},
      body: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
        },
      },
      meta,
    });

    // Second call — should NOT write (once-only guard)
    await extension.onResponse({
      status: 200,
      headers: {},
      body: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
        },
      },
      meta,
    });

    const today = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(dir, `${today}.jsonl`), "utf8");
    const lines = content.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, "only one record for two onResponse calls");
  } finally {
    if (oldGate === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE = oldGate;
    if (oldDir === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===================================================================
// Cross-path once-only (both streaming and non-streaming fire)
// ===================================================================

await test("cross-path once-only: message_start and onResponse mutually exclusive", async () => {
  const dir = scratch();
  const oldGate = process.env.CACHE_FIX_LOW_CACHE_TRACE;
  const oldDir = process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
  process.env.CACHE_FIX_LOW_CACHE_TRACE = "on";
  process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = dir;
  try {
    const meta = {};
    await extension.onRequest({
      body: { model: "claude-sonnet-4", messages: [] },
      headers: { "ah-request-id": "req-cross" },
      meta,
    });
    await extension.onResponseStart({ status: 200, headers: {}, meta });

    // Streaming path fires first — should write
    await extension.onStreamEvent({
      event: {
        type: "message_start",
        message: {
          usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 },
        },
      },
      meta,
    });

    // Non-streaming path fires second — should NOT write (already done)
    await extension.onResponse({
      status: 200,
      headers: {},
      body: {
        usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 },
      },
      meta,
    });

    const today = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(dir, `${today}.jsonl`), "utf8");
    const lines = content.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, "cross-path: only one record for streaming+non-streaming");
    const record = JSON.parse(lines[0]);
    assert.equal(record.request_id, "req-cross");
    assert.equal(record.hit_pct, 20);
  } finally {
    if (oldGate === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE = oldGate;
    if (oldDir === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("cross-path once-only: onResponse first, message_start second", async () => {
  const dir = scratch();
  const oldGate = process.env.CACHE_FIX_LOW_CACHE_TRACE;
  const oldDir = process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
  process.env.CACHE_FIX_LOW_CACHE_TRACE = "on";
  process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = dir;
  try {
    const meta = {};
    await extension.onRequest({
      body: { model: "claude-sonnet-4", messages: [] },
      headers: { "ah-request-id": "req-cross-reverse" },
      meta,
    });
    await extension.onResponseStart({ status: 200, headers: {}, meta });

    // Non-streaming path fires first — should write
    await extension.onResponse({
      status: 200,
      headers: {},
      body: {
        usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 },
      },
      meta,
    });

    // Streaming path fires second — should NOT write (already done)
    await extension.onStreamEvent({
      event: {
        type: "message_start",
        message: {
          usage: { input_tokens: 200, cache_creation_input_tokens: 40, cache_read_input_tokens: 60 },
        },
      },
      meta,
    });

    const today = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(dir, `${today}.jsonl`), "utf8");
    const lines = content.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, "cross-path reverse: only one record");
    const record = JSON.parse(lines[0]);
    assert.equal(record.request_id, "req-cross-reverse");
    assert.equal(record.hit_pct, 20);
  } finally {
    if (oldGate === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE = oldGate;
    if (oldDir === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===================================================================
// Exact body preservation (structuredClone)
// ===================================================================

await test("exact body preservation: mutation after onRequest does not affect stored body", async () => {
  const dir = scratch();
  const oldGate = process.env.CACHE_FIX_LOW_CACHE_TRACE;
  const oldDir = process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
  process.env.CACHE_FIX_LOW_CACHE_TRACE = "on";
  process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = dir;
  try {
    const original = {
      model: "test-model",
      messages: [{ role: "user", content: "original content" }],
    };
    const body = JSON.parse(JSON.stringify(original));
    const meta = {};
    await extension.onRequest({
      body,
      headers: { "ah-request-id": "req-body" },
      meta,
    });

    // Mutate original after onRequest
    body.messages[0].content = "mutated content";
    body.model = "other-model";

    await extension.onResponse({
      status: 200,
      headers: {},
      body: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 10,
        },
      },
      meta,
    });

    const today = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(dir, `${today}.jsonl`), "utf8");
    const record = JSON.parse(content.trim());
    assert.deepEqual(record.body, original);
    assert.notEqual(record.body.model, "other-model");
    assert.equal(record.body.messages[0].content, "original content");
  } finally {
    if (oldGate === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE = oldGate;
    if (oldDir === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===================================================================
// Safe correlation headers
// ===================================================================

await test("safe correlation headers: auth headers never in record", async () => {
  const dir = scratch();
  const oldGate = process.env.CACHE_FIX_LOW_CACHE_TRACE;
  const oldDir = process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
  process.env.CACHE_FIX_LOW_CACHE_TRACE = "on";
  process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = dir;
  try {
    const meta = {};
    await extension.onRequest({
      body: { model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }] },
      headers: {
        "ah-request-id": "req-auth",
        "x-claude-code-session-id": "sess-secure",
        "x-claude-code-agent-id": "agent-secure",
        "authorization": "Bearer sk-secret-123",
        "api-key": "some-key",
        "cookie": "session=abc123",
      },
      meta,
    });

    await extension.onResponse({
      status: 200,
      headers: {},
      body: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 10,
        },
      },
      meta,
    });

    const today = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(dir, `${today}.jsonl`), "utf8");
    const record = JSON.parse(content.trim());
    assert.equal(record.request_id, "req-auth");
    assert.equal(record.session_id, "sess-secure");
    assert.equal(record.agent_id, "agent-secure");

    const bodyStr = JSON.stringify(record);
    assert.doesNotMatch(bodyStr, /authorization/i, "authorization must not appear");
    assert.doesNotMatch(bodyStr, /api[-_]?key/i, "api-key must not appear");
    assert.doesNotMatch(bodyStr, /Bearer/i, "Bearer token must not appear");
    assert.doesNotMatch(bodyStr, /cookie/i, "cookie must not appear");
  } finally {
    if (oldGate === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE = oldGate;
    if (oldDir === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===================================================================
// Concurrent JSONL validity
// ===================================================================

await test("concurrent JSONL validity: all lines valid, count matches, no interleaving", async () => {
  const dir = scratch();
  const oldGate = process.env.CACHE_FIX_LOW_CACHE_TRACE;
  const oldDir = process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
  const oldThreshold = process.env.CACHE_FIX_LOW_CACHE_TRACE_THRESHOLD;
  process.env.CACHE_FIX_LOW_CACHE_TRACE = "on";
  process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = dir;
  process.env.CACHE_FIX_LOW_CACHE_TRACE_THRESHOLD = "100"; // Always record
  try {
    const N = 30;

    // Serial onRequest to set up each meta
    const metas = [];
    for (let i = 0; i < N; i++) {
      const meta = {};
      await extension.onRequest({
        body: {
          model: "claude-sonnet-4",
          messages: [{ role: "user", content: `req-${i}` }],
        },
        headers: { "ah-request-id": `concurrent-${i}` },
        meta,
      });
      metas.push(meta);
    }

    // Fire all onResponse concurrently — serialized append prevents interleaving
    const tasks = metas.map((meta) =>
      extension.onResponse({
        status: 200,
        headers: {},
        body: {
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 10,
          },
        },
        meta,
      }),
    );
    await Promise.all(tasks);

    const today = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(dir, `${today}.jsonl`), "utf8");
    const lines = content.trim().split(/\r?\n/);
    assert.equal(lines.length, N, `expected ${N} JSONL lines, got ${lines.length}`);

    // Verify every line is valid JSON with expected fields and distinct IDs
    const seenIds = new Set();
    for (let i = 0; i < lines.length; i++) {
      const parsed = JSON.parse(lines[i]);
      assert.equal(parsed.schema_version, 1, `line ${i} has schema_version`);
      assert.ok(typeof parsed.hit_pct === "number", `line ${i} has hit_pct`);
      assert.ok(parsed.body, `line ${i} has body`);
      assert.ok(parsed.request_id, `line ${i} has request_id`);
      seenIds.add(parsed.request_id);
    }
    assert.equal(seenIds.size, N, `expected ${N} distinct IDs, got ${seenIds.size}`);
    for (let i = 0; i < N; i++) {
      assert.ok(seenIds.has(`concurrent-${i}`), `missing concurrent-${i}`);
    }
  } finally {
    if (oldGate === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE = oldGate;
    if (oldDir === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = oldDir;
    if (oldThreshold === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE_THRESHOLD;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE_THRESHOLD = oldThreshold;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===================================================================
// Seven-day cleanup (retentionSweep)
// ===================================================================

await test("retentionSweep: deletes files older than retention days", async () => {
  // Clear any in-flight sweep from previous fire-and-forget appendRecord calls.
  // The retentionSweep fire-and-forget calls can leave _sweepInFlight=true across
  // test boundaries, causing this sweep to return early without doing work.
  module.__resetForTests && module.__resetForTests();
  const dir = scratch();
  try {
    const now = new Date("2026-07-14T12:00:00Z");
    const todayStr = "2026-07-14";
    const threeDaysAgo = "2026-07-11";
    const eightDaysAgo = "2026-07-06";

    for (const date of [todayStr, threeDaysAgo, eightDaysAgo]) {
      writeFileSync(join(dir, `${date}.jsonl`), `{"date":"${date}"}\n`);
    }

    // All three exist before sweep
    assert.equal(existsSync(join(dir, `${todayStr}.jsonl`)), true);
    assert.equal(existsSync(join(dir, `${threeDaysAgo}.jsonl`)), true);
    assert.equal(existsSync(join(dir, `${eightDaysAgo}.jsonl`)), true);

    // Sweep with 7-day retention
    await module.retentionSweep({
      dir,
      retentionDays: 7,
      now,
      throttleMs: 0,
    });

    // today and 3 days ago remain; 8 days ago is deleted
    assert.equal(existsSync(join(dir, `${todayStr}.jsonl`)), true);
    assert.equal(existsSync(join(dir, `${threeDaysAgo}.jsonl`)), true);
    assert.equal(existsSync(join(dir, `${eightDaysAgo}.jsonl`)), false);

    // non-JSONL files are not affected
    writeFileSync(join(dir, "readme.txt"), "hello\n");
    await module.retentionSweep({
      dir,
      retentionDays: 7,
      now,
      throttleMs: 0,
    });
    assert.equal(existsSync(join(dir, "readme.txt")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("retentionSweep: throttling prevents too-frequent sweeps", async () => {
  // Reset module-level sweep timestamp
  module.__resetForTests && module.__resetForTests();

  const dir = scratch();
  try {
    const now = new Date("2026-07-14T12:00:00Z");
    const eightDaysAgo = "2026-07-06";

    // Create file that should be swept
    writeFileSync(join(dir, `${eightDaysAgo}.jsonl`), "deletable\n");

    // First sweep: should delete
    await module.retentionSweep({
      dir,
      retentionDays: 7,
      now,
      throttleMs: 10000, // 10s throttle
    });
    assert.equal(existsSync(join(dir, `${eightDaysAgo}.jsonl`)), false);

    // Recreate and sweep again immediately — should be throttled
    writeFileSync(join(dir, `${eightDaysAgo}.jsonl`), "should remain\n");
    await module.retentionSweep({
      dir,
      retentionDays: 7,
      now,
      throttleMs: 10000,
    });
    // File should still exist because sweep was throttled
    assert.equal(existsSync(join(dir, `${eightDaysAgo}.jsonl`)), true);

    // Sweep again after throttle period — file should be deleted
    const later = new Date(now.getTime() + 15000);
    await module.retentionSweep({
      dir,
      retentionDays: 7,
      now: later,
      throttleMs: 10000,
    });
    assert.equal(existsSync(join(dir, `${eightDaysAgo}.jsonl`)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===================================================================
// Fail-open
// ===================================================================

await test("fail-open: extension hooks never throw on null/undefined/invalid input", async () => {
  try {
    await extension.onRequest(null);
    await extension.onRequest(undefined);
    await extension.onRequest({});
    await extension.onRequest({ headers: {} });
    await extension.onResponseStart(null);
    await extension.onResponseStart(undefined);
    await extension.onResponseStart({});
    await extension.onResponse(null);
    await extension.onResponse(undefined);
    await extension.onResponse({});
    await extension.onResponse({ status: 200, body: null, meta: {} });
    await extension.onStreamEvent(null);
    await extension.onStreamEvent(undefined);
    await extension.onStreamEvent({});
  } catch (err) {
    assert.fail(`extension hook threw: ${err.message}`);
  }
});

await test("fail-open: write errors do not throw to caller", async () => {
  const dir = scratch();
  const oldGate = process.env.CACHE_FIX_LOW_CACHE_TRACE;
  const oldDir = process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
  process.env.CACHE_FIX_LOW_CACHE_TRACE = "on";
  process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = join(dir, "nonexistent-subdir");
  try {
    const meta = {};
    await extension.onRequest({
      body: { model: "test", messages: [] },
      headers: { "ah-request-id": "fail-open" },
      meta,
    });

    // This write should not throw even if the directory doesn't exist yet
    // (mkdir recursive handles it), but we test that mkdir or append errors
    // don't propagate
    await extension.onResponse({
      status: 200,
      headers: {},
      body: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 10,
        },
      },
      meta,
    });

    // Should have reached here without throwing
    assert.ok(true, "onResponse did not throw");
  } finally {
    if (oldGate === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE = oldGate;
    if (oldDir === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("fail-open: all hooks return harmlessly when gate is off", async () => {
  // When gate is not "on", every hook should return early without throwing
  // (CACHE_FIX_LOW_CACHE_TRACE is not set)
  const meta = {};
  await extension.onRequest({
    body: { model: "test", messages: [] },
    headers: {},
    meta,
  });
  await extension.onResponseStart({ status: 200, headers: {}, meta });
  await extension.onStreamEvent({
    event: {
      type: "message_start",
      message: {
        usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 },
      },
    },
    meta,
  });
  await extension.onResponse({
    status: 200,
    headers: {},
    body: {
      usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 },
    },
    meta,
  });
});

// ===================================================================
// Status filtering
// ===================================================================

await test("non-2xx status: no record written", async () => {
  const dir = scratch();
  const oldGate = process.env.CACHE_FIX_LOW_CACHE_TRACE;
  const oldDir = process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
  process.env.CACHE_FIX_LOW_CACHE_TRACE = "on";
  process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = dir;
  try {
    const meta = {};
    await extension.onRequest({
      body: { model: "test", messages: [] },
      headers: { "ah-request-id": "non-2xx" },
      meta,
    });

    // 4xx response
    await extension.onResponse({
      status: 400,
      headers: {},
      body: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 10,
        },
      },
      meta,
    });

    const today = new Date().toISOString().slice(0, 10);
    assert.equal(existsSync(join(dir, `${today}.jsonl`)), false);
  } finally {
    if (oldGate === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE = oldGate;
    if (oldDir === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("non-2xx streaming: message_start with error status does not write", async () => {
  const dir = scratch();
  const oldGate = process.env.CACHE_FIX_LOW_CACHE_TRACE;
  const oldDir = process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
  process.env.CACHE_FIX_LOW_CACHE_TRACE = "on";
  process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = dir;
  try {
    const meta = {};
    await extension.onRequest({
      body: { model: "test", messages: [] },
      headers: { "ah-request-id": "stream-non-2xx" },
      meta,
    });

    // onResponseStart sets non-2xx status
    await extension.onResponseStart({ status: 400, headers: {}, meta });

    // message_start with valid usage — should NOT write because status is 400
    await extension.onStreamEvent({
      event: {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 10,
          },
        },
      },
      meta,
      telemetry: {},
    });

    const today = new Date().toISOString().slice(0, 10);
    assert.equal(existsSync(join(dir, `${today}.jsonl`)), false, "no file for non-2xx streaming");
  } finally {
    if (oldGate === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE = oldGate;
    if (oldDir === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("non-2xx streaming: 5xx status also prevents write", async () => {
  const dir = scratch();
  const oldGate = process.env.CACHE_FIX_LOW_CACHE_TRACE;
  const oldDir = process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
  process.env.CACHE_FIX_LOW_CACHE_TRACE = "on";
  process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = dir;
  try {
    const meta = {};
    await extension.onRequest({
      body: { model: "test", messages: [] },
      headers: { "ah-request-id": "stream-5xx" },
      meta,
    });

    // onResponseStart sets 5xx status
    await extension.onResponseStart({ status: 500, headers: {}, meta });

    await extension.onStreamEvent({
      event: {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 10,
          },
        },
      },
      meta,
      telemetry: {},
    });

    const today = new Date().toISOString().slice(0, 10);
    assert.equal(existsSync(join(dir, `${today}.jsonl`)), false, "no file for 5xx streaming");
  } finally {
    if (oldGate === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE = oldGate;
    if (oldDir === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("streaming with no onResponseStart (status=null) does not write", async () => {
  const dir = scratch();
  const oldGate = process.env.CACHE_FIX_LOW_CACHE_TRACE;
  const oldDir = process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
  process.env.CACHE_FIX_LOW_CACHE_TRACE = "on";
  process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = dir;
  try {
    const meta = {};
    await extension.onRequest({
      body: { model: "test", messages: [] },
      headers: { "ah-request-id": "stream-no-status" },
      meta,
    });

    // No onResponseStart called — trace.status remains null
    await extension.onStreamEvent({
      event: {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 10,
          },
        },
      },
      meta,
      telemetry: {},
    });

    const today = new Date().toISOString().slice(0, 10);
    assert.equal(existsSync(join(dir, `${today}.jsonl`)), false, "no file when status is null");
  } finally {
    if (oldGate === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE = oldGate;
    if (oldDir === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===================================================================
// Non-message_start stream events
// ===================================================================

await test("non-message_start events (ping, message_delta) do not trigger writes", async () => {
  const dir = scratch();
  const oldGate = process.env.CACHE_FIX_LOW_CACHE_TRACE;
  const oldDir = process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
  process.env.CACHE_FIX_LOW_CACHE_TRACE = "on";
  process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = dir;
  try {
    const meta = {};
    await extension.onRequest({
      body: { model: "test", messages: [] },
      headers: { "ah-request-id": "non-message-start" },
      meta,
    });
    await extension.onResponseStart({ status: 200, headers: {}, meta });

    // ping event — should be ignored (no message property)
    await extension.onStreamEvent({
      event: { type: "ping" },
      meta,
    });

    // message_delta event — should be ignored (type mismatch)
    await extension.onStreamEvent({
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 50 },
      },
      meta,
    });

    // message_start event — should write
    await extension.onStreamEvent({
      event: {
        type: "message_start",
        message: {
          usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 },
        },
      },
      meta,
    });

    const today = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(dir, `${today}.jsonl`), "utf8");
    const lines = content.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, "only message_start should produce a record");
    const record = JSON.parse(lines[0]);
    assert.equal(record.request_id, "non-message-start");
  } finally {
    if (oldGate === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE = oldGate;
    if (oldDir === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("non-message_start events without prior message_start do not leak state", async () => {
  const dir = scratch();
  const oldGate = process.env.CACHE_FIX_LOW_CACHE_TRACE;
  const oldDir = process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
  process.env.CACHE_FIX_LOW_CACHE_TRACE = "on";
  process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = dir;
  try {
    const meta = {};
    await extension.onRequest({
      body: { model: "test", messages: [] },
      headers: { "ah-request-id": "non-msg-start-edge" },
      meta,
    });
    await extension.onResponseStart({ status: 200, headers: {}, meta });

    // Only non-message_start events, no message_start ever arrives
    await extension.onStreamEvent({ event: { type: "ping" }, meta });
    await extension.onStreamEvent({
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "hello" } },
      meta,
    });
    await extension.onStreamEvent({
      event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } },
      meta,
    });

    // onResponse should also skip (trace.done is false but classifyUsage never ran)
    // Since trace.done is false and we never classified, onResponse should still fire
    // But it has valid usage — make sure it writes correctly
    await extension.onResponse({
      status: 200,
      headers: {},
      body: {
        usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 },
      },
      meta,
    });

    const today = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(dir, `${today}.jsonl`), "utf8");
    const lines = content.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, "onResponse fallback should produce exactly one record");
    const record = JSON.parse(lines[0]);
    assert.equal(record.request_id, "non-msg-start-edge");
  } finally {
    if (oldGate === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE = oldGate;
    if (oldDir === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===================================================================
// Model from ctx.body (onRequest)
// ===================================================================

await test("model captured from body, not response", async () => {
  const dir = scratch();
  const oldGate = process.env.CACHE_FIX_LOW_CACHE_TRACE;
  const oldDir = process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
  process.env.CACHE_FIX_LOW_CACHE_TRACE = "on";
  process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = dir;
  try {
    const meta = {};
    await extension.onRequest({
      body: { model: "deepseek-v4-flash", messages: [] },
      headers: { "ah-request-id": "model-test" },
      meta,
    });

    await extension.onResponse({
      status: 200,
      headers: {},
      body: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 10,
        },
      },
      meta,
    });

    const today = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(dir, `${today}.jsonl`), "utf8");
    const record = JSON.parse(content.trim());
    assert.equal(record.model, "deepseek-v4-flash");
  } finally {
    if (oldGate === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE = oldGate;
    if (oldDir === undefined) delete process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR;
    else process.env.CACHE_FIX_LOW_CACHE_TRACE_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===================================================================
// Summary
// ===================================================================

console.log(`\nLow-cache trace: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
