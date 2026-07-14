# axonhub-cache-fix development guide

## Prerequisites

- **AxonHub** running on `:8090` (default install: `~/axonhub/axonhub.exe`)
- **cache-fix proxy** installed globally: `npm install -g claude-code-cache-fix`
  (default: `%APPDATA%/npm/node_modules/claude-code-cache-fix/`)
- **Extensions runtime** under `~/axonhub/` (shared with AxonHub; `setup.ps1` populates it)

## Architecture

```
Claude Code → cache-fix proxy (:9801) → AxonHub (:8090) → DeepSeek API
                  ↑ extensions run here
```

Extensions process Anthropic-format `/v1/messages` request bodies in order.
Modified body is forwarded to AxonHub, which translates to native DeepSeek
format and sends to `api.deepseek.com`.

## Extension development

### Order matters
Extensions run at fixed `order` positions. Lower = earlier.

Critical ordering:
- **46-48**: Content stabilization (prefix-hold, strip-empty-system, cc-strip)
  Must run BEFORE cache-control removal so they see original cc positions.
- **85**: Billing header removal (can run after cc strip)
- **200-250**: Tool stabilization. Built-in alphabetical sorting runs at 200,
  `tool-order-hold` runs at 210, and fresh-session sorting runs at 250.
  Dynamic-tool order holding must see deterministic current input but run before
  later prompt normalization.

### Extension template

See `scripts/template.mjs` for the standard extension skeleton.
All extensions must:
- Export `default { name, description, order, onRequest }`
- Log changes to `$env:AXONHUB_CACHE_FIX_LOG_DIR` (default `~/axonhub/logs/`)
- Include unit tests in `tests/`

### Stateful extension safety
- Scope in-memory state by both `x-claude-code-session-id` and
  `x-claude-code-agent-id`. Subagents share the parent session ID and can issue
  concurrent requests with unrelated message histories.
- Never restore or replace a `tool_result` when its `tool_use_id` differs from
  the stored content. Every assistant `tool_use.id` must remain paired with the
  following user `tool_result.tool_use_id`.
- Add concurrent-agent and changed-tool-ID regression tests for any extension
  that stores message content across requests.
- Tool-order state must additionally include model and request family. Exact
  one-tool `web_search` requests are a separate family from conversations.
- A tool-order extension may reorder only tool objects present in the current
  request. Never add a remembered tool, retain a removed tool, or replace the
  current definition with a stored definition.

### Adding an extension
1. Create `extensions/<name>.mjs` with the template
2. Add unit tests in `tests/test-<name>.mjs`
3. Register in `extensions/extensions.json` with order
4. Run `node tests/run-all.mjs` to verify
5. Run `scripts/setup.ps1`; runtime validation must report zero load failures

### Debugging
- Extension logs: `~/axonhub/logs/*.log`
- cache-fix debug log: `~/.claude/cache-fix-debug.log` (requires `CACHE_FIX_DEBUG=1`)
- Proxy stderr: `~/axonhub/logs/cache-fix-stderr.log`
- AxonHub request traces: `http://localhost:8090` → Tracing tab

## Testing against real requests

### Downloading request bodies
1. Open AxonHub dashboard: http://localhost:8090
2. Go to Tracing → Requests
3. Click a request → download body as JSON
4. Save to `test-data/` directory

### Analyzing with Python
```bash
python scripts/analyze.py --dir ./test-data "*Request_*.json"
python scripts/cache_report.py 60 --low-only
```

Key diagnostics:
- `cc=0` confirms cache_control stripping works
- `history_prefix=True` means all overlapping messages are unchanged
- `first_msg=None` means no overlapping message changed
- `tools_added` / `tools_removed` expose dynamic inventory transitions
- `appended_system=N` requires inspection of the exact new system text
- `growth=+N/Xc` separates small growth from large uncached content
- `cache_report.py` defaults to DeepSeek Anthropic traffic, orders by request
  creation time, and uses lookback rows only as classifier state.

