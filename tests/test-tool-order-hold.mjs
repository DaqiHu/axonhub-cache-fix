// Unit tests for tool-order-hold extension
// Run: node tests/test-tool-order-hold.mjs

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extPath = join(__dirname, "..", "extensions", "tool-order-hold.mjs");
const ext = (await import(pathToFileURL(extPath).href)).default;

let passed = 0;
let failed = 0;

function tool(name, marker = name) {
  return {
    name,
    description: `${marker} description`,
    input_schema: { type: "object", properties: { marker: { const: marker } } },
  };
}

function names(tools) {
  return tools.map((entry) => entry.name);
}

async function run(sid, agent, toolNames, options = {}) {
  const headers = {};
  if (sid !== undefined) headers["x-claude-code-session-id"] = sid;
  if (agent !== undefined) headers["x-claude-code-agent-id"] = agent;

  const tools = options.tools ?? toolNames.map((name) => tool(name));
  const ctx = {
    headers,
    body: {
      model: options.model ?? "deepseek-v4-flash",
      tools,
    },
  };
  if (options.meta) ctx.meta = options.meta;

  await ext.onRequest(ctx);
  return ctx.body.tools;
}

async function test(name, fn) {
  process.stdout.write(`[TEST] ${name} ... `);
  try {
    await fn();
    passed++;
    console.log("PASS");
  } catch (error) {
    failed++;
    console.error(`FAIL\n${error.stack}`);
  }
}

const base = ["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "Skill", "ToolSearch", "Write"];

await test("newly visible SendMessage is appended to the prior order", async () => {
  const withSend = ["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "SendMessage", "Skill", "ToolSearch", "Write"];

  await run("send-session", "agent-a", base);
  const result = await run("send-session", "agent-a", withSend);

  assert.deepEqual(names(result), [...base, "SendMessage"]);
});

await test("newly visible web tools are appended in their current relative order", async () => {
  const withWeb = ["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "Skill", "ToolSearch", "WebFetch", "WebSearch", "Write"];

  await run("web-tools-session", "agent-a", base);
  const result = await run("web-tools-session", "agent-a", withWeb);

  assert.deepEqual(names(result), [...base, "WebFetch", "WebSearch"]);
});

await test("newly visible worktree tools are appended in their current relative order", async () => {
  const withWorktree = ["Agent", "Bash", "Edit", "EnterWorktree", "ExitWorktree", "Glob", "Grep", "Read", "Skill", "ToolSearch", "Write"];

  await run("worktree-session", "agent-a", base);
  const result = await run("worktree-session", "agent-a", withWorktree);

  assert.deepEqual(names(result), [...base, "EnterWorktree", "ExitWorktree"]);
});

await test("removed tools disappear and reappearing tools append", async () => {
  await run("reappear-session", "agent-a", ["Agent", "Bash", "Read"]);
  const removed = await run("reappear-session", "agent-a", ["Agent", "Read"]);
  const reappeared = await run("reappear-session", "agent-a", ["Agent", "Bash", "Read"]);

  assert.deepEqual(names(removed), ["Agent", "Read"]);
  assert.deepEqual(names(reappeared), ["Agent", "Read", "Bash"]);
});

await test("reordering preserves the exact current tool definition objects", async () => {
  await run("identity-session", "agent-a", ["Agent", "Read"]);
  const read = tool("Read", "current-read");
  const agent = tool("Agent", "current-agent");
  const edit = tool("Edit", "current-edit");
  const current = [edit, read, agent];

  const result = await run("identity-session", "agent-a", [], { tools: current });

  assert.deepEqual(names(result), ["Agent", "Read", "Edit"]);
  assert.strictEqual(result[0], agent);
  assert.strictEqual(result[1], read);
  assert.strictEqual(result[2], edit);
  assert.deepEqual(new Set(result), new Set(current));
});

await test("agent IDs isolate order state within one session", async () => {
  await run("agent-isolation", "agent-a", ["Bash", "Read"]);
  await run("agent-isolation", "agent-b", ["Edit", "Read"]);

  const resultA = await run("agent-isolation", "agent-a", ["Bash", "Edit", "Read"]);
  const resultB = await run("agent-isolation", "agent-b", ["Bash", "Edit", "Read"]);

  assert.deepEqual(names(resultA), ["Bash", "Read", "Edit"]);
  assert.deepEqual(names(resultB), ["Edit", "Read", "Bash"]);
});

await test("models isolate order state for one session and agent", async () => {
  await run("model-isolation", "agent-a", ["Bash", "Read"], { model: "model-a" });
  await run("model-isolation", "agent-a", ["Edit", "Read"], { model: "model-b" });

  const resultA = await run("model-isolation", "agent-a", ["Bash", "Edit", "Read"], { model: "model-a" });
  const resultB = await run("model-isolation", "agent-a", ["Bash", "Edit", "Read"], { model: "model-b" });

  assert.deepEqual(names(resultA), ["Bash", "Read", "Edit"]);
  assert.deepEqual(names(resultB), ["Edit", "Read", "Bash"]);
});

await test("web-search requests do not replace conversation order state", async () => {
  await run("family-isolation", "agent-a", ["Bash", "Read"]);
  const webOnly = await run("family-isolation", "agent-a", ["web_search"]);
  const conversation = await run("family-isolation", "agent-a", ["Bash", "Edit", "Read"]);

  assert.deepEqual(names(webOnly), ["web_search"]);
  assert.deepEqual(names(conversation), ["Bash", "Read", "Edit"]);
});

await test("meta IDs are accepted and the main agent is the default", async () => {
  await run(undefined, undefined, ["Bash", "Read"], {
    meta: { _sessionId: "meta-session" },
  });
  const result = await run(undefined, undefined, ["Bash", "Edit", "Read"], {
    meta: { _sessionId: "meta-session", _agentId: "main" },
  });

  assert.deepEqual(names(result), ["Bash", "Read", "Edit"]);
});

await test("missing session ID leaves tool order unchanged", async () => {
  const result = await run(undefined, "agent-a", ["Read", "Agent", "Bash"]);

  assert.deepEqual(names(result), ["Read", "Agent", "Bash"]);
});

await test("missing or empty names leave definitions unchanged and do not corrupt state", async () => {
  await run("invalid-name-session", "agent-a", ["Bash", "Read"]);
  const invalid = [tool("Read"), { description: "missing name" }, tool("")];
  const skipped = await run("invalid-name-session", "agent-a", [], { tools: invalid });
  const valid = await run("invalid-name-session", "agent-a", ["Bash", "Edit", "Read"]);

  assert.strictEqual(skipped, invalid);
  assert.deepEqual(names(skipped), ["Read", undefined, ""]);
  assert.deepEqual(names(valid), ["Bash", "Read", "Edit"]);
});

await test("duplicate names leave definitions unchanged and do not corrupt state", async () => {
  await run("duplicate-session", "agent-a", ["Agent", "Read"]);
  const duplicate = [tool("Read", "first"), tool("Read", "second"), tool("Agent")];
  const skipped = await run("duplicate-session", "agent-a", [], { tools: duplicate });
  const valid = await run("duplicate-session", "agent-a", ["Agent", "Edit", "Read"]);

  assert.strictEqual(skipped, duplicate);
  assert.deepEqual(names(skipped), ["Read", "Read", "Agent"]);
  assert.deepEqual(names(valid), ["Agent", "Read", "Edit"]);
});

console.log(`\n${"=".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
