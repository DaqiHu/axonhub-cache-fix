---
name: session-analyze
description: "Use when comparing specific AxonHub request IDs, locating the first cache-breaking prefix change, or explaining a low-hit Claude Code transition without writing ad-hoc DB scripts."
---

# Session Analyze

Start with the DB classifiers and inspectors. Do not re-implement request loading,
skills-listing detection, or adjacent hit-rate windows by hand.

```powershell
python scripts/cache_report.py 60 --low-only
python scripts/request_inspect.py 22412 --compare-prev --neighbors 8
python scripts/request_inspect.py 24771 24772
```

`request_inspect.py` reports:

- usage hit rate and body size
- system message kinds (`skills-listing`, `mid-turn-user-inject`, worktree, etc.)
- skills listing positions and whether they changed vs the previous request
- first raw vs semantic changed message index
- `cache_control`-only diffs
- appended roles/kinds when history is an exact prefix

If the client received HTTP 4xx/5xx, correlate time with
`~/axonhub/logs/upstream-error-bodies.jsonl` before diffing successful bodies.

When bodies are already downloaded:

```powershell
python scripts/analyze.py --dir .\test-data "*Request_*.json"
```

Interpret comparisons in this order:

1. `tools_same` / tools added/removed/order
2. `top_system_same`
3. `history_prefix` and first changed message
4. `skills_listing_changed` and appended system `kind`
5. exact prefix plus large growth: expected new content/cache construction

Skills listing is one `appended-system` subtype, not the default explanation for
every low-hit row. A stable mid-history listing plus a new trailing system means
something else broke the prefix.

Cache formulas:

- Anthropic: `cache_read / (cache_read + cache_creation + input)`
- OpenAI: `cached_tokens / prompt_tokens`

Provider caching depends on the translated token prefix; compare the native
execution when the forwarded body appears stable.

## Code snippets for new checks

When the fixed scripts do not cover a new question yet, copy from
`references/db-snippets.md` and then fold the working check into
`scripts/request_inspect.py` or `scripts/cache_report.py` with a regression test.

Minimal read-only open + one-request load:

```python
import json, sqlite3
from pathlib import Path

DB = Path.home() / "axonhub" / "axonhub.db"
conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

row = conn.execute(
    "SELECT id, model_id, channel_id, request_body FROM requests WHERE id = ?",
    (22412,),
).fetchone()
body = row["request_body"]
if isinstance(body, str):
    body = json.loads(body)
messages = body.get("messages") or []
```

Prefer importing permanent helpers instead of re-copying forever:

```python
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "request_inspect", Path("scripts/request_inspect.py")
)
request_inspect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(request_inspect)
```

Full catalog: `references/db-snippets.md`.