## Cache hit rate investigation

### Where to find cache data
1. **AxonHub SQLite DB** → `~/axonhub/axonhub.db`, table `usage_logs`:
   - `prompt_tokens` and `prompt_cached_tokens` give hit rate
   - `format` (col 18) = `"anthropic/messages"` for Anthropic requests
   - Query: `SELECT prompt_tokens, prompt_cached_tokens FROM usage_logs ORDER BY created_at DESC LIMIT 10`
2. **request_executions** table → `response_body` JSON has `prompt_tokens_details.cached_tokens`
3. **AxonHub tracing** → Response body has `usage.cache_read_input_tokens`
4. **cache-fix debug log** → `~/.claude/cache-fix-debug.log` (requires `CACHE_FIX_DEBUG=1`)

Start with the read-only classified reports:

```powershell
python scripts/cache_report.py 60 --low-only
python scripts/cache_report.py 60 --summary
```

Do not mix models or formats silently. The default filter is `deepseek%` plus
`anthropic/messages`. Use `--all-models --all-formats` only for an explicit
cross-provider audit. Category summaries are token-weighted.

### Known cache drop patterns

| Symptom | Root cause | Fix extension |
|---------|-----------|---------------|
| 0% hit, billing header present | `cch=` nonce changes every request | strip-billing-header |
| 13-26% hit on injection requests | Deferred-tools or task-tools system reminder | strip-empty-system |
| ~82% hit after injection | prefix-hold restored most but some boundary change | prefix-hold (partial) |
| 1-9% exactly when tools appear | Existing tools moved after full-array sort | tool-order-hold |
| 0-10% with `appended-system` | Worktree instructions, file diff, or background-task event | Preserve; expected semantic growth |
| lower hit with `large-growth` | Large tool result/skill text appended to exact prefix | Measure growth; usually expected |
| 99.99% hit | Clean state | — |

Do not infer a root cause from hit percentage alone. Use the classified report
and inspect adjacent request bodies. `standalone-web-search`, `cold-first`,
`appended-system`, `large-growth`, and `clean-growth` rows are not automatically
extension failures. Compare
categories with token-weighted rates, not request-count averages.

### Semantic boundary
DeepSeek creates cache prefix units at "end of user input". Claude Code
periodically injects system reminders. The extension removes only the two
approved bookkeeping prefixes, including their historical replay on later
requests. Meaningful or unknown system content must be preserved even when
that means a cache miss.

Current meaningful examples include worktree `CLAUDE.md` / `AGENTS.md`
contents, user/linter file-change notices with diffs, and
`[SYSTEM NOTIFICATION - NOT USER INPUT]` background-task completion/failure
events. They are classified as `appended-system`; do not broaden the strip
allowlist to include them.

## Conversation patterns observed

### Claude Code message formats
- User text: `{role:"user", content:[{type:"text",text:"..."}]}` OR `{role:"user", content:"..."}` (string)
- Tool result: `{role:"user", content:[{type:"tool_result",...}]}`
- Assistant: `{role:"assistant", content:[{type:"thinking",...},{type:"tool_use",...}]}`
- Empty system: `{role:"system", content:[]}`
- Deferred-tools reminder: `{role:"system", content:"The following deferred tools are now available..."}`
- System reminder: `{role:"system", content:"The task tools haven't been used recently..."}`
- Worktree instructions: `{role:"system", content:"Contents of .../AGENTS.md: ..."}`
- File-change notice: `{role:"system", content:"Note: ... was modified..."}`
- Background event: `{role:"system", content:"[SYSTEM NOTIFICATION - NOT USER INPUT]..."}`

### Content format variations
Claude Code varies string vs array format for `content` between requests.
Extensions must handle both.

## DeepSeek API notes

