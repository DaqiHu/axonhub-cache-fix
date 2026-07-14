# Dynamic Tool-Order Cache Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the relative order of already-present Claude Code tools when new tools become available, and classify recent cache records by their actual request pattern.

**Architecture:** Add a custom order-210 request extension after the built-in alphabetical sorter. It stores only tool-name order, partitioned by session, agent, model, and request family; current tool objects remain authoritative. Extend the SQLite report with an optional metadata-aware diagnostic path while retaining the legacy basic query.

**Tech Stack:** Node.js ES modules, PowerShell runtime scripts, Python 3 SQLite, AxonHub request traces, Claude Code CLI.

## Global Constraints

- Never add, remove, rename, or modify a tool definition.
- Keep standalone `web_search` state separate from conversation state.
- Scope state by session ID, agent ID, model, and request family.
- Fail open for missing session IDs, invalid names, or duplicate names.
- Do not change AxonHub channel routing, weights, credentials, or model mappings.
- Preserve current and legacy AxonHub cache-token column support.
- Use `deepseek-v4-flash` for live verification.

---

### Task 1: Tool-Order Extension

**Files:**
- Create: `extensions/tool-order-hold.mjs`
- Create: `tests/test-tool-order-hold.mjs`
- Modify: `tests/run-all.mjs`

**Interfaces:**
- Consumes: cache-fix `ctx` with `ctx.headers`, `ctx.body.model`, and `ctx.body.tools`.
- Produces: default extension `{ name: "tool-order-hold", order: 210, onRequest(ctx) }`.

- [ ] **Step 1: Write the failing extension tests**

Create a test harness that imports the production module and exercises these
orders:

```js
const base = ["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "Skill", "ToolSearch", "Write"];
const withSend = ["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "SendMessage", "Skill", "ToolSearch", "Write"];

await run("sid", "agent-a", base);
const result = await run("sid", "agent-a", withSend);
assert.deepEqual(names(result), [...base, "SendMessage"]);
```

Add equivalent cases for `WebFetch`/`WebSearch`,
`EnterWorktree`/`ExitWorktree`, removal and reappearance, schema-object identity,
agent/model/family isolation, missing session ID, missing names, and duplicate
names.

- [ ] **Step 2: Run the isolated test and verify RED**

Run:

```powershell
node tests/test-tool-order-hold.mjs
```

Expected: module import failure because
`extensions/tool-order-hold.mjs` does not exist.

- [ ] **Step 3: Implement the minimal extension**

Implement these focused helpers:

```js
function requestFamily(tools) {
  return tools.length === 1 && tools[0]?.name === "web_search"
    ? "web-search"
    : "conversation";
}

function stateKey(ctx, tools) {
  const sid = ctx?.headers?.["x-claude-code-session-id"] || ctx?.meta?._sessionId;
  if (!sid) return null;
  const agent = ctx?.headers?.["x-claude-code-agent-id"] || ctx?.meta?._agentId || "main";
  const model = typeof ctx?.body?.model === "string" ? ctx.body.model : "unknown";
  return `${sid}:${agent}:${model}:${requestFamily(tools)}`;
}

function stableToolOrder(tools, previousNames) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const known = previousNames.filter((name) => byName.has(name));
  const added = tools.map((tool) => tool.name).filter((name) => !previousNames.includes(name));
  return [...known, ...added].map((name) => byName.get(name));
}
```

Validate unique non-empty names before calling `stableToolOrder`. Store the
resulting name list per key and log baseline, reorder, and skip events.

- [ ] **Step 4: Run isolated tests and verify GREEN**

Run:

```powershell
node tests/test-tool-order-hold.mjs
```

Expected: all tool-order tests pass with zero failures.

- [ ] **Step 5: Add the suite to the aggregate runner**

Insert:

```js
["node", "test-tool-order-hold.mjs"],
```

after `test-prefix-hold.mjs` in `tests/run-all.mjs`.

### Task 2: Runtime Registration And Validation

**Files:**
- Modify: `extensions/extensions.json`
- Modify: `scripts/validate-runtime.mjs`
- Modify: `tests/test-runtime-validation.mjs`

**Interfaces:**
- Consumes: `tool-order-hold` extension from Task 1.
- Produces: runtime setup that fails closed if the extension is missing or disabled.

- [ ] **Step 1: Write failing runtime expectations**

Add `tool-order-hold` to test fixtures that enumerate required extensions and
assert that disabling or removing it causes validation failure.

- [ ] **Step 2: Run runtime tests and verify RED**

Run:

```powershell
node tests/test-runtime-validation.mjs
```

Expected: failure indicating `tool-order-hold` is not registered or required.

- [ ] **Step 3: Register and require the extension**

Add:

```json
"tool-order-hold": { "enabled": true, "order": 210 }
```

to `extensions/extensions.json`, and add `"tool-order-hold"` to
`REQUIRED_EXTENSIONS` in `scripts/validate-runtime.mjs`.

- [ ] **Step 4: Verify runtime tests GREEN**

Run:

```powershell
node tests/test-runtime-validation.mjs
```

Expected: all runtime validation tests pass.

### Task 3: Metadata-Aware Cache Report

**Files:**
- Modify: `scripts/cache_report.py`
- Modify: `tests/test-cache-report.py`

**Interfaces:**
- Consumes: SQLite `usage_logs` and, when available, `requests` metadata.
- Produces: `classify_rows(rows)` categories and token-weighted summary output.

