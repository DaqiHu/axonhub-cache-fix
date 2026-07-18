---
name: cache-hit-debug
description: "Use when DeepSeek or other AxonHub channels show sporadic cache misses, a specific request ID needs root-cause triage, or Claude Code may have changed tools, system content, or history."
---

# Cache Hit Debug

Find the first changed prefix component before changing an extension. Prefer the
project inspectors over ad-hoc sqlite/python one-liners.

```powershell
scripts/start.ps1 -Status
scripts/runtime-health.ps1
python scripts/cache_report.py 60 --low-only
python scripts/request_inspect.py <request-id> --compare-prev --neighbors 5
```

For a bounded reproduction, add `--after-request-id <watermark>` to
`cache_report.py`; earlier lookback rows still seed conversation state but are
not printed.

## Workflow

1. Classify with `cache_report.py` so model/format scope is correct.
2. Inspect the low request and its previous same-channel/model neighbor with
   `request_inspect.py`.
3. Read `skills_listing_changed`, appended system `kind`, first semantic/raw
   changed message, and tools sameness before guessing.
4. Only if bodies need offline re-diff after download:
   `python scripts/analyze.py --dir .\test-data "*Request_*.json"`.
5. Correlate with `~/axonhub/logs/*.log` before proposing a mutation.

When the user reports HTTP errors rather than low-hit rows, check
`~/axonhub/logs/upstream-error-bodies.jsonl` first. `SQLITE_BUSY` identifies
AxonHub SQLite contention; do not restart cache-fix merely because AxonHub
returned HTTP 500.

## Decision table

| Evidence | Conclusion |
|---|---|
| Existing tools moved or changed | `tool-order-hold` candidate |
| Top-level system changed | Inspect billing header and upstream prompt changes |
| Historical message changed | `prefix-hold` candidate; verify tool IDs first |
| Approved deferred/task reminder | `strip-empty-system` should remove it |
| Skills listing newly appended/moved to tail | Meaningful `appended-system`; preserve; often DeepSeek-sensitive |
| Mid-turn user inject / background-task / worktree instructions | Meaningful `appended-system`; preserve |
| Skills listing position unchanged while another trailing system appears | Do **not** blame skills listing |
| Exact native prefix, large new tool result | Expected uncached growth/cache construction |
| Exact native prefix, immediate next request recovers | Transient provider cache visibility |

Known contrast:

- DeepSeek `#24772`: skills listing missing then re-appended at the last message.
- Kimi `#22412`: skills listing stayed at a fixed mid-history index; trailing
  mid-turn user inject caused the miss.

Never infer root cause from percentage alone. Never strip unknown system text to
raise a metric. Never write disposable analysis scripts for these checks while
`request_inspect.py` / `cache_report.py` / `analyze.py` cover the need.

## Code snippets

For assembling a new permanent check, reuse:

- `scripts/request_inspect.py` helpers via import
- `../session-analyze/references/db-snippets.md` for copy-paste building blocks
  (read-only DB open, system classification, first-change diff, neighbor hits)

Example import:

```python
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "request_inspect", Path("scripts/request_inspect.py")
)
request_inspect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(request_inspect)

# request_inspect.classify_system(text)
# request_inspect.load_request(conn, rid)
# request_inspect.compare(prev, curr)
```

## Extension logs

| File | Evidence |
|---|---|
| `prefix-hold.log` | Historical content restoration |
| `strip-trailing-empty-system.log` | Approved bookkeeping removals |
| `deepseek-cache-optimize.log` | DeepSeek `cache_control` stripping |
| `strip-billing-header.log` | Billing nonce removal |
| `tool-order-hold.log` | Tool baselines and reorder events |
| `upstream-error-bodies.jsonl` | AxonHub/provider error code and message |
| `supervisor.jsonl` | Child exit code and restart lifecycle |
