# Cache Investigation Documentation Design

## Goal

Document the completed periodic-cache-drop investigation in enough detail that
a new operator can understand the system, reproduce the reasoning, avoid the
same dead ends, and safely respond when a future Anthropic or Claude Code
release changes request behavior.

The documentation must remain useful at three levels:

1. `README.md` explains the product, evidence, investigation, and design choices.
2. `AGENTS.md` defines repository-local maintenance rules and upgrade gates.
3. `.agents/skills/` provides short executable workflows with current schemas
   and commands.

## Audience And Language

All updated documentation remains in English to match the public repository.
The README targets users, operators, and maintainers. AGENTS and skills target
agents or engineers actively diagnosing and changing the pipeline.

## Source Of Truth

Documentation statements must be grounded in current repository code and the
verified July 13, 2026 traces:

- final strict-serial E2E: one cold request followed by six 99%+ requests;
- runtime validator: 29 extensions loaded, zero failures;
- AxonHub `usage_logs.prompt_cached_tokens` is the current cache metric;
- AxonHub request bodies show the post-cache-fix Anthropic shape;
- `request_executions.request_body` shows the native DeepSeek shape;
- standalone deferred-tools and task-tools reminders are removed while
  SessionStart context is preserved;
- DeepSeek cache behavior is best-effort and prefix-unit based, so a new
  session cold miss remains expected.

The existing implementation design and plan remain the detailed engineering
record:

- `docs/superpowers/specs/2026-07-13-eliminate-periodic-cache-drops-design.md`
- `docs/superpowers/plans/2026-07-13-eliminate-periodic-cache-drops.md`

The README links to these documents instead of duplicating task-level code.

## README Information Architecture

Retain the quick product description, setup, service management, tests, and
license. Expand the technical narrative with these sections.

### How The Pipeline Works

Explain both format boundaries:

```text
Claude Code Anthropic request
  -> cache-fix extension pipeline
  -> AxonHub Anthropic request record
  -> AxonHub native OpenAI/DeepSeek translation
  -> DeepSeek prefix-unit cache
```

Clarify that `cache_control` markers are removed by current AxonHub translation
before the native DeepSeek request. They remain normalized as a compatibility
guard, but they were not the confirmed cause of the final periodic drop.

### Cache Semantics And Success Criteria

Describe complete persisted prefix units, cold construction delay, and why
cache reuse is not equivalent to raw JSON equality. Define the repository's
acceptance contract:

- a new session may have one cold miss;
- every later request in the strict-serial E2E must be at least 99%;
- a later miss is a regression until explained by a meaningful prefix change.

### Investigation Narrative

Present the investigation as an evidence chain rather than a chronology of
commands:

1. Establish baseline hit sequences from SQLite.
2. Compare AxonHub and native request bodies.
3. Discover that the live proxy loaded zero extensions despite `/health: ok`.
4. Trace setup/start directory divergence and helper-module layout failures.
5. Repair tests that never imported production extensions.
6. Deploy targeted filtering and observe the first E2E still fail.
7. Correlate extension timestamps with request creation timestamps.
8. Discover Claude Code replays the removed reminder into history on the next
   request.
9. Suppress exact reminders at both injection and historical replay.
10. Verify stable native prefixes and 99%+ post-cold hits.

### Pitfalls And False Leads

Use a table containing symptom, misleading interpretation, evidence, and rule:

- `/health: ok` does not prove a non-empty extension registry;
- setup and start defaults can silently point at different runtime roots;
- helper modules copied beside extensions break `../helper.mjs` imports;
- duplicated test logic can pass while production modules cannot import;
- `usage_logs.cached_tokens` is an obsolete schema assumption;
- extension mutation logs must be correlated with request-start timestamps,
  not response/usage completion timestamps;
- a reminder removed on request N can reappear historically on request N+1;
- substring searches can falsely report a standalone reminder because the
  phrase also appears inside preserved SessionStart context;
- a prompt that says "six tools" may allow parallel calls and produce only two
  API requests, so it does not exercise periodic injection behavior.

### Design Decisions And Rejected Alternatives

Record the reasoning behind:

- one runtime root under `~/axonhub`;
- fail-closed local validation instead of patching the global npm package;
- exact-prefix removal instead of broad contentful-system deletion;
- preserving SessionStart and unknown system messages;
- removing exact reminders during historical replay;
- retaining cache-control normalization as compatibility defense;
- using strict-serial real traffic as the final acceptance test.

