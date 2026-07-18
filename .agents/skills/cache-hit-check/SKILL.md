---
name: cache-hit-check
description: "Use when checking AxonHub cache hit rate, scanning low-hit DeepSeek or multi-model rows, or monitoring prompt cache efficiency without writing ad-hoc SQL."
---

# Cache Hit Check

Use project scripts before raw SQL. Do not invent one-off sqlite snippets for routine
monitoring.

Default scope is `deepseek%` plus `anthropic/messages`, ordered by request creation
time with a 24-hour lookback for conversation state.

```powershell
python scripts/cache_report.py 60 --low-only
python scripts/cache_report.py 60 --summary
```

The summary is token-weighted:
`sum(cached_tokens) / sum(prompt_tokens)`. Never average request percentages.
`--summary` uses aggregate SQL and does not scan request bodies. `--low-only` loads
bounded bodies only when classification is required.

## Scope controls

```powershell
python scripts/cache_report.py 60 --model "deepseek-v4-flash" --low-only
python scripts/cache_report.py 60 --all-models --all-formats --low-only
python scripts/cache_report.py 10 --lookback 2880 --low-only
```

## Category meanings

| Category | Meaning |
|---|---|
| `cold-first` | New session/agent stream; expected cold prefix |
| `standalone-web-search` | Independent one-tool search worker |
| `large-growth` | Exact old prefix plus at least 8k serialized chars |
| `appended-system` | Exact old prefix plus meaningful or unknown system event |
| `tools-changed` | Tool list/order/schema changed; investigate |
| `top-system-changed` | Top-level system changed; investigate |
| `history-changed` | Earlier messages changed; investigate |
| `clean-growth` | Small exact-prefix growth; correlate with timing and next row |
| `high-hit` | At least 90% cached |

`appended-system` is not a removal instruction. Skills listing, mid-turn user
injection, repository instructions, file-change notices, and background-task events
must be preserved unless an approved bookkeeping prefix matches.

For one request ID, prefer:

```powershell
python scripts/request_inspect.py 22412 --compare-prev --neighbors 5
```

For provider tool compatibility after a deliberate tool-required prompt:

```powershell
python scripts/provider_report.py 30 --after-request-id <watermark> --expect-tool
```

Service health:

```powershell
scripts/start.ps1 -Status
scripts/runtime-health.ps1 -Json
```

Low-cache archive path, formula, and retention live in README.md under the
`low-cache-trace` extension notes.

## Code snippets

Channel-weighted hit rates and neighbor windows for new permanent metrics live in
`../session-analyze/references/db-snippets.md` sections 5–6. Prefer extending
`scripts/cache_report.py` or `scripts/request_inspect.py` over a throwaway query.
