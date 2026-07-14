---
name: cache-hit-check
description: "Use when checking AxonHub cache hit rate, identifying low-hit DeepSeek requests, or monitoring prompt cache efficiency without mixing models or request formats."
---

# Cache Hit Check

Use the classified report before raw SQL. Its default scope is
`deepseek%` plus `anthropic/messages`, ordered by request creation time with a
24-hour lookback for conversation state.

```powershell
python scripts/cache_report.py 60 --low-only
python scripts/cache_report.py 60 --summary
```

The summary is token-weighted:
`sum(cached_tokens) / sum(prompt_tokens)`. Never average request percentages.
It uses aggregate SQL and does not scan request bodies, so use it for frequent
monitoring. `--low-only` loads bounded request bodies only when classification
is required.

## Scope controls

```powershell
# One model or family (SQLite LIKE syntax)
python scripts/cache_report.py 60 --model "deepseek-v4-flash" --low-only

# Explicit cross-model investigation; never silently mix this with DeepSeek
python scripts/cache_report.py 60 --all-models --all-formats --low-only

# Extend state history when a long-idle conversation resumed
python scripts/cache_report.py 10 --lookback 2880 --low-only
```

Interpret categories before calling a row a regression:

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

`appended-system` is not a removal instruction. Repository instructions, file
change notices, and background-task completion/failure events must be preserved.

For provider tool compatibility, run a deliberate tool-required prompt, record
the DB watermark, then use the read-only report:

```powershell
python scripts/provider_report.py 30 --after-request-id <watermark> --expect-tool
```

Without `--expect-tool`, a completed response with no tool call is reported as
`no-tool-call`, not as incompatibility. The script never sends paid requests.

Service and storage health are available through either command:

```powershell
scripts/start.ps1 -Status
scripts/runtime-health.ps1 -Json
```

If cache rows disappear while clients receive errors, inspect
`~/axonhub/logs/upstream-error-bodies.jsonl`; a relayed `SQLITE_BUSY` belongs to
AxonHub's database layer rather than cache-fix's cache transformations.

## Low-cache request archive

Requests with a hit rate strictly below 80% are recorded to
`~/axonhub/logs/low-cache-requests/YYYY-MM-DD.jsonl` (UTC daily files) by the
`low-cache-trace` extension (order 900, gated by `CACHE_FIX_LOW_CACHE_TRACE=on`).
The archive is fail-open and retains 7 days of records. See README.md for the
formula, retention variables, inspection commands, and native-translation
limitation.
