# Known cache-breaking patterns

Documented from real Claude Code + DeepSeek request traces.

## Pattern 1: billing header nonce (Issue #68900)

**Appearance**: First block in `system` array:
```json
{"type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.177.01c; cc_entrypoint=cli; cch=36ee5;"}
```

**Effect**: `cch=` value changes every request. Breaks entire prefix cache (0% hit).

**Fix**: `strip-billing-header` (order 85) — detects and removes the block.

## Pattern 2: cache_control token drift

**Appearance**: `cache_control` field present in request N, absent in request N+1 at same position. DeepSeek ignores it semantically but the raw JSON bytes differ.

**Effect**: Prefix match breaks at the position where cc was removed (25% hit).

**Fix**: `deepseek-cache-optimize` (order 48) — strips all cache_control from body.

**DeepSeek docs**: [Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api) — `cache_control: Ignored`.

## Pattern 3: text consumption

**Appearance**: User text message replaced by empty `[]` between requests:
```
Request N:   msg[124] = user [{type:"text", text:"再来2个"}]
Request N+1: msg[124] = user []   ← consumed!
```

**Effect**: Content at old position changes, breaking prefix match.

**Fix**: `prefix-hold` (order 46) — stores last user msg content per session,
restores it if the next request has different content at the same position.

## Pattern 4: field order variation

**Appearance**: Same semantic content, different JSON key order:
```
Request N:   { type: "tool_result", tool_use_id: "x", content: "42" }
Request N+1: { content: "42", type: "tool_result", tool_use_id: "x" }
```

**Effect**: Different raw bytes → token sequence differs → cache miss.

**Fix**: `prefix-hold` (order 46) — always restores content from stored copy,
which preserves the original field order via `JSON.parse(JSON.stringify(...))`.

## Pattern 5: task tools reminder injection (#64192, #60286, #59213)

**Appearance**: Claude Code injects system message every ~5 turns:
- Empty: `{"role": "system", "content": []}` — between new content blocks
- Contentful: `{"role": "system", "content": "The task tools haven't been used recently..."}` — as string
- Contentful array: `{"role": "system", "content": [{"type":"text","text":"The task tools..."}]}`

**Effect**: Adds tokens after last user input, shifting "end of user input" position
and breaking prefix match.

**Community**: [#64192](https://github.com/anthropics/claude-code/issues/64192) — fires repeatedly per long session, ~250 tokens per firing, no official suppression knob.

**Fix**: `strip-empty-system` (order 47) — removes:
- All empty system messages (any position)
- Contentful system messages after the last user message

## Pattern 6: content format churn

**Appearance**: Claude Code alternates content formats:
```json
{"role": "system", "content": "string form"}
{"role": "system", "content": [{"type":"text","text":"array form"}]}
```

**Effect**: Same as Pattern 4 — byte diff despite semantic equivalence.

**Fix**: All extensions must handle both string and array content types:
```js
function getContent(msg) {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content) && msg.content.length > 0) return msg.content[0].text;
  return null;
}
```

## Why ~25% is the floor

DeepSeek creates cache prefix units at "end of user input". When system messages
or other injections change the token count at the end of the conversation, the
absolute position of "end of user input" shifts. Even with byte-identical
overlapping content, the cache prefix unit key changes because the boundary
position differs.

This is unavoidable — DeepSeek's cache mechanism requires the prefix to fully match.
The 25% (system+tools only) recovers to 99.99% on the next request after the
injection, since the new boundary is now stable.
