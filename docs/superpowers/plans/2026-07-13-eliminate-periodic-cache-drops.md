# Eliminate Periodic Cache Drops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the standard six-tool Claude Code session hit DeepSeek cache at 99% or better after the cold request while preserving meaningful system context.

**Architecture:** Build one validated runtime under `~/axonhub`, load the real cache-fix extension graph before startup, and narrowly remove only the two approved trailing bookkeeping reminders. Tests import production modules and exercise generated runtime layout; the final gate is a real Claude Code -> proxy -> AxonHub -> DeepSeek run.

**Tech Stack:** Node.js 24 ESM, PowerShell 7, Python 3 SQLite, cache-fix 4.2.1, AxonHub SQLite traces.

## Global Constraints

- Keep custom extension orders 46, 47, 48, and 85 unchanged.
- Preserve SessionStart hook output and unknown contentful system messages.
- Remove only empty system messages and the two approved exact reminder prefixes.
- Do not patch the globally installed cache-fix package.
- Runtime validation must fail on an empty registry, any load failure, or a missing required custom extension.
- E2E acceptance is one optional cold miss followed by only 99%+ hits.

---

### Task 1: Production Extension Tests And Targeted Filtering

**Files:**
- Modify: `tests/test-strip-system.mjs`
- Modify: `tests/test-deepseek-cache.mjs`
- Modify: `tests/test-prefix-hold.mjs`
- Modify: `extensions/strip-trailing-empty-system.mjs`
- Modify: `extensions/deepseek-cache-optimize.mjs`
- Modify: `extensions/prefix-hold.mjs`
- Modify: `extensions/strip-billing-header.mjs`

**Interfaces:**
- Consumes: cache-fix `onRequest(ctx)` extension contract.
- Produces: `strip-empty-system.onRequest(ctx)` that removes only approved noise.

- [ ] **Step 1: Point tests at production modules and add preservation cases**

Use `join(__dirname, "..", "extensions", file)` in all three test files. Add cases to `test-strip-system.mjs` with real extension calls:

```js
await test("preserves SessionStart hook context after user", async () => {
  const ctx = { body: { messages: [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "system", content: "SessionStart hook additional context: keep me" },
  ] } };
  await ext.onRequest(ctx);
  assert(ctx.body.messages.length === 2, "SessionStart preserved");
});

await test("removes deferred-tools reminder after user", async () => {
  const ctx = { body: { messages: [
    { role: "user", content: [{ type: "tool_result", content: "2" }] },
    { role: "system", content: "The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded." },
  ] } };
  await ext.onRequest(ctx);
  assert(ctx.body.messages.length === 1, "deferred-tools reminder removed");
});
```

Also cover task-tools reminder, `<system-reminder>` wrappers, array text blocks, arbitrary trailing content, content before last user, and empty system messages.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
node tests/test-strip-system.mjs
node tests/test-prefix-hold.mjs
node tests/test-deepseek-cache.mjs
```

Expected: imports fail with `homedir is not defined`; after import-only corrections, the SessionStart preservation assertion fails because current code deletes all trailing contentful system messages.

- [ ] **Step 3: Add missing imports and implement exact matching**

Each custom extension imports:

```js
import { homedir } from "node:os";
```

In `strip-trailing-empty-system.mjs`, normalize string or text-block content, unwrap an optional `<system-reminder>`, and match only:

```js
const TRAILING_NOISE = [
  ["deferred-tools", "The following deferred tools are now available via ToolSearch."],
  ["task-tools", "The task tools haven't been used recently."],
];
```

Delete a non-empty message only when `i > lastUser` and normalized text starts with one of these prefixes. Log the rule and index.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the three commands from Step 2. Expected: all exit 0 with no import errors.

- [ ] **Step 5: Commit**

```powershell
git add extensions tests
git commit -m "fix: target cache-breaking system reminders"
```

### Task 2: Fail-Closed Runtime Layout And Validation

**Files:**
- Create: `scripts/validate-runtime.mjs`
- Create: `tests/test-runtime-validation.mjs`
- Modify: `scripts/setup.ps1`
- Modify: `scripts/start.ps1`
- Modify: `tests/run-all.mjs`

**Interfaces:**
- Produces: `validateRuntime(options) -> Promise<{ loaded: string[], failed: object[] }>`.
- CLI: `node scripts/validate-runtime.mjs --dir <runtime-root>` exits nonzero on invalid runtime.

- [ ] **Step 1: Write runtime validation integration tests**

Create temporary runtimes and assert:

```js
const result = spawnSync("powershell", [
  "-ExecutionPolicy", "Bypass", "-File", setupPath, "-Dir", runtimeDir,
], { encoding: "utf8" });
assert.equal(result.status, 0);