- [ ] **Step 1: Add failing report-classification tests**

Create an in-memory current schema containing `usage_logs` and `requests`.
Insert rows for:

```python
expected = {
    "standalone-web-search": 1,
    "cold-first": 1,
    "tools-changed": 1,
    "clean-growth": 1,
    "high-hit": 1,
}
```

Assert the weighted percentage uses `sum(cached_tokens) / sum(prompt_tokens)`
rather than the mean of row percentages. Retain the three existing schema
tests unchanged.

- [ ] **Step 2: Run report tests and verify RED**

Run:

```powershell
python tests/test-cache-report.py
```

Expected: failure because metadata-aware query and classification functions do
not exist.

- [ ] **Step 3: Implement optional metadata querying**

Add table/column detection and return dictionaries containing usage data,
request headers, and request body when available. If `requests` is absent,
return the existing five-column row shape through the basic path.

Implement classification using prior state keyed by session, agent, channel,
model, and request family. Use these rules in order:

```python
if pct >= 90:
    category = "high-hit"
elif family == "web-search":
    category = "standalone-web-search"
elif prior is None:
    category = "cold-first"
elif system_changed:
    category = "system-changed"
elif tools_changed:
    category = "tools-changed"
elif overlapping_history_changed:
    category = "history-changed"
else:
    category = "clean-growth"
```

Replace the unsupported `SYSTEM INJECTION` label with the computed category.

- [ ] **Step 4: Run report tests and verify GREEN**

Run:

```powershell
python tests/test-cache-report.py
```

Expected: current schema, legacy schema, unsupported schema, classification,
and weighted-summary tests all pass.

### Task 4: Documentation, Deployment, And Live Measurement

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `.agents/skills/extension-dev/SKILL.md`
- Modify: `.agents/skills/cache-hit-debug/SKILL.md`
- Modify: `.agents/skills/cache-hit-check/SKILL.md`

**Interfaces:**
- Consumes: completed extension and report behavior.
- Produces: operator guidance and measured before/after evidence.

- [ ] **Step 1: Document the new safety rule and diagnostic categories**

Document order 210, append-only ordering for newly visible tools, no tool
injection, request-family isolation, and the difference between standalone web
search, cold first, clean growth, and real prefix changes.

- [ ] **Step 2: Run the complete automated suite**

Run:

```powershell
node tests/run-all.mjs
git diff --check
```

Expected: every suite exits zero and Git reports no whitespace errors.

- [ ] **Step 3: Install and restart only the proxy**

Run:

```powershell
.\scripts\setup.ps1 -Dir "$HOME\axonhub"
```

Stop only the Node process listening on port 9801, run
`.\scripts\start.ps1`, then run `.\scripts\start.ps1 -Status`.

Expected: runtime valid, 30 extensions loaded, zero failures, `/health` OK.

- [ ] **Step 4: Capture a pre-run database watermark**

Query `MAX(id)` from `usage_logs` and `MAX(id)` from `requests`. Store both in
the terminal output for each workload.

- [ ] **Step 5: Run a short stable-tool workload**

Run Claude Code with `deepseek-v4-flash` and a short prompt requiring three
strictly sequential Bash calls:

```text
严格串行调用 Bash 三次，一次只能调用一个。依次执行 echo 1、echo 2、echo 3；每次等结果后再调用下一次。最后只回复 done。
```

Run:

```powershell
claude -p --model deepseek-v4-flash --dangerously-skip-permissions --output-format json `
  "严格串行调用 Bash 三次，一次只能调用一个。依次执行 echo 1、echo 2、echo 3；每次等结果后再调用下一次。最后只回复 done。"
```

Verify the resulting AxonHub rows use `deepseek-v4-flash`.

- [ ] **Step 6: Run a dynamic-tool workload**

Run this prompt twice, once with `tool-order-hold` disabled and once enabled.
Use equal-length unique `--append-system-prompt` benchmark markers so the two
runs have independent cache prefixes:

```powershell
claude -p --model deepseek-v4-flash --dangerously-skip-permissions --output-format json `
  --append-system-prompt "tool-order-bench-before-0000000000000001" `
  "严格串行执行：先调用 Bash 执行 echo warmup；拿到结果后调用 ToolSearch 搜索并加载 WebFetch；然后调用 WebFetch 获取 https://example.com 并只读取标题；最后只回复 done。禁止并行。"
```

The enabled run uses marker
`tool-order-bench-after--0000000000000001`, which has the same byte length.
Verify the actual forwarded request tools changed; do not infer success only
from CLI text.

- [ ] **Step 7: Compare new rows and calculate consumption**

For rows after each watermark, print:

```text
request_id, prompt_tokens, cached_tokens, uncached_tokens, hit_pct,
tool_names, tool_added
```

Calculate totals with:

```text
uncached_tokens = prompt_tokens - cached_tokens
savings = before_uncached_tokens - after_uncached_tokens
savings_pct = savings / before_uncached_tokens * 100
```

Compare the live dynamic transition when reproducible. Also replay captured
request shapes `2765/2767`, `2771/2775`, and `2813/2814` through the extension
to prove prior relative order is preserved deterministically.

- [ ] **Step 8: Final verification**

Query post-deployment request bodies for duplicate/missing tools and
assistant/tool-result pairing errors. Report limitations explicitly if the
provider does not reproduce a comparable live transition.
