// Unit tests for deepseek-cache-optimize extension
// Run: node test-deepseek-cache.mjs

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Import the extension module
const __dirname = dirname(fileURLToPath(import.meta.url));
const extPath = join(__dirname, "..", "extensions", "deepseek-cache-optimize.mjs");
const extUrl = pathToFileURL(extPath).href;
const ext = (await import(extUrl)).default;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

async function test(name, fn) {
  console.log(`\n[TEST] ${name}`);
  try {
    await fn();
  } catch (e) {
    failed++;
    console.error(`  FAIL (exception): ${e.message}`);
  }
}

// Test 1: Strips cache_control from system blocks
await test("strips cache_control from system blocks", async () => {
  const ctx = {
    body: {
      model: "deepseek-v4-flash",
      system: [
        { type: "text", text: "You are Claude.", cache_control: { type: "ephemeral" } },
        { type: "text", text: "Be helpful.", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "No cc here." }
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    }
  };
  await ext.onRequest(ctx);
  assert(ctx.body.system[0].cache_control === undefined, "system[0] cache_control removed");
  assert(ctx.body.system[1].cache_control === undefined, "system[1] cache_control removed");
  assert(ctx.body.system[2].cache_control === undefined, "system[2] had no cc, still no cc");
  assert(ctx.body.system[0].text === "You are Claude.", "system[0] text preserved");
  assert(ctx.body.system[1].text === "Be helpful.", "system[1] text preserved");
  assert(ctx.body.system[2].text === "No cc here.", "system[2] text preserved");
});

// Test 2: Strips cache_control from message content
await test("strips cache_control from message content blocks", async () => {
  const ctx = {
    body: {
      model: "deepseek-v4-pro",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "tool_result", tool_use_id: "x", content: "ok", cache_control: { type: "ephemeral" } }
          ]
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "...", signature: "x" },
            { type: "tool_use", id: "y", name: "echo", input: {}, cache_control: { type: "ephemeral" } }
          ]
        }
      ]
    }
  };
  await ext.onRequest(ctx);
  assert(ctx.body.messages[0].content[0].cache_control === undefined, "msg[0].c[0] no cc originally");
  assert(ctx.body.messages[0].content[1].cache_control === undefined, "msg[0].c[1] cc removed (tool_result)");
  assert(ctx.body.messages[1].content[0].cache_control === undefined, "msg[1].c[0] no cc originally");
  assert(ctx.body.messages[1].content[1].cache_control === undefined, "msg[1].c[1] cc removed (tool_use)");
  assert(ctx.body.messages[0].content[1].content === "ok", "tool_result content preserved");
  assert(ctx.body.messages[1].content[1].name === "echo", "tool_use name preserved");
});

// Test 3: Strips cache_control from tools
await test("strips cache_control from tools array", async () => {
  const ctx = {
    body: {
      model: "deepseek-chat",
      tools: [
        { name: "echo", input_schema: { type: "object" } },
        { name: "read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
        { name: "bash", input_schema: { type: "object" }, cache_control: { type: "ephemeral", ttl: "1h" } }
      ]
    }
  };
  await ext.onRequest(ctx);
  assert(ctx.body.tools[0].cache_control === undefined, "tools[0] no cc, still no cc");
  assert(ctx.body.tools[1].cache_control === undefined, "tools[1] cc removed");
  assert(ctx.body.tools[2].cache_control === undefined, "tools[2] cc removed");
  assert(ctx.body.tools[0].name === "echo", "tools[0] name preserved");
  assert(ctx.body.tools[1].name === "read", "tools[1] name preserved");
});

// Test 4: Does NOT strip from non-DeepSeek models
await test("does NOT touch non-DeepSeek models", async () => {
  const ctx = {
    body: {
      model: "claude-sonnet-4-20250514",
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }]
    }
  };
  await ext.onRequest(ctx);
  assert(ctx.body.system[0].cache_control.type === "ephemeral", "system cc preserved for non-deepseek");
  assert(ctx.body.messages[0].content[0].cache_control.type === "ephemeral", "message cc preserved for non-deepseek");
});

// Test 5: Handles edge cases
await test("handles missing/edge case fields", async () => {
  // No model field
  let ctx = { body: { system: [{ type: "text", text: "x", cache_control: {} }] } };
  await ext.onRequest(ctx);
  assert(ctx.body.system[0].cache_control !== undefined, "no model: cc preserved");

  // Null body
  ctx = { body: null };
  await ext.onRequest(ctx);  // should not throw
  assert(true, "null body handled");

  // Empty strings and arrays
  ctx = { body: { model: "deepseek-v4-flash", system: [], messages: [], tools: [] } };
  await ext.onRequest(ctx);  // should not throw
  assert(true, "empty arrays handled");

  // Deep nested
  ctx = {
    body: {
      model: "deepseek-v4-flash",
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "hello",
          cache_control: { type: "ephemeral", metadata: { nested: { cache_control: { fake: true } } } }
        }]
      }]
    }
  };
  await ext.onRequest(ctx);
  // Only the top-level cache_control should be stripped; deep nested keys named
  // "cache_control" inside random metadata are NOT stripped (by design — we only
  // strip the API-level cache_control fields, not arbitrary nested data).
  assert(ctx.body.messages[0].content[0].cache_control === undefined, "top-level cc removed");
  assert(ctx.body.messages[0].content[0].text === "hello", "text preserved");
});

// Test 6: Real-world Claude Code body simulation
await test("simulated Claude Code body with all cc positions", async () => {
  const ctx = {
    body: {
      model: "deepseek-v4-flash",
      max_tokens: 32000,
      system: [
        { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "You are an interactive agent.", cache_control: { type: "ephemeral", ttl: "1h" } }
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "<system-reminder>\n..." }] },
        { role: "system", content: [{ type: "text", text: "hooks output" }] },
        { role: "assistant", content: [
          { type: "thinking", thinking: "..." },
          { type: "tool_use", id: "t1", name: "echo", input: {} }
        ]},
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "t1", content: "31", cache_control: { type: "ephemeral", ttl: "1h" } }
        ]}
      ],
      tools: [
        { name: "Bash", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }
      ]
    }
  };
  await ext.onRequest(ctx);

  // System
  assert(ctx.body.system[0].cache_control === undefined, "system[0] cc stripped");
  assert(ctx.body.system[1].cache_control === undefined, "system[1] cc stripped");
  assert(ctx.body.system[0].text.startsWith("You are Claude"), "system text ok");

  // Messages — no cc should remain anywhere
  let remaining = 0;
  for (const m of ctx.body.messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.cache_control !== undefined) remaining++;
      }
    }
  }
  assert(remaining === 0, `all message cc stripped (found ${remaining} remaining)`);

  // Tools
  assert(ctx.body.tools[0].cache_control === undefined, "tools[0] cc stripped");
  assert(ctx.body.tools[0].name === "Bash", "tool name preserved");

  // Verify model field unchanged
  assert(ctx.body.model === "deepseek-v4-flash", "model untouched");
  assert(ctx.body.max_tokens === 32000, "max_tokens untouched");
});

console.log(`\n${"=".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
