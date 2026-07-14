# Low-Cache Request Archive Design

## Goal

Preserve only cache-fix requests whose measured Anthropic prompt-cache hit rate
is below 80%, so AxonHub request-body tracing can be disabled without losing the
request bodies needed for cache investigations.

## Data Flow

`low-cache-trace` runs at order 900, after every current request mutator. Its
`onRequest` hook deep-copies the final Anthropic body and captures only selected
correlation values from headers. The same request-scoped `meta` reaches
`onResponseStart`, `onStreamEvent`, and `onResponse`.

For streaming responses, usage is read from the `message_start` event. For
non-streaming responses, usage is read from the parsed response body. A request
is eligible only when the usage object explicitly contains an Anthropic cache
field. The hit rate is:

```text
cache_read_input_tokens /
(input_tokens + cache_creation_input_tokens + cache_read_input_tokens)
```

The request is written only when the denominator is positive and the rate is
strictly below 80%. Each request is written at most once.

## Storage Contract

Records are appended to:

```text
~/axonhub/logs/low-cache-requests/YYYY-MM-DD.jsonl
```

Each JSON object contains schema version, UTC timestamp, response status,
request ID, session ID, agent ID, model, usage counts, hit percentage, and the
complete post-extension request body. Authorization, API keys, cookies, and
other general request headers are never stored.

Writes are serialized inside the proxy process so concurrent agents cannot
interleave JSONL records. Logging is fail-open and never mutates or delays a
provider response beyond the awaited local append operation.

## Retention And Configuration

The archive is enabled by the supervisor and defaults to:

- `CACHE_FIX_LOW_CACHE_TRACE=on`
- `CACHE_FIX_LOW_CACHE_TRACE_THRESHOLD=80`
- `CACHE_FIX_LOW_CACHE_TRACE_RETENTION_DAYS=7`
- `CACHE_FIX_LOW_CACHE_TRACE_DIR=~/axonhub/logs/low-cache-requests`

Retention sweeps are throttled and delete only expired daily JSONL files. The
runtime health command reports the aggregate archive size but does not delete
or rewrite records.

## Boundaries

The archive contains the final Anthropic body sent from cache-fix to AxonHub.
It cannot observe AxonHub's translated native DeepSeek request. Disabling
AxonHub request-body tracing therefore preserves Claude Code/cache-fix prefix
evidence but gives up translation-layer body evidence.

No record is written when usage is absent, cache fields are absent, prompt
total is zero, the response is unsuccessful, or hit rate is at least 80%.

## Verification

Unit tests cover the 80% boundary, streaming and non-streaming usage, exact
request-body capture, sensitive-header exclusion, once-only writes, concurrent
JSONL integrity, seven-day cleanup, and fail-open I/O. Deployment requires
zero extension load failures and a real fresh `deepseek-v4-flash` Claude tool
request that produces a parseable low-cache JSONL record.
