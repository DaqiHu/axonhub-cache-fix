---
name: extension-dev
description: "Use when adding or modifying an axonhub-cache-fix extension after a traced tools, system, header, or message-history mutation has been proven to break cache."
---

# Extension Development

An extension is justified only after the first changed prefix component is
proven with project scripts:

```powershell
python scripts/cache_report.py 60 --low-only
python scripts/request_inspect.py <request-id> --compare-prev --neighbors 5
python scripts/analyze.py --dir .\test-data "*Request_*.json"
```

`appended-system` alone is not a fix target. Skills listing, mid-turn user
injection, repository instructions, file-change notices, and background-task
events are semantic input and must be preserved. Unknown formats fail open.

An upstream error is also not an extension candidate until request mutation is
proven. Use `upstream-error-bodies.jsonl` and `supervisor.jsonl` to separate
AxonHub/provider failures from proxy exits.

## Contract

Every extension exports `default { name, description, order, onRequest }`, logs
to `$env:AXONHUB_CACHE_FIX_LOG_DIR`, has a focused test in `tests/`, and is
registered in `extensions/extensions.json`.

Response-observability extensions must be bounded, redact credential-shaped
keys, fail open, and never mutate the response body or status.

Stateful extensions must:

- key by session and agent; add model and request family when relevant
- isolate exact one-tool `web_search` workers
- preserve every `tool_use.id` / `tool_result.tool_use_id` pair
- never restore content across a changed tool ID
- never add, retain, or replace a tool definition absent from the current body
- include concurrent-agent and changed-tool-ID regression tests

## Order

| Order | Extension | Constraint |
|---:|---|---|
| 46 | `prefix-hold` | Sees original history positions |
| 47 | `strip-empty-system` | Removes only approved bookkeeping forms |
| 48 | `deepseek-cache-optimize` | Strips DeepSeek `cache_control` after stabilization |
| 85 | `strip-billing-header` | Removes billing nonce block |
| 200 | built-in sort | Deterministic current tool input |
| 210 | `tool-order-hold` | Preserves old relative order, appends current additions |
| 250 | fresh-session sort | Later normalization |

## TDD and deployment

1. Minimize a real trace into a failing regression test.
2. Implement one semantic-preserving mutation.
3. Run the focused test and `node tests/run-all.mjs`.
4. Run `scripts/setup.ps1`; require zero load failures.
5. Verify `scripts/start.ps1 -Status` and a fresh E2E watermark run.
6. Compare token-weighted uncached tokens, not average percentages.

Use `scripts/template.mjs` for the skeleton and `references/patterns.md` for
proven patterns. For Responses provider behavior, use
`python scripts/provider_report.py 30 --after-request-id <watermark> --expect-tool`
only after a deliberate tool-required probe.