Rejected alternatives include deleting every trailing system message, trusting
the upstream health endpoint alone, persisting potentially stale tool lists,
and accepting a periodic one-request recovery as success.

### Operational Verification And Limitations

Document setup, status, cache reporting, strict E2E, exact-row querying, log
inspection, and request-body verification. Clearly distinguish fixed periodic
misses from expected misses caused by cold sessions, meaningful context/tool
changes, compaction/resume, cache eviction, construction delay, or a new
upstream pattern.

## AGENTS Maintenance Runbook

AGENTS gains a dedicated `Upstream compatibility` section organized as an
imperative workflow.

### Upgrade Triggers

Run the compatibility workflow when any of these changes:

- Claude Code version;
- `claude-code-cache-fix` version;
- AxonHub version or database schema;
- DeepSeek Anthropic compatibility or context-cache documentation;
- MCP/tool-search configuration;
- SessionStart hooks, skills, plugins, or project instructions.

### Required Baseline

Before an upgrade, record component versions, runtime validation output, the
latest strict-serial trace, per-request cache percentages, exact standalone
system reminders, system/tools hashes, and native overlapping-message hashes.

### Post-Upgrade Decision Tree

1. Validate runtime before interpreting cache data.
2. Run the strict-serial E2E and query only rows above the recorded usage ID.
3. If a post-cold request is below 99%, compare the preceding good request and
   failing request at both AxonHub and native boundaries.
4. Classify the first real difference as deployment, system/tools drift,
   historical-message rewrite, role/content-shape drift, meaningful context
   change, or external DeepSeek cache behavior.
5. Form one hypothesis, add one real-module regression test, and change one
   variable at a time.

### Safety Rules

- Never remove arbitrary contentful system messages for cache percentage.
- Match known bookkeeping content by exact anchored prefix and preserve unknown
  content.
- Verify historical replay, not only first injection.
- Never trust `/health` without local runtime validation.
- Never use copied implementation logic as the only extension test.
- Never classify a substring occurrence as a standalone message without
  checking role, content shape, and normalized prefix.
- Never accept an E2E run that did not produce the expected seven requests.
- Do not update known-pattern tables until request and native evidence agree.

### Upstream Research And Documentation Updates

For a new pattern, search the Claude Code release notes and issue tracker,
DeepSeek official docs, and cache-fix release notes. Record issue links and the
first affected version. After a verified fix, update README, AGENTS,
`references/patterns.md`, and the directly responsible skills in the same
change.

## Skill Updates

Update the narrowest existing skills rather than creating a duplicate:

- `cache-hit-check`: use `prompt_cached_tokens`, distinguish cold from
  post-cold requests, and query by a recorded usage watermark.
- `cache-hit-debug`: validate runtime first, compare both storage boundaries,
  and recognize injection-versus-historical-replay behavior.
- `session-analyze`: check exact standalone system messages and correlate
  request creation time with extension logs.
- `e2e-cache-test`: retain the strict-serial prompt, require seven requests,
  and fail any post-cold result below 99%.
- `extension-dev/references/patterns.md`: add the replay failure mode, health
  false positive, and semantic filtering boundary.

## Duplication Policy

- README owns explanation, evidence, and trade-offs.
- AGENTS owns mandatory repository workflow and safety rules.
- Skills own commands and narrow execution steps.
- Pattern references own concise symptom-to-cause mappings and upstream links.
- Design and plan documents own implementation-level detail.

When the same fact appears in more than one file, one location must be clearly
normative and the others should link or summarize it.

## Verification

The documentation change is complete only when:

- all mentioned paths, commands, columns, extension names, orders, ports, and
  thresholds match current code;
- no active instruction still recommends `cached_tokens` for `usage_logs`;
- no active instruction describes periodic 25% misses as expected success;
- the strict E2E prompt is identical across README/AGENTS/skills where copied;
- all local Markdown links resolve;
- `git diff --check` passes;
- `node tests/run-all.mjs` still passes because command documentation and
  runtime scripts were not accidentally changed.

## Non-Goals

- Adding new runtime behavior or extensions.
- Rewriting the implementation design or plan into the README line by line.
- Promising that DeepSeek will never have a cold or externally caused miss.
- Creating a new global rule for a repository-specific compatibility workflow;
  AGENTS and the existing repository skills are the narrowest durable homes.