const validation = spawnSync("node", [validatorPath, "--dir", runtimeDir], {
  encoding: "utf8",
});
assert.equal(validation.status, 0);
assert.match(validation.stdout, /strip-empty-system/);
```

Add negative cases for missing runtime, missing config, a broken `.mjs` file, and a config with `strip-empty-system` disabled.

- [ ] **Step 2: Run the new test and verify RED**

Run: `node tests/test-runtime-validation.mjs`

Expected: FAIL because `validate-runtime.mjs` does not exist and current setup uses the wrong parameter/layout.

- [ ] **Step 3: Implement `validate-runtime.mjs`**

The module must:

```js
const REQUIRED = [
  "prefix-hold",
  "strip-empty-system",
  "deepseek-cache-optimize",
  "strip-billing-header",
];
```

Resolve `<runtime>/extensions` and `<runtime>/extensions/extensions.json`, verify both exist, import cache-fix's real `proxy/pipeline.mjs` from `%APPDATA%/npm/node_modules`, call `loadExtensions`, reject `getFailedExtensions()`, reject an empty registry, and reject missing `REQUIRED` names. Print a JSON summary on success.

- [ ] **Step 4: Fix setup layout and start/status preflight**

Change both scripts to:

```powershell
param([string]$Dir = "$env:USERPROFILE\axonhub")
```

Copy built-in `.mjs` extensions to `$Dir\extensions`, copy helper modules to `$Dir`, copy custom extensions/config to `$Dir\extensions`, then run:

```powershell
& $NodePath "$RepoDir\scripts\validate-runtime.mjs" --dir $Dir
if ($LASTEXITCODE -ne 0) { throw "Extension runtime validation failed" }
```

`start.ps1 -Status` must display `VALID` only when the local validator exits 0; otherwise display `INVALID` and exit 1. Normal start validates before spawning Node.

- [ ] **Step 5: Run validation tests and verify GREEN**

Run: `node tests/test-runtime-validation.mjs`

Expected: all positive and negative cases pass; generated runtime reports zero failed extensions.

- [ ] **Step 6: Register suite and run all Node tests**

Add `test-runtime-validation.mjs` to `tests/run-all.mjs` and run:

```powershell
node tests/run-all.mjs
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```powershell
git add scripts/setup.ps1 scripts/start.ps1 scripts/validate-runtime.mjs tests
git commit -m "fix: fail closed on invalid extension runtime"
```

### Task 3: AxonHub Cache Report Compatibility

**Files:**
- Modify: `scripts/cache_report.py`
- Create: `tests/test-cache-report.py`
- Modify: `tests/run-all.mjs`

**Interfaces:**
- Produces: `cache_column(conn) -> str`, `query_rows(conn, minutes) -> list`, and `main(argv=None) -> int`.

- [ ] **Step 1: Write schema compatibility tests**

Create in-memory SQLite tables for both schemas:

```python
def make_db(column):
    conn = sqlite3.connect(":memory:")
    conn.execute(f"CREATE TABLE usage_logs (id INTEGER, prompt_tokens INTEGER, {column} INTEGER, created_at TEXT)")
    conn.execute(f"INSERT INTO usage_logs VALUES (1, 100, 99, datetime('now'))")
    return conn

assert cache_column(make_db("prompt_cached_tokens")) == "prompt_cached_tokens"
assert cache_column(make_db("cached_tokens")) == "cached_tokens"
```

Also assert an unsupported schema raises a clear error and query output computes 99.0%.

- [ ] **Step 2: Run test and verify RED**

Run: `python tests/test-cache-report.py`

Expected: FAIL because importing the current script immediately opens the production DB and no helper functions exist.

- [ ] **Step 3: Refactor and implement schema detection**

Guard execution with `if __name__ == "__main__"`. Use `PRAGMA table_info(usage_logs)` and prefer `prompt_cached_tokens`, falling back to `cached_tokens`. Interpolate only the selected allowlisted identifier; bind the time cutoff as a parameter.

- [ ] **Step 4: Run test and verify GREEN**

Run: `python tests/test-cache-report.py`

Expected: exit 0.

- [ ] **Step 5: Register test and commit**

Add the Python test command to `tests/run-all.mjs`, run the full suite, then:

```powershell
git add scripts/cache_report.py tests
git commit -m "fix: support current AxonHub cache schema"
```

### Task 4: Documentation, Deployment, And Real E2E

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `.agents/skills/e2e-cache-test/SKILL.md`

**Interfaces:**
- Consumes: validated setup/start commands and cache report.
- Produces: operator workflow matching the implementation.

- [ ] **Step 1: Update documentation**

Document `~/axonhub` as the single runtime, `setup.ps1 -Dir`, fail-closed validation, current `prompt_cached_tokens` schema, and the targeted system reminders. Remove claims that current AxonHub forwards `cache_control` to native DeepSeek requests.

- [ ] **Step 2: Run static and automated verification**

```powershell
git diff --check
node tests/run-all.mjs
python scripts/cache_report.py 10
```

Expected: no whitespace errors, all tests pass, and the report reads current data.

- [ ] **Step 3: Deploy validated runtime**

```powershell
.\scripts\setup.ps1
```

Expected: validation exits 0 and lists all four required custom extensions with no failures.

- [ ] **Step 4: Restart only cache-fix**

Find the Node process whose command line contains `claude-code-cache-fix\proxy\server.mjs`, stop only that PID, run `scripts/start.ps1`, and run `scripts/start.ps1 -Status`.

Expected: AxonHub PID is unchanged; proxy has a new PID; runtime is `VALID`; `/health` is `ok`.

- [ ] **Step 5: Run E2E and collect exact rows**

Record the maximum `usage_logs.id`, run:

```powershell
claude -p "连续调6轮tool，尽量节约prompt，用 Bash (echo 1) (echo 2) 直到 6。每轮调用后说一句话。不要用其他工具。"
```

Then query only rows above the recorded ID using `prompt_cached_tokens`.

- [ ] **Step 6: Verify acceptance evidence**

Assert every row after the first is at least 99%. Query AxonHub request bodies to assert neither approved reminder is present and SessionStart hook context remains. Inspect `~/axonhub/logs` and proxy stderr for extension load or pipeline errors.

- [ ] **Step 7: Commit final documentation**

```powershell
git add README.md AGENTS.md .agents/skills/e2e-cache-test/SKILL.md docs/superpowers/plans/2026-07-13-eliminate-periodic-cache-drops.md
git commit -m "docs: align cache fix deployment and verification"
```
