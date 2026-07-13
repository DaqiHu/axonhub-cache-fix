// Unit tests for strip-empty-system extension
// Run: node test-strip-system.mjs

import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extPath = join(__dirname, "extensions", "strip-trailing-empty-system.mjs");
const ext = (await import(pathToFileURL(extPath).href)).default;

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${label}`); }
}

async function test(name, fn) {
  console.log(`\n[TEST] ${name}`);
  try { await fn(); }
  catch (e) { failed++; console.error(`  FAIL (exception): ${e.message}`); }
}

// === Empty system (array format) ===

await test("removes empty array system anywhere", async () => {
  const ctx = { body: { model: "x", messages: [
    { role: "user", content: [{ type: "tool_result", content: "5" }] },
    { role: "system", content: [] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ]}};
  await ext.onRequest(ctx);
  assert(ctx.body.messages.length === 2, "3->2");
});

await test("removes trailing empty array system", async () => {
  const ctx = { body: { model: "x", messages: [
    { role: "user", content: [{ type: "tool_result", content: "5" }] },
    { role: "system", content: [] },
  ]}};
  await ext.onRequest(ctx);
  assert(ctx.body.messages.length === 1, "2->1");
});

// === Contentful system (array format) trailing ===

await test("removes contentful trailing array system", async () => {
  const ctx = { body: { model: "x", messages: [
    { role: "user", content: [{ type: "tool_result", content: "5" }] },
    { role: "system", content: [{ type: "text", text: "task tools reminder..." }] },
  ]}};
  await ext.onRequest(ctx);
  assert(ctx.body.messages.length === 1, "removed trailing contentful");
});

// === String format content ===

await test("string-format contentful trailing: removed", async () => {
  const ctx = { body: { model: "x", messages: [
    { role: "user", content: [{ type: "tool_result", content: "5" }] },
    { role: "system", content: "The task tools haven't been used recently." },
  ]}};
  await ext.onRequest(ctx);
  assert(ctx.body.messages.length === 1, "string-format removed");
});

await test("empty string system: removed", async () => {
  const ctx = { body: { model: "x", messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "system", content: "   " },
  ]}};
  await ext.onRequest(ctx);
  assert(ctx.body.messages.length === 1, "whitespace-only removed");
});

await test("contentful string before last user: kept", async () => {
  const ctx = { body: { model: "x", messages: [
    { role: "system", content: "important setup context" },
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ]}};
  await ext.onRequest(ctx);
  assert(ctx.body.messages.length === 2, "kept before user");
  assert(ctx.body.messages[0].content === "important setup context", "untouched");
});

// === 1766/1772 pattern: empty system in middle of new block ===

await test("1766 pattern: empty system embedded in new content", async () => {
  const ctx = { body: { model: "deepseek-v4-flash", messages: [
    { role: "user", content: [{ type: "text", text: "count" }] },
    { role: "assistant", content: [{ type: "tool_use", name: "echo", input: {} }] },
    { role: "user", content: [{ type: "tool_result", content: "3" }] },
    { role: "system", content: [] },
    { role: "assistant", content: [{ type: "tool_use", name: "echo", input: {} }] },
    { role: "user", content: [{ type: "tool_result", content: "4" }] },
  ]}};
  await ext.onRequest(ctx);
  assert(ctx.body.messages.length === 5, "6->5");
  assert(ctx.body.messages[4].role === "user", "last is user");
});

// === No user messages ===

await test("no user messages: skip", async () => {
  const ctx = { body: { model: "x", messages: [
    { role: "system", content: [{ type: "text", text: "setup" }] },
  ]}};
  await ext.onRequest(ctx);
  assert(ctx.body.messages.length === 1, "unchanged");
});

// === Real scenarios ===

await test("1753 real: string content trailing", async () => {
  const ctx = { body: { model: "deepseek-v4-flash", messages: [
    { role: "user", content: [{ type: "tool_result", content: "5" }] },
    { role: "system", content: "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate." },
  ]}};
  await ext.onRequest(ctx);
  assert(ctx.body.messages.length === 1, "1753 pattern: removed");
});

await test("multiple mixed: empty + contentful trailing + mid-body empty", async () => {
  const ctx = { body: { model: "x", messages: [
    { role: "user", content: [{ type: "tool_result", content: "5" }] },
    { role: "system", content: [] },
    { role: "system", content: "task tools..." },
    { role: "system", content: [] },
    { role: "user", content: [{ type: "tool_result", content: "6" }] },
    { role: "system", content: [] },
  ]}};
  await ext.onRequest(ctx);
  // Should remove: empty [] msgs + trailing contentful "task tools..."
  // The contentful system "task tools..." is BETWEEN users — kept.
  assert(ctx.body.messages.length === 3, "6->3");
  assert(ctx.body.messages[0].content[0].content === "5", "first user preserved");
  assert(ctx.body.messages[1].role === "system", "mid-contentful system kept");
  assert(ctx.body.messages[2].content[0].content === "6", "last user preserved");
});

console.log(`\n${"=".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
