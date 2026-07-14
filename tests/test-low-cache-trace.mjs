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

    // Verify every line is valid JSON with expected fields
    for (let i = 0; i < lines.length; i++) {
      const parsed = JSON.parse(lines[i]);
      assert.equal(parsed.schema_version, 1, `line ${i} has schema_version`);
      assert.ok(typeof parsed.hit_pct === "number", `line ${i} has hit_pct`);
      assert.ok(parsed.body, `line ${i} has body`);
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

await test("fail-open: gate off does not fail", () => {
  // When gate is not "on", hooks should return early without throwing
  // (CACHE_FIX_LOW_CACHE_TRACE is not set)
  const meta = {};
  return extension.onRequest({
    body: { model: "test", messages: [] },
    headers: {},
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
