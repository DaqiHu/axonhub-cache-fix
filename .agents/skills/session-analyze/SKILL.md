---
name: session-analyze
description: "Use when comparing AxonHub request traces, locating the first cache-breaking prefix change, or explaining low-hit Claude Code conversation transitions."
---

# Session Analyze

Start with the database classifier so request selection is model- and
format-correct:

```powershell
python scripts/cache_report.py 60 --low-only
```

If the client received HTTP 4xx/5xx, correlate the request time with
`~/axonhub/logs/upstream-error-bodies.jsonl` before diffing successful bodies.
An AxonHub `SQLITE_BUSY` may prevent a trace/usage row from being committed and
is not evidence of a cache prefix mutation.

When reproducing, add `--after-request-id <watermark>` so only new rows print
while pre-watermark lookback still seeds stream state.

In AxonHub, download both views for adjacent suspicious request IDs:

- Tracing / Requests: Anthropic body after cache-fix.
- Request Execution: native body sent to the provider.

Save files anywhere and pass the directory explicitly:

```powershell
python scripts/analyze.py --dir .\test-data "*Request_*.json"
```

The analyzer sorts by numeric request ID, not file mtime. It reports model,
format, message/system/tool counts, exact history prefix, tool additions and
removals, appended system messages, and serialized growth chars.

Interpret comparisons in this order:

1. `tools_same`: if false, inspect order, names, and schemas.
2. `top_system_same`: if false, inspect billing nonce and upstream system drift.
3. `history_prefix`: if false, locate `first_msg` and verify tool identities.
4. `appended_system`: inspect exact text. Approved reminder prefixes may be
   removed; repository instructions, file-change notices, and background-task
   notifications must be preserved.
5. Exact prefix plus large growth: expected new content/cache construction, not
   automatically an extension regression.

Cache formulas differ by response family:

- Anthropic: `cache_read_input_tokens / (cache_read_input_tokens + cache_creation_input_tokens + input_tokens)`.
- OpenAI: `cached_tokens / prompt_tokens`.

Do not use the old ambiguous formula or infer a cache break from raw JSON key
order alone. Provider caching depends on the translated token prefix; compare
the native execution when the forwarded body appears stable.
