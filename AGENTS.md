# axonhub-cache-fix development guide

## Prerequisites

- **AxonHub** running on `:8090` (default install: `~/axonhub/axonhub.exe`)
- **cache-fix proxy** installed globally: `npm install -g claude-code-cache-fix`
  (default: `%APPDATA%/npm/node_modules/claude-code-cache-fix/`)
- **Extensions runtime** under `~/axonhub/` (shared with AxonHub; `setup.ps1` populates it)

## Architecture

```
Claude Code → cache-fix proxy (:9801) → AxonHub (:8090) → DeepSeek API
                  ↑ extensions run here
```

Extensions process Anthropic-format `/v1/messages` request bodies in order.
Modified body is forwarded to AxonHub, which translates to native DeepSeek
format and sends to `api.deepseek.com`.

## Extension development

### Order matters
Extensions run at fixed `order` positions. Lower = earlier.

Critical ordering:
- **46-48**: Content stabilization (prefix-hold, strip-empty-system, cc-strip)
  Must run BEFORE cache-control removal so they see original cc positions.
- **85**: Billing header removal (can run after cc strip)

### Extension template

See `scripts/template.mjs` for the standard extension skeleton.
All extensions must:
- Export `default { name, description, order, onRequest }`
- Log changes to `$env:AXONHUB_CACHE_FIX_LOG_DIR` (default `~/axonhub/logs/`)
- Include unit tests in `tests/`

### Adding an extension
1. Create `extensions/<name>.mjs` with the template
2. Add unit tests in `tests/test-<name>.mjs`
3. Register in `extensions/extensions.json` with order
4. Run `node tests/run-all.mjs` to verify

### Debugging
- Extension logs: `~/axonhub/logs/*.log`
- cache-fix debug log: `~/.claude/cache-fix-debug.log` (requires `CACHE_FIX_DEBUG=1`)
- Proxy stderr: `~/axonhub/logs/cache-fix-stderr.log`
- AxonHub request traces: `http://localhost:8090` → Tracing tab

## Testing against real requests

### Downloading request bodies
1. Open AxonHub dashboard: http://localhost:8090
2. Go to Tracing → Requests
3. Click a request → download body as JSON
4. Save to `test-data/` directory

### Analyzing with Python
```bash
python scripts/analyze.py "*Request_*.json"
```

Key diagnostics:
- `cc=0` confirms cache_control stripping works
- `trailing_sys=0` confirms system message removal
- `first_msg=None` means all overlapping msgs byte-identical
- `first_byte=X%` shows prefix match percentage

## Cache hit rate investigation

### Where to find cache data
1. **AxonHub SQLite DB** → `~/axonhub/axonhub.db`, table `usage_logs`:
   - `prompt_tokens` (col 5) and `cached_tokens` (col 9) give hit rate
   - `format` (col 18) = `"anthropic/messages"` for Anthropic requests
   - Query: `SELECT prompt_tokens, cached_tokens FROM usage_logs ORDER BY created_at DESC LIMIT 10`
2. **request_executions** table → `response_body` JSON has `prompt_tokens_details.cached_tokens`
3. **AxonHub tracing** → Response body has `usage.cache_read_input_tokens`
4. **cache-fix debug log** → `~/.claude/cache-fix-debug.log` (requires `CACHE_FIX_DEBUG=1`)

### Known cache drop patterns

| Symptom | Root cause | Fix extension |
|---------|-----------|---------------|
| 0% hit, billing header present | `cch=` nonce changes every request | strip-billing-header |
| ~25% hit on injection requests | System msg or cc field difference | strip-empty-system + cc-optimize |
| ~82% hit after injection | prefix-hold restored most but some boundary change | prefix-hold (partial) |
| 99.99% hit | Clean state | — |

### Why some drops are unavoidable
DeepSeek creates cache prefix units at "end of user input". Claude Code
periodically injects system reminders (~every 5 turns). If a meaningful
system message appears before the last user message, it can't be deleted
without changing conversation semantics. The 25% → 99% recovery happens
automatically on the next request.

## Conversation patterns observed

### Claude Code message formats
- User text: `{role:"user", content:[{type:"text",text:"..."}]}` OR `{role:"user", content:"..."}` (string)
- Tool result: `{role:"user", content:[{type:"tool_result",...}]}`
- Assistant: `{role:"assistant", content:[{type:"thinking",...},{type:"tool_use",...}]}`
- Empty system: `{role:"system", content:[]}`
- System reminder: `{role:"system", content:"The task tools haven't been used recently..."}`

### Content format variations
Claude Code varies string vs array format for `content` between requests.
Extensions must handle both.

## DeepSeek API notes

- Anthropic base URL: `https://api.deepseek.com/anthropic`
- `cache_control`: **Ignored** (per docs) but JSON field differences still break caching
- Context caching: automatic, prefix-based, requires **full match** of cache prefix unit
- Cache prefix units: at end of user input, end of model output, fixed intervals
- "Cache construction takes seconds" (per docs)
- Rate limits don't affect caching

## Community references

- [#68900](https://github.com/anthropics/claude-code/issues/68900): Billing header nonce breaks prefix caching (opened 2026-06-16)
- [#64192](https://github.com/anthropics/claude-code/issues/64192): Task tools reminder fires repeatedly, needs suppression knob (opened 2026-05-31)
- [#59213](https://github.com/anthropics/claude-code/issues/59213): Tighten cadence of task tools reminder (closed, completed 2026-05-14)
- [DeepSeek Context Caching docs](https://api-docs.deepseek.com/guides/kv_cache)
- [DeepSeek Anthropic API docs](https://api-docs.deepseek.com/guides/anthropic_api)