- Anthropic base URL: `https://api.deepseek.com/anthropic`
- `cache_control`: ignored by DeepSeek; current AxonHub translation removes it from native requests
- Context caching: automatic, prefix-based, requires **full match** of cache prefix unit
- Cache prefix units: at end of user input, end of model output, fixed intervals
- "Cache construction takes seconds" (per docs)
- Rate limits don't affect caching

## Community references

- [#68900](https://github.com/anthropics/claude-code/issues/68900): Billing header nonce breaks prefix caching (opened 2026-06-16)
- [#64192](https://github.com/anthropics/claude-code/issues/64192): Task tools reminder fires repeatedly, needs suppression knob (opened 2026-05-31)
- [#59213](https://github.com/anthropics/claude-code/issues/59213): Tighten cadence of task tools reminder (closed, completed 2026-05-14)
- [DeepSeek Context Caching docs](https://api-docs.deepseek.com/guides/kv_cache)
- [DeepSeek Anthropic API docs](https://api-docs.deepseek.com/guides/anthropic_api)

## Finding new patterns

The cache-breaking behaviors we fix originate from Claude Code internals.
Anthropic does not test against third-party providers. With every Claude Code
update, new injection patterns may appear.

When a new cache drop pattern emerges:

1. **Search Claude Code issues**: `https://github.com/anthropics/claude-code/issues?q=<keyword>`
   - Key terms: "prompt cache", "system reminder", "billing header", "context injection"
2. **Search gists and forums**: GitHub Gist, Reddit r/ClaudeCode, Discord
3. **Read Claude Code changelogs**: look for new system prompts, auto-injections, or context management changes
4. **Classify first**: `python scripts/cache_report.py 60 --low-only`
5. **Diff request bodies**: `python scripts/analyze.py --dir <dir>` on consecutive request IDs
6. **Check DeepSeek API docs**: verify caching behavior hasn't changed on their side
7. **Compare tool inventories and order**: verify definitions already present in
   request N retain their relative order in request N+1; list additions and removals
8. **Check protocol pairing**: every assistant `tool_use.id` must have a following
   user `tool_result.tool_use_id`; never repair cache by crossing those identities

When you find a community-reported but unfixed issue (like #64192),
reference it in the extension code and in [`references/patterns.md`](.agents/skills/extension-dev/references/patterns.md).

## Upstream Claude Code change response

Claude Code system prompts, headers, tool availability, and message replay are
upstream implementation details. After every Claude Code upgrade, or whenever
a previously stable category regresses:

1. Record the Claude Code version and capture a database watermark before the
   reproduction. Analyze only rows created after that watermark.
2. Run a short stable-tool sequence and a dynamic-tool sequence. Verify the
   actual forwarded bodies; prompt text alone does not prove a tool appeared.
3. Diff headers, system blocks, tool arrays, and overlapping messages separately.
   Identify the first changed prefix component before changing an extension.
4. Search Anthropic changelogs and issues for new reminders, billing fields,
   deferred-tool behavior, compaction, or tool protocol changes.
5. Add a minimized trace-derived regression test before implementation. For
   stateful fixes, include concurrent-agent and changed-tool-ID cases.
6. Keep provider behavior scoped. DeepSeek-specific `cache_control` removal stays
   gated to DeepSeek; model-agnostic structural stabilization may remain ungated
   only when it preserves request semantics for every model.
7. Deploy through `scripts/setup.ps1`, require zero load failures, restart only
   the proxy, and compare token-weighted uncached tokens before and after.

For Codex Responses provider probes, run a deliberate tool-required prompt after
a DB watermark, then use
`python scripts/provider_report.py 30 --after-request-id <watermark> --expect-tool`.
The report is read-only. HTTP success without `custom_tool_call` is semantic
incompatibility only when the prompt explicitly required a tool; otherwise it is
`no-tool-call`.

If Anthropic changes tool names, tool schema shape, session/agent headers, or
the one-tool web-search request format, review `tool-order-hold` state-key and
request-family assumptions before expanding match rules. Unknown formats must
fail open rather than mutate request semantics.
