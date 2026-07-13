// Unit tests for prefix-hold extension
// Run: node test-prefix-hold.mjs

import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extPath = join(__dirname, "extensions", "prefix-hold.mjs");
const mod = await import(pathToFileURL(extPath).href);
const ext = mod.default;

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${label}`); }
}

async function test(name, fn) {
  console.log(`\n[TEST] ${name}`);
  try { await fn(); }
  catch (e) { failed++; console.error(`  FAIL (exception in "${name}"): ${e.message}\n${e.stack}`); }
}

function mkCtx(sid, msgs) {
  return {
    headers: { "x-claude-code-session-id": sid },
    body: { model: "deepseek-v4-flash", messages: JSON.parse(JSON.stringify(msgs)) },
  };
}

await test("first request: stores last user msg", async () => {
  const ctx = mkCtx("s1", [
    { role: "user", content: [{ type: "text", text: "count 1-10" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: [{ type: "tool_result", content: "1" }] },
  ]);
  await ext.onRequest(ctx);
  // First request just stores, no modification
  assert(ctx.body.messages.length === 3, "msg count unchanged");
  assert(ctx.body.messages[2].content[0].content === "1", "last msg preserved");
});

await test("normal growth: no content change, store new last user", async () => {
  const ctx = mkCtx("s2", [
    { role: "user", content: [{ type: "text", text: "count 1-10" }] },
    { role: "assistant", content: [{ type: "tool_use", name: "echo", input: {} }] },
    { role: "user", content: [{ type: "tool_result", content: "1" }] },
  ]);
  await ext.onRequest(ctx);

  // Next request: grew by 2 messages
  const ctx2 = mkCtx("s2", [
    { role: "user", content: [{ type: "text", text: "count 1-10" }] },
    { role: "assistant", content: [{ type: "tool_use", name: "echo", input: {} }] },
    { role: "user", content: [{ type: "tool_result", content: "1" }] },
    { role: "assistant", content: [{ type: "tool_use", name: "echo", input: {} }] },
    { role: "user", content: [{ type: "tool_result", content: "2" }] },
  ]);
  await ext.onRequest(ctx2);
  assert(ctx2.body.messages.length === 5, "msg count unchanged (normal growth)");
  assert(ctx2.body.messages[2].content[0].content === "1", "old msg[2] preserved");
  assert(ctx2.body.messages[4].content[0].content === "2", "new msg[4] present");
});

await test("text consumed: restore previous text", async () => {
  const ctx = mkCtx("s3", [
    { role: "user", content: [{ type: "text", text: "再来2个" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: [{ type: "text", text: "再来2个" }] },
  ]);
  await ext.onRequest(ctx);

  // Next: Claude Code "consumed" the last user text, replaced with empty
  const ctx2 = mkCtx("s3", [
    { role: "user", content: [{ type: "text", text: "再来2个" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: [] },   // consumed!
    { role: "assistant", content: [{ type: "tool_use", name: "echo", input: {} }] },
    { role: "user", content: [{ type: "tool_result", content: "39" }] },
  ]);
  await ext.onRequest(ctx2);
  assert(ctx2.body.messages.length === 5, "msg count unchanged");
  assert(ctx2.body.messages[2].content.length > 0, "msg[2] content restored");
  assert(ctx2.body.messages[2].content[0].text === "再来2个", "msg[2] text restored");
  assert(ctx2.body.messages[4].content[0].content === "39", "new msg[4] still present");
});

await test("text consumed with multi-block content", async () => {
  const ctx = mkCtx("s4", [
    { role: "user", content: [
      { type: "text", text: "Context block 1" },
      { type: "text", text: "Real user input: count 10" }
    ]},
    { role: "assistant", content: [{ type: "tool_use", name: "echo", input: {} }] },
    { role: "user", content: [
      { type: "text", text: "Context block 1" },
      { type: "text", text: "Real user input: count 10" }
    ]},
  ]);
  await ext.onRequest(ctx);

  const ctx2 = mkCtx("s4", [
    { role: "user", content: [
      { type: "text", text: "Context block 1" },
      { type: "text", text: "Real user input: count 10" }
    ]},
    { role: "assistant", content: [{ type: "tool_use", name: "echo", input: {} }] },
    { role: "user", content: [] },  // consumed
    { role: "assistant", content: [{ type: "tool_use", name: "echo", input: {} }] },
    { role: "user", content: [{ type: "tool_result", content: "10" }] },
  ]);
  await ext.onRequest(ctx2);
  assert(ctx2.body.messages[2].content.length === 2, "msg[2] has 2 blocks restored");
  assert(ctx2.body.messages[2].content[0].text === "Context block 1", "block 0 restored");
  assert(ctx2.body.messages[2].content[1].text === "Real user input: count 10", "block 1 restored");
});

await test("system msg injection: does NOT interfere with restoration", async () => {
  // This mimics the real 1669->1670 pattern exactly
  const ctx = mkCtx("s5", [
    { role: "user", content: [{ type: "text", text: "prompt" }] },
    { role: "assistant", content: [{ type: "text", text: "thinking..." }] },
    { role: "user", content: [{ type: "text", text: "再来2个" }] },
  ]);
  await ext.onRequest(ctx);

  const ctx2 = mkCtx("s5", [
    { role: "user", content: [{ type: "text", text: "prompt" }] },
    { role: "assistant", content: [{ type: "text", text: "thinking..." }] },
    { role: "user", content: [] },   // text consumed
    { role: "assistant", content: [{ type: "tool_use", name: "echo", input: {} }] },
    { role: "user", content: [{ type: "tool_result", content: "39" }] },
    { role: "system", content: [] }, // system msg injection
  ]);
  await ext.onRequest(ctx2);
  assert(ctx2.body.messages[2].content[0].text === "再来2个", "restored despite system msg");
  assert(ctx2.body.messages.length === 6, "all msgs preserved");
  assert(ctx2.body.messages[5].role === "system", "system msg still present");
});

await test("no session id: passes through unchanged", async () => {
  const ctx = {
    body: {
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] }
      ]
    }
  };
  await ext.onRequest(ctx);
  assert(ctx.body.messages[0].content[0].text === "hello", "preserved without session");
});

await test("non-DeepSeek model: still holds (model-agnostic)", async () => {
  const ctx = mkCtx("s6", [
    { role: "user", content: [{ type: "text", text: "initial prompt" }] },
    { role: "assistant", content: [{ type: "text", text: "thinking..." }] },
    { role: "user", content: [{ type: "text", text: "repeat" }] },
  ]);
  await ext.onRequest(ctx);

  // Next: msg[2] text consumed, new msgs added. Should restore msg[2].
  const ctx2 = mkCtx("s6", [
    { role: "user", content: [{ type: "text", text: "initial prompt" }] },
    { role: "assistant", content: [{ type: "text", text: "thinking..." }] },
    { role: "user", content: [] },  // text at msg[2] consumed!
    { role: "assistant", content: [{ type: "tool_use", name: "run", input: {} }] },
    { role: "user", content: [{ type: "tool_result", content: "ok" }] },
  ]);
  ctx2.body.model = "claude-sonnet-4-20250514";
  await ext.onRequest(ctx2);
  // Should restore for non-deepseek too — this is content stability, not model-specific
  assert(ctx2.body.messages[2].content.length > 0, "msg[2] restored for non-deepseek");
  assert(ctx2.body.messages[2].content[0].text === "repeat", "text restored");
  assert(ctx2.body.messages.length === 5, "all msgs present");
});

await test("field order change: restore to prev content", async () => {
  const ctx = mkCtx("s7", [
    { role: "user", content: [{ type: "text", text: "start" }] },
    { role: "assistant", content: [{ type: "tool_use", name: "e", input: {}, id: "x" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "42" }] },
  ]);
  await ext.onRequest(ctx);

  // Next request: same msg[2] but with different JSON field order
  const ctx2 = mkCtx("s7", [
    { role: "user", content: [{ type: "text", text: "start" }] },
    { role: "assistant", content: [{ type: "tool_use", name: "e", input: {}, id: "x" }] },
    { role: "user", content: [{ content: "42", type: "tool_result", tool_use_id: "x" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: [{ type: "text", text: "next" }] },
  ]);
  await ext.onRequest(ctx2);
  // msg[2] should be restored to original field order
  const keys = Object.keys(ctx2.body.messages[2].content[0]);
  assert(keys[0] === "type", "first key should be 'type' (restored from prev)");
  assert(ctx2.body.messages[2].content[0].content === "42", "content preserved");
});

console.log(`\n${"=".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
