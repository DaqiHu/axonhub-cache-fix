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
Also require `scripts/runtime-health.ps1` to show no critical WAL/log condition.

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

## 4. Measure and diagnose with project scripts

```powershell
python scripts/cache_report.py 10 --after-request-id <watermark> --model "deepseek-v4-flash" --low-only
python scripts/cache_report.py 10 --after-request-id <watermark> --model "deepseek-v4-flash" --summary
python scripts/request_inspect.py <low-request-id> --compare-prev --neighbors 5
```

Acceptance is based on protocol correctness and token-weighted uncached tokens.
A stable-tool sequence should have a cold baseline followed by high-hit growth.
Classify every low row before treating it as failure:

- `tools-changed`, `top-system-changed`, or `history-changed`: investigate
- `appended-system`: inspect text with `request_inspect.py`; preserve meaningful content
- `large-growth`: measure new chars/tokens and confirm old native prefix is exact
- `clean-growth`: check timing and whether the next request recovers

Downloaded-body re-diff:

```powershell
python scripts/analyze.py --dir .\test-data "*Request_*.json"
```

The before/after report must include request IDs, watermark, model, channel,
classification, weighted cached/total tokens, uncached-token reduction, and any
protocol or upstream errors. Do not claim improvement from request-count averages.
