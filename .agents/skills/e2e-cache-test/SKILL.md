---
name: e2e-cache-test
description: "Use when benchmarking axonhub-cache-fix, verifying a cache change with real Claude Code tool calls, or comparing DeepSeek uncached token consumption before and after a fix."
---

# End-to-End Cache Test

Use a database watermark and one model/request family per run. Do not evaluate a
DeepSeek change from a report that also contains Codex or other providers.

## 1. Verify runtime

```powershell
scripts/start.ps1 -Status
```

Require runtime `VALID`, zero extension load failures, and proxy `/health: ok`.
Restart only the proxy when deployment requires it; its in-memory state then
starts from a new baseline.

Also require `scripts/runtime-health.ps1` to show no critical WAL/log condition.
After a run, inspect `~/axonhub/logs/upstream-error-bodies.jsonl` for new non-2xx
records. A benchmark with upstream errors is invalid even if later requests
recover.

## 2. Record the watermark

```powershell
python -c "import sqlite3,pathlib; c=sqlite3.connect(pathlib.Path.home()/'axonhub'/'axonhub.db'); print(c.execute('select coalesce(max(id),0) from requests').fetchone()[0])"
```

## 3. Run a short real-tool workload

```powershell
claude -p --model deepseek-v4-flash "Use Bash serially three times: echo 1, echo 2, echo 3. Wait for each result before the next."
```

Use a fresh session for before/after comparisons. Keep prompt, model, tool
sequence, proxy state, and provider channel constant.

## 4. Measure and diagnose

```powershell
python scripts/cache_report.py 10 --after-request-id <watermark> --model "deepseek-v4-flash" --low-only
python scripts/cache_report.py 10 --after-request-id <watermark> --model "deepseek-v4-flash" --summary
```

Acceptance is based on both protocol correctness and token-weighted uncached
tokens. A stable-tool sequence should have a cold baseline followed by high-hit
growth. A row may legitimately be lower when Claude Code appends a large tool
result, repository instructions, a file-change notice, or a background-task
event; classify it before treating it as failure.

For every low row after the watermark:

- `tools-changed`, `top-system-changed`, or `history-changed`: investigate.
- `appended-system`: inspect text; preserve meaningful/unknown content.
- `large-growth`: measure new chars/tokens and confirm old native prefix is exact.
- `clean-growth`: check request timing and whether the next request recovers.

Download suspicious adjacent bodies and run:

```powershell
python scripts/analyze.py --dir .\test-data "*Request_*.json"
```

The before/after report must include request IDs, watermark, model, channel,
classification, weighted cached/total tokens, uncached-token reduction, and any
protocol or upstream errors. Do not claim improvement from request-count
averages. For a quick aggregate, `--summary` does not scan request bodies;
classification still requires the detailed `--low-only` report.

## Low-cache request archive

Requests with a hit rate strictly below 80% are recorded to
`~/axonhub/logs/low-cache-requests/YYYY-MM-DD.jsonl` (UTC daily files) by the
`low-cache-trace` extension (order 900, gated by `CACHE_FIX_LOW_CACHE_TRACE=on`).
The archive is fail-open and retains 7 days of records. See README.md for the
formula, retention variables, inspection commands, and native-translation
limitation.
