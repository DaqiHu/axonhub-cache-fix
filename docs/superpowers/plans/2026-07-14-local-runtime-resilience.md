# Local Runtime Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user selected inline execution for this session.

**Goal:** Make local AxonHub and cache-fix services self-recovering, observable, and safer under SQLite contention without automatic data deletion.

**Architecture:** Shared PowerShell runtime helpers provide process detection,
log rotation, health thresholds, and maintenance gates. A persistent supervisor
owns restart policy, while an extension records bounded non-2xx JSON error
details. SQLite retention remains controlled by AxonHub Storage Policy.

**Tech Stack:** PowerShell 5.1+, Node.js ESM, cache-fix extension hooks, Python
SQLite standard library, AxonHub SQLite/modernc DSN.

## Global Constraints

- Do not change the one-day request retention selected in AxonHub.
- Never run checkpoint, backup, or vacuum while ports 8090/9801 are listening.
- Never restart a service solely because the upstream returned HTTP 5xx.
- Logs must be bounded and must not contain authorization credentials.
- No subagents.

---

### Task 1: Runtime Helper Contracts

**Files:**
- Create: `scripts/runtime-common.ps1`
- Create: `tests/test-runtime-common.ps1`
- Modify: `tests/run-all.mjs`

**Interfaces:**
- Produces: `Get-ListeningProcessId`, `Rotate-LogFile`, `Get-RestartDelaySeconds`,
  `Get-FileHealth`, `Test-MaintenanceAllowed`, `Write-RuntimeEvent`.

- [ ] Write tests proving port parsing, 100 MiB rotation with five generations,
  capped backoff, WAL warning/critical classification, and active-port
  maintenance rejection.
- [ ] Run `powershell -File tests/test-runtime-common.ps1`; verify RED because
  `runtime-common.ps1` does not exist.
- [ ] Implement the pure helper functions without starting services.
- [ ] Re-run the focused test and require zero failures.

### Task 2: Structured Upstream Error Bodies

**Files:**
- Create: `extensions/upstream-error-body-log.mjs`
- Create: `tests/test-upstream-error-body-log.mjs`
- Modify: `extensions/extensions.json`
- Modify: `scripts/validate-runtime.mjs`

**Interfaces:**
- Consumes: cache-fix `onRequest` and `onResponse` contexts.
- Produces: JSONL records with `status`, `request_id`, `model`, `error_code`,
  `error_message`, and a maximum 4096-character `body_preview`.

- [ ] Write tests for JSON 500 capture, `ah-request-id`, truncation, successful
  response skip, immutable response body, and fail-open writes.
- [ ] Run the focused Node test and verify RED.
- [ ] Implement order 675 and register it.
- [ ] Re-run the test and runtime validator tests.

### Task 3: Proxy Failure-Containment Test

**Files:**
- Create: `tests/test-proxy-resilience.mjs`
- Modify: `tests/run-all.mjs`

**Interfaces:**
- Imports the installed cache-fix `startProxy()`.
- Starts a disposable HTTP upstream returning five JSON 500 responses then 200.

- [ ] Write the integration test and run it against the current proxy.
- [ ] Require all five 500 bodies to pass through unchanged, the sixth request
  to succeed, and `/health` to remain 200 throughout.
- [ ] Register the passing compatibility test as an upstream regression guard.

### Task 4: Supervisor, Start, Stop, And Status

**Files:**
- Create: `scripts/supervise.ps1`
- Create: `tests/fake-service.ps1`
- Create: `tests/test-supervisor.ps1`
- Modify: `scripts/start.ps1`
- Modify: `scripts/stop.ps1`
- Create: `scripts/runtime-health.ps1`

**Interfaces:**
- `start.ps1` starts one supervisor unless `-Once` is specified.
- `supervise.ps1` starts/restarts children and appends lifecycle JSONL records.
- `runtime-health.ps1` is read-only and returns nonzero only for missing service
  or invalid extension runtime, not for size warnings.

- [ ] Write failing tests for singleton supervisor detection, fake-child restart,
  exit-code evidence, and no restart decision for an HTTP 500 signal.
- [ ] Implement supervisor-owned child starts, capped backoff, three-strike
  cache-fix health recovery, stdout/stderr capture, and log rotation.
- [ ] Update stop logic to stop supervisor before children.
- [ ] Run focused PowerShell integration tests.

### Task 5: Offline SQLite Maintenance And Busy Timeout

**Files:**
- Create: `scripts/maintain-db.ps1`
- Create: `scripts/sqlite-maintenance.py`
- Create: `tests/test-sqlite-maintenance.py`
- Modify runtime: `~/axonhub/config.yml`

**Interfaces:**
- Preview prints DB/WAL/freelist/page metrics.
- `-Execute` requires inactive services, creates `backups/axonhub-<timestamp>.db`,
  runs checkpoint truncate and optimize, and runs vacuum only with `-Vacuum`.

- [ ] Write tests using a temporary WAL database for preview, active-service
  rejection contract, backup creation, checkpoint, and optional vacuum.
- [ ] Implement Python maintenance operations and the PowerShell safety wrapper.
- [ ] Add `_pragma=busy_timeout(10000)` to the existing SQLite DSN and validate
  configuration with `axonhub config validate`.
- [ ] Do not execute offline maintenance during implementation.

### Task 6: Deployment And Documentation

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `.agents/skills/cache-hit-debug/SKILL.md`
- Modify: `.agents/skills/e2e-cache-test/SKILL.md`

- [ ] Document supervisor behavior, log paths/rotation, health thresholds,
  one-day retention ownership, maintenance safety, and PostgreSQL config-only
  migration note.
- [ ] Run `node tests/run-all.mjs` and `git diff --check`.
- [ ] Run `scripts/setup.ps1`, stop the old one-shot services, start the new
  supervisor, and verify runtime health.
- [ ] Confirm the effective SQLite `busy_timeout` is 10000 after restart.
- [ ] Commit the implementation with task-scoped files only.
