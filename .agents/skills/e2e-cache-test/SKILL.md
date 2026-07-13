---
name: e2e-cache-test
description: "End-to-end cache hit rate testing loop for axonhub-cache-fix. Use when the user wants to test cache performance, verify a fix, run a benchmark, or iterate on extensions. Trigger: test cache, run benchmark, e2e test, verify cache, quick test."
---

# End-to-End Cache Test

## Quick test loop

```
1. Restart cache-fix  →  scripts/start.ps1 (AxonHub skips if already running)
2. Run Claude Code    →  claude -p "quick test prompt"
3. Query DB           →  python scripts/cache_report.py
4. Diagnose drops     →  check extension logs, download request bodies
5. Fix & repeat       →  modify extension, goto 1
```

## Step 1: Restart cache-fix only

Kill and restart cache-fix without touching AxonHub:

```powershell
# Kill cache-fix
Get-Process -Name node -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*cache-fix*" } |
  Stop-Process -Force

# Restart (AxonHub already running → auto-skip)
scripts/start.ps1
scripts/start.ps1 -Status   # verify extensions: OK
```

## Step 2: Run test prompt

Minimal Claude Code prompt that triggers tool calls with text responses
(both tool-only and text-output patterns to verify cache handling):

```bash
claude -p "连续调6轮tool，尽量节约prompt，用 Bash (echo 1) (echo 2) 直到 6。每轮调用后说一句话。不要用其他工具。"
```

This produces alternating tool-call and text-response patterns.

For fastest iteration:
```bash
claude -p "echo 1-3 via Bash, each with a brief comment"
```

## Step 3: Query cache data

```bash
python -c "
import sqlite3
conn = sqlite3.connect(r'C:\Users\hudaq\axonhub\axonhub.db')
rows = conn.execute('''
    SELECT id, prompt_tokens, cached_tokens,
           ROUND(CAST(cached_tokens AS REAL)/prompt_tokens*100,1) as pct,
           created_at
    FROM usage_logs
    WHERE created_at > datetime('now', '-10 minutes')
    ORDER BY created_at
''').fetchall()
if not rows:
    print('No data in last 10 min')
else:
    for r in rows:
        flag = ' <<<' if r[3] < 90 else ''
        print(f'#{r[0]}: hit={r[2]}/{r[1]} ={r[3]:>5.1f}%{flag}')
conn.close()
"
```

Or use `scripts/cache_report.py`:
```bash
python scripts/cache_report.py
```

## Step 4: Expected results

| Request # | Expected hit rate | Meaning |
|-----------|-------------------|---------|
| 1 | 0-30% | Cold start — no cache yet |
| 2-6 | 99%+ | All subsequent should hit cache |
| Every ~5th | 25% then recover | System msg injection → strip-empty-system handles it |

If any request after #1 is below 90%, download the request bodies:

```bash
# Download from http://localhost:8090 → Tracing
# Save to Downloads/, then:
python scripts/analyze.py "*Request_*.json"
```

## Step 5: Iterate

After modifying an extension:
1. Restart cache-fix (Step 1)
2. Re-run test (Step 2)
3. Check results (Step 3)
4. Compare: did the low-hit pattern change?

## Before/after comparison

After a fix, compare the request count of <90% hits:

```python
# Before fix
>>> 6 requests: [99%, 25%, 99%, 25%, 99%, 25%]  # 3 drops

# After fix
>>> 6 requests: [30%, 99%, 99%, 99%, 99%, 99%]  # 1 cold start only
```

The goal: only the first request (cold start) should miss cache. All others at 99%+.
