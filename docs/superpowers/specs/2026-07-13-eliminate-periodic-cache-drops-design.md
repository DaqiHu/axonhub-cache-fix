# Eliminate Periodic DeepSeek Cache Drops

## Goal

Make the Claude Code -> cache-fix -> AxonHub -> DeepSeek pipeline preserve a
stable prompt prefix during ordinary multi-turn tool use. In the six-tool E2E
scenario, only the cold request may be below 90%; every later request must be
at least 99% cache hit.

## Confirmed Causes

1. `setup.ps1` installs the runtime under `%LOCALAPPDATA%`, while `start.ps1`
   loads extensions from `~/axonhub`. A missing extension directory is swallowed
   by cache-fix 4.2.1 and `/health` still returns `ok`, so the live proxy can run
   with an empty registry.
2. Setup copies built-in helper modules into `extensions/`, although built-in
   extensions import them from the runtime root. A generated runtime therefore
   has partial extension-load failures.
3. Claude Code 2.1.187 appends two repeatable mid-conversation system messages:
   the deferred-tools availability notice and the task-tools reminder. These
   create new DeepSeek prefix units and produce single-request drops around
   13-26% before the next request recovers.
4. Existing tests do not import the production extensions because their paths
   point at `tests/extensions/`. The aggregate pipeline test duplicates logic
   instead of exercising the actual modules.
5. The cache report uses the obsolete `cached_tokens` column instead of the
   current AxonHub `prompt_cached_tokens` column.

## Selected Design

### Runtime Layout

Use `~/axonhub` as the single default runtime root for setup, start, status, and
logs:

```text
~/axonhub/
  axonhub.exe
  axonhub.db
  extensions.json helper modules
  extensions/
    built-in extensions
    custom extensions
    extensions.json
  logs/
```

Helper modules imported with `../helper.mjs` are copied to the runtime root.
The extension config remains in `extensions/extensions.json`, matching the
cache-fix environment variables.

Setup and start use the same parameter name, `-Dir`. Documentation and status
output use that name consistently.

### Fail-Closed Extension Validation

Add a reusable Node validation script that loads the generated extension graph
through cache-fix's real pipeline loader. Validation fails when:

- the extension directory or config is missing;
- any extension import fails;
- a required custom extension is absent or disabled;
- the loaded registry is empty.

`setup.ps1` runs validation after copying files. `start.ps1` runs it before
starting the proxy. `start.ps1 -Status` reports runtime validation separately
from the upstream `/health` endpoint so an empty registry cannot be labelled
healthy.

The global npm package is not patched. The repository wrapper compensates for
cache-fix 4.2.1's missing-directory health blind spot.

### Targeted System-Message Filtering

Keep the existing `strip-empty-system` extension name and order 47, but narrow
its contentful removal rules.

Always remove empty system messages. Remove a contentful system message when
its normalized text starts with one of these exact upstream bookkeeping
prefixes:

```text
The following deferred tools are now available via ToolSearch.
The task tools haven't been used recently.
```

Support both string content and Anthropic text-block arrays, including optional
`<system-reminder>` wrappers. Preserve all other contentful system messages,
including SessionStart hook output, project instructions, user hook context,
and unknown future messages. The exact reminders remain suppressed when Claude
Code replays them from the tail into historical positions on later requests.

Every removal is logged with the matched rule and message index. Preserved
unknown content is not logged on every request to avoid noise.

### Extension Hygiene

All custom extensions import `homedir` from `node:os`, so direct imports and
unit tests work without relying on `AXONHUB_CACHE_FIX_LOG_DIR` short-circuiting.
Unused imports are removed.

The DeepSeek cache-control extension remains enabled as a compatibility guard,
although current AxonHub translation removes `cache_control` before the native
DeepSeek request. Documentation will distinguish this compatibility behavior
from the confirmed system-injection cause.

### Reporting

`cache_report.py` detects the available cache-token column from SQLite schema,
preferring `prompt_cached_tokens` and falling back to `cached_tokens` for older
AxonHub databases. It keeps the existing CLI and summary format.

## Testing

Testing uses production modules and follows red-green-refactor.

1. Fix unit-test import paths and first observe the current import failures.
2. Add targeted system-message tests proving:
   - both known reminders are removed at first injection and historical replay;
   - wrappers and array/string formats are handled;
   - SessionStart hook output is preserved;
   - arbitrary trailing system content is preserved;
   - contentful system messages before the last user are preserved;
   - empty system messages are removed anywhere.
3. Add a runtime-layout integration test that runs setup in a temporary
   directory and loads the real extension registry with zero failures.
4. Add validation-script tests for missing directory, missing config, failed
   imports, and missing required custom extensions.
5. Add cache-report tests against temporary SQLite schemas using both supported
   cache-token column names.
6. Run `node tests/run-all.mjs` with all suites loading real source files.

## Deployment And E2E Acceptance

After all automated tests pass:

1. Run setup against `~/axonhub`.
2. Restart only the cache-fix Node process; leave AxonHub running.
3. Confirm runtime validation passes and custom extension logs are created.
4. Run the standard six-tool Claude Code prompt.
5. Query the exact new `usage_logs` rows.

Acceptance requires:

- the first request may be cold;
- every subsequent request is at least 99% cache hit;
- the forwarded AxonHub request bodies contain neither standalone targeted
  system reminder;
- SessionStart hook context remains present;
- no extension load failures or pipeline errors appear in stderr;
- the full automated test suite passes.

If a later request remains below 99%, compare its AxonHub and native DeepSeek
request bodies before making any additional mutation. No broader system-message
deletion is permitted without a new design decision.

## Non-Goals

- Patching Claude Code or the globally installed cache-fix package.
- Removing arbitrary system messages to chase cache percentage.
- Guaranteeing cross-session cache reuse when the initial project envelope is
  genuinely different.
- Hiding meaningful tool disconnection or error messages not covered by the
  two approved bookkeeping patterns.
