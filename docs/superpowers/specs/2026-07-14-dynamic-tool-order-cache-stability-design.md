# Dynamic Tool-Order Cache Stability

## Goal

Reduce catastrophic DeepSeek prompt-cache misses when Claude Code makes new
tools available during an active conversation. Preserve request semantics:
the extension may reorder the tools already present in a request, but must
never add, remove, rename, or modify a tool definition.

Also make the cache report distinguish real conversation-prefix changes from
standalone web-search requests, new-agent cold starts, and ordinary context
growth.

## Evidence

Recent AxonHub traces showed three deterministic tool-set transitions:

| Requests | Tool change | Cache hit after change |
|---|---|---:|
| `2765 -> 2767` | add `SendMessage` | 1.6% |
| `2771 -> 2775` | add `WebFetch`, `WebSearch` | 9.3% |
| `2813 -> 2814` | add `EnterWorktree`, `ExitWorktree` | 5.1% |

In every case the existing `sort-stabilization` extension alphabetized the
whole tool array. A newly available tool was inserted before existing tools,
changing a large suffix of the serialized tool definitions even though all
previously available definitions were byte-identical.

The same two-hour window contained other low-hit records with different
causes:

- 17 standalone one-message `web_search` requests on channel 8;
- 9 first requests from newly created subagents;
- 30 clean conversation-growth requests where large new tool results or
  provider cache-construction timing reduced the percentage;
- 26 requests at or above 90%, with a weighted hit rate of 95.9%.

Only the three dynamic tool-order transitions are directly addressable by a
request-body extension without inventing unavailable tools or delaying calls.

## Selected Design

### `tool-order-hold` Extension

Add `extensions/tool-order-hold.mjs` at order 210, after the built-in
`sort-stabilization` extension (order 200) and before `fresh-session-sort`
(order 250).

The extension keeps an in-memory prior tool-name order for each logical
request stream. On each request:

1. Validate that `body.tools` is an array whose entries have unique,
   non-empty string names. Invalid or duplicate names fail open with no body
   mutation.
2. Resolve a state key from:
   - `x-claude-code-session-id`;
   - `x-claude-code-agent-id`, falling back to `main`;
   - `body.model`;
   - request family.
3. Classify a request whose exact tool-name list is `web_search` as the
   `web-search` family. All other requests use the `conversation` family.
   This prevents standalone web-search calls from replacing the main
   conversation's order state even when Claude Code reuses the same agent ID.
4. Keep currently present tools that existed in the prior order in that prior
   relative order.
5. Append newly present tools in their current deterministic order.
6. Replace `body.tools` only when the resulting name order differs, then store
   the resulting order for the next request.

The current tool objects are always reused. Schema changes under an existing
name remain current; the extension owns ordering only.

### State And Failure Behavior

State is process-local and intentionally not persisted. After a proxy restart,
the first request establishes a new baseline and may use the alphabetized
order. This limits stale-state risk and matches the existing `prefix-hold`
operational model.

Requests without a session ID fail open. Agent, model, and request-family
partitioning prevents unrelated conversations and internal request streams
from influencing each other.

Every baseline, reorder, and validation skip is logged to
`$AXONHUB_CACHE_FIX_LOG_DIR/tool-order-hold.log`.

### Runtime Integration

- Register `tool-order-hold` as enabled at order 210 in
  `extensions/extensions.json`.
- Add it to the required-extension list in `scripts/validate-runtime.mjs` so
  setup and startup fail closed if it cannot load.
- Add its isolated test suite to `tests/run-all.mjs`.
- Keep the globally installed cache-fix package unchanged; repository setup
  overlays the custom extension into `~/axonhub/extensions`.

### Cache Reporting

Extend `scripts/cache_report.py` without removing legacy schema support.

When the current AxonHub `requests` table and required columns are available,
join recent usage rows to request headers and bodies and classify each row as:

- `standalone-web-search`;
- `cold-first`;
- `tools-changed`;
- `system-changed`;
- `history-changed`;
- `clean-growth`;
- `high-hit`.

The report must show both request counts and token-weighted hit rates. The
existing basic output remains available when request metadata is unavailable,
including legacy test schemas.

The report must not label every sub-50% request as `SYSTEM INJECTION`; that
label is not supported by the current evidence.

## Safety Boundaries

- Do not inject a remembered tool that is absent from the current request.
- Do not suppress a newly available tool.
- Do not change tool schemas, descriptions, cache-control fields, or tool
  choice.
- Do not change AxonHub channel enablement, weights, credentials, or model
  routing.
- Do not attempt to make standalone web-search requests look like main
  conversation cache hits.
- Preserve the existing session-and-agent isolation and tool-result pairing
  protections in `prefix-hold`.

## Testing

Implementation follows red-green-refactor.

### Extension Unit Tests

Use request shapes derived from the observed traces and prove:

1. The first request establishes its current order unchanged.
2. Adding `SendMessage` appends it after the prior nine tools.
3. Adding `WebFetch` and `WebSearch` appends both without moving prior tools.
4. Adding `EnterWorktree` and `ExitWorktree` appends both without moving prior
   tools.
5. Current tool objects and schemas are preserved exactly.
6. Different agents, models, and request families have independent state.
7. A removed and later reappearing tool is treated as new and appended.
8. Missing session IDs, missing names, and duplicate names fail open.

### Reporting Tests

Retain current and legacy cache-column tests. Add a current-schema fixture
with `requests` metadata that covers standalone web search, cold first,
tool-set change, clean growth, and high hit. Verify count and token-weighted
summaries.

### Full And Runtime Tests

- Run the isolated extension test and observe it fail before implementation.
- Run `node tests/run-all.mjs` after implementation.
- Run `scripts/setup.ps1` against `~/axonhub` and require zero extension-load
  failures.
- Restart only the cache-fix proxy and confirm `/health` is OK.

## Real E2E Verification

Use `claude -p` with model `deepseek-v4-flash` and short prompts that require
real sequential tool calls. Record the newest `usage_logs.id` before each run
and evaluate only rows created by that run.

Run two workloads:

1. A short stable-tool baseline using three sequential Bash calls.
2. A dynamic-tool workload that causes Claude Code to expose and use an
   additional tool after the conversation has started. Prefer built-in tools
   that are reliably available in the installed Claude Code version; verify
   the actual forwarded tool-name transition in AxonHub rather than assuming
   the prompt caused it.

For each workload report:

- prompt tokens, cached tokens, and hit percentage per request;
- total prompt tokens and total uncached tokens;
- tool-name transitions in the forwarded requests;
- whether any assistant/tool-result protocol error occurred.

Acceptance requires:

- no tool definitions added or removed by the extension;
- prior tool relative order preserved when new tools appear;
- the full automated suite and runtime validation pass;
- no new 400 tool-call pairing errors;
- measured uncached-token consumption for a reproduced dynamic-tool
  transition is lower than the pre-fix trace or a controlled before/after run.

If Claude Code does not expose a new tool during the short live run, report
that limitation and use replay of the captured request shapes as the
deterministic proof. Do not claim live savings without matching live evidence.

## Non-Goals

- Guaranteeing 99% hit rate for every subagent turn.
- Hiding expected cold starts or large newly generated tool results.
- Repairing cache behavior inside third-party channel 3 or channel 8.
- Disabling the low-cache channel 8 web-search path without a separate routing
  decision.
- Persisting tool-order state across proxy restarts.
