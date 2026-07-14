# Low-Cache Request Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user selected inline execution.

**Goal:** Add a seven-day JSONL archive containing only complete Anthropic request bodies with measured cache hit below 80%.

**Architecture:** A late, response-observing extension stages the final request body on request, evaluates standard Anthropic usage on streaming or non-streaming response paths, and serializes qualifying records into daily files. The supervisor supplies explicit defaults and runtime health reports archive size.

**Tech Stack:** Node.js ESM extension hooks, JSONL, PowerShell 5.1 runtime scripts, Python documentation contracts.

## Global Constraints

- Threshold is strictly below 80%.
- Retention is seven days in UTC daily files.
- Store the complete post-extension Anthropic body but no general request headers.
- Unknown usage and responses without cache fields produce no record.
- Logging is fail-open and cannot mutate requests or responses.
- Do not change AxonHub logging or delete its database from this repository.
- Execute inline without subagents.

---

### Task 1: Extension Contract And Storage

**Files:**
- Create: `extensions/low-cache-trace.mjs`
- Create: `tests/test-low-cache-trace.mjs`
- Modify: `extensions/extensions.json`
- Modify: `scripts/validate-runtime.mjs`
- Modify: `tests/test-runtime-validation.mjs`
- Modify: `tests/run-all.mjs`

**Interfaces:**
- Consumes: request `ctx.body`, selected request headers, response status and
  headers, Anthropic `usage`, and request-scoped `ctx.meta`.
- Produces: `low-cache-requests/YYYY-MM-DD.jsonl` records and exported pure
  helpers for usage classification and retention tests.

- [ ] Write tests for strict 80% selection, no-cache-field skip, streaming and
  non-streaming once-only capture, exact body preservation, safe correlation
  headers, concurrent JSONL validity, seven-day cleanup, and fail-open writes.
- [ ] Run `node tests/test-low-cache-trace.mjs` and verify failure because the
  extension does not exist.
- [ ] Implement the order-900 extension with serialized append and throttled
  UTC daily retention.
- [ ] Register the extension and make runtime validation require it.
- [ ] Run the focused test and runtime validation tests with zero failures.

### Task 2: Runtime Configuration And Health

**Files:**
- Modify: `scripts/supervise.ps1`
- Modify: `scripts/runtime-common.ps1`
- Modify: `scripts/runtime-health.ps1`
- Modify: `tests/test-runtime-common.ps1`
- Modify: `tests/test-service-scripts.ps1`

**Interfaces:**
- `Get-CacheFixEnvironment` supplies threshold, retention, and directory.
- `Get-DirectoryHealth` returns aggregate archive bytes and warning state.

- [ ] Add failing tests for exact environment defaults and aggregate directory
  health without file mutation.
- [ ] Implement the environment and health helpers.
- [ ] Run both PowerShell focused suites and require zero failures.

### Task 3: Operator Documentation

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `.agents/skills/cache-hit-check/SKILL.md`
- Modify: `.agents/skills/cache-hit-debug/SKILL.md`
- Modify: `.agents/skills/e2e-cache-test/SKILL.md`
- Modify: `.agents/skills/session-analyze/SKILL.md`
- Modify: `tests/test-probe-docs.py`

**Interfaces:**
- Documents the archive path, formula, threshold, retention, inspection
  commands, and loss of AxonHub native translation evidence.

- [ ] Add a failing documentation contract for all required operator facts.
- [ ] Update README, AGENTS, and probe skills with the new standalone trace
  workflow.
- [ ] Run `python tests/test-probe-docs.py` and require zero failures.

### Task 4: Deployment And Real Probe

**Files:**
- Runtime copy under `~/axonhub/extensions/`
- Runtime logs under `~/axonhub/logs/low-cache-requests/`

**Interfaces:**
- `scripts/setup.ps1` deploys and validates.
- `scripts/start.ps1` restarts the proxy through the supervisor.

- [ ] Run `node tests/run-all.mjs` and `git diff --check`.
- [ ] Run `scripts/setup.ps1`, restart only cache-fix, and require runtime
  `VALID` with `/health: ok`.
- [ ] Record the archive watermark, run a fresh short
  `claude -p --model deepseek-v4-flash` Bash-tool request, and wait for a
  qualifying JSONL record.
- [ ] Parse the record and verify hit `<80`, complete request body, expected
  model/session fields, and no authorization/header dump.
- [ ] Commit the implementation and report that AxonHub body tracing may now be
  disabled, with the documented native-translation limitation.
