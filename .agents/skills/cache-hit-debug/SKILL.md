---
name: cache-hit-debug
description: Investigate DeepSeek cache hit rate through AxonHub logs
  and tracing data. Use when cache hit rate drops below 99%, when
  the user mentions "cache miss", "prompt caching", or wants to
  understand why a specific request had low cache hit.
---

# Cache Hit Debug

Diagnose DeepSeek cache hit rate drops in the AxonHub + cache-fix pipeline.

## Quick diagnostic

```bash
# Check current service status (includes extension health)
scripts/start.ps1 -Status

# Tail extension logs to see what's being stripped/modified
tail -f $env:LOCALAPPDATA\axonhub-cache-fix\logs\*.log

# Check cache-fix debug log for recent requests
tail -50 ~/.claude/cache-fix-debug.log
```

## Data sources

### 1. AxonHub tracing — most accurate
Open http://localhost:8090 → Tracing → Requests.
Each request shows the Anthropic-format body and response.
Response `usage` contains `cache_read_input_tokens` and `input_tokens`.

```
cache_read_input_tokens: 49664  ← tokens served from cache
input_tokens: 99               ← tokens processed fresh
hit rate ≈ cache_read / (cache_read + input) ≈ 99.8%
```

Download request bodies and analyze:

```bash
python scripts/analyze.py
```

### 2. Execution tracing — what DeepSeek actually received
Request Execution view shows the native/OAI format body after AxonHub
translation. Response contains `cached_tokens` in OpenAI format.

### 3. Extension logs — what our proxy modified
All logs at `$env:LOCALAPPDATA\axonhub-cache-fix\logs\`:

| Log | Extension | What it tracks |
|-----|-----------|----------------|
| `prefix-hold.log` | order 46 | Content restored/stabilized |
| `strip-empty-system.log` | order 47 | System messages removed |
| `deepseek-cache.log` | order 48 | cache_control fields stripped |
| `strip-billing-header.log` | order 85 | Billing headers removed |

### 4. cache-fix debug log
`~/.claude/cache-fix-debug.log` (requires `CACHE_FIX_DEBUG=1`)

## Diagnosis workflow

1. **Identify low-hit requests**: AxonHub Tracing → sort by date, find <90% hit
2. **Download body**: Save request-body JSON to `test-data/`
3. **Compare consecutive requests**: `python scripts/analyze.py`
4. **Check key metrics**:
   - `cc=0` — cache_control stripped correctly? If not, deepseek-cache-optimize may have failed
   - `trailing_sys=0` — empty system messages removed? If not, strip-empty-system may have missed a format variant
   - `first_msg=None` — overlapping messages byte-identical? If not, content differs between requests
   - `first_byte=X%` — raw byte prefix match percentage
5. **Cross-reference with extension logs**: Did the relevant extension run at the expected time?

## Known patterns → fix mapping

| Observe | Root cause | Extension responsible |
|---------|-----------|----------------------|
| billing header in system array | Nonce `cch=` changes per request | strip-billing-header |
| `cache_control` fields present | JSON diff breaks DeepSeek prefix | deepseek-cache-optimize |
| user text replaced by empty `[]` | Claude Code "eats" previous turn text | prefix-hold |
| system msg injected every ~5 turns | Task tools reminder (#64192) | strip-empty-system |
| ~25% hit despite clean prefix | DeepSeek cache boundary at end-of-user-input | Expected (recovers next request) |
