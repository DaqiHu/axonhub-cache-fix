---
name: cache-hit-debug
description: "Use when DeepSeek cache hit rate drops, AxonHub shows sporadic cache misses, or a Claude Code request may have changed tools, system content, or message history."
---

# Cache Hit Debug

Find the first changed prefix component before changing an extension.

```powershell
scripts/start.ps1 -Status
scripts/runtime-health.ps1
python scripts/cache_report.py 60 --low-only
```

For a bounded reproduction, add `--after-request-id <watermark>`; earlier
lookback rows still seed conversation state but are not printed.

The default report excludes foreign models and non-Anthropic formats, orders by
`requests.created_at`, and uses lookback rows only as classifier state.

## Workflow

1. Record request ID, session, agent, model, format, channel, and request time.
2. Inspect the classified row and its adjacent request in AxonHub tracing.
3. Compare forwarded Anthropic bodies and native execution bodies.
4. Check tools, top-level `system`, overlapping messages, and appended messages
   separately.
5. Correlate with `~/axonhub/logs/*.log` before proposing a mutation.

When the user reports HTTP errors rather than low-hit rows, check
`~/axonhub/logs/upstream-error-bodies.jsonl` first. It contains bounded,
redacted non-2xx JSON bodies. `database is locked` / `SQLITE_BUSY` identifies
AxonHub SQLite contention; `supervisor.jsonl` and child stderr determine whether
a process also exited. Do not restart cache-fix merely because AxonHub returned
HTTP 500.

Downloaded bodies can live anywhere:

```powershell
python scripts/analyze.py --dir .\test-data "*Request_*.json"
```

The analyzer sorts by numeric request ID and reports tool additions/removals,
exact history growth, appended system count, and serialized growth size.

## Decision table

| Evidence | Conclusion |
|---|---|
| Existing tools moved or changed | `tool-order-hold` candidate |
| Top-level system changed | Inspect billing header and upstream prompt changes |
| Historical message changed | `prefix-hold` candidate; verify tool IDs first |
| Approved deferred/task reminder | `strip-empty-system` should remove it |
| Repository instructions, file diff notice, background-task event | Meaningful `appended-system`; preserve it |
| Exact native prefix, large new tool result | Expected uncached growth/cache construction |
| Exact native prefix, immediate next request recovers | Transient provider cache visibility |

DeepSeek documents that cache construction takes seconds. A request launched a
few hundred milliseconds after a large append can temporarily reuse only older
prefix units even when the native request is an exact extension. A proxy cannot
repair that after the response; adding a blanket delay would hurt latency and
still provide no guarantee.

Extension logs:

| File | Evidence |
|---|---|
| `prefix-hold.log` | Historical content restoration |
| `strip-trailing-empty-system.log` | Approved bookkeeping removals |
| `deepseek-cache-optimize.log` | DeepSeek `cache_control` stripping |
| `strip-billing-header.log` | Billing nonce removal |
| `tool-order-hold.log` | Tool baselines and reorder events |
| `upstream-error-bodies.jsonl` | AxonHub/provider error code and message |
| `supervisor.jsonl` | Child exit code and restart lifecycle |

Never infer root cause from percentage alone. Never strip unknown system text to
raise a metric.
