---
name: session-analyze
description: "Download and analyze AxonHub request traces to understand Claude Code conversation patterns and cache behavior. Use when comparing request bodies, finding cache-breaking patterns, or diagnosing low cache hit rates."
---

# Session Analyze

Download, compare, and diagnose AxonHub request traces to understand
cache hit patterns.

## Downloading

1. Open http://localhost:8090
2. Tracing → Requests: shows Anthropic-format bodies (what cache-fix modifies)
3. Tracing → Request Execution: shows native format (what DeepSeek receives)
4. Click a request → download body JSON
5. Save to any directory (e.g., `test-data/` or Downloads)

For cache hit rates, prefer Execution view — response includes
`cached_tokens` in native format.

## Analysis script

`scripts/analyze.py` processes downloaded request bodies:

```bash
# Analyze specific request files
python scripts/analyze.py "*Request_17*.json"

# Find and analyze the newest files automatically
python scripts/analyze.py
```

Output shows:
- Message counts, cache_control count, trailing system count
- Last 4 messages for context
- Byte-level comparison between consecutive requests
- First message diff position (None = all overlapping msgs identical)

## Finding the newest files

The script searches the directory for request IDs and sorts by number.
Newest = highest number not yet analyzed.

```bash
# Find request IDs
python -c "
from pathlib import Path
import re
all = []
for f in Path('.').glob('*axonhub*Request*body*'):
    m = re.search(r'(\d+)', f.stem.split('_')[-1])
    if m: all.append((int(m.group(1)), f))
for n, f in sorted(all, reverse=True)[:10]:
    print(n, f.name)
"
```

## Interpreting analysis output

### Before/after verification

After deploying a fix, download the same request range and compare:

```
Before (old extension):
  1766: cc=0 trailing_sys=1  ← system msg still present
  first_msg=None  ← content identical, but cache still dropped

After (new extension):
  1766: cc=0 trailing_sys=0  ← system msg removed!
  first_msg=None  ← content match improved, cache should hit
```

### Cache hit rate mapping

| Pattern | Meaning |
|---------|---------|
| `cc=0` | cache_control stripped correctly |
| `cc>0` | deepseek-cache-optimize not working |
| `trailing_sys=0` | empty system messages removed |
| `trailing_sys>0` | Claude Code injected system msg, extension missed it |
| `first_msg=None` | All overlapping messages byte-identical |
| `first_msg=N` | Content changed at position N between requests |
| `first_byte=X%` | Raw byte prefix match percentage |

### Common patterns to investigate

1. **first_msg at session growth point**: Normal — new messages added at end.
   Cache should still hit for the overlapping prefix.

2. **first_msg inside old content**: Claude Code modified historical messages.
   Check if prefix-hold should have restored this position.

3. **system msg in tail**: Check `strip-empty-system.log` to confirm it was removed.
   If the log shows no removal but trailing_sys>0, the extension missed a format variant.

4. **content format change**: Claude Code varies `content` between string and array.
   Extensions must handle both: `typeof msg.content === "string"` vs `Array.isArray(msg.content)`.
