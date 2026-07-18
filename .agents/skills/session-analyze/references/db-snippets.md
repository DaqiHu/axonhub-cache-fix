# AxonHub DB analysis snippets

Prefer the scripts first:

```powershell
python scripts/cache_report.py 60 --low-only
python scripts/request_inspect.py 22412 --compare-prev --neighbors 5
python scripts/request_inspect.py 24771 24772 --json
python scripts/analyze.py --dir .\test-data "*Request_*.json"
```

Use the snippets below only when assembling a **new** permanent check. After it
works, fold it into `scripts/request_inspect.py` or `scripts/cache_report.py`
and add a regression test. Do not leave throwaway analysis as the only entry.

## 1. Read-only DB open

```python
import sqlite3
from pathlib import Path

DB = Path.home() / "axonhub" / "axonhub.db"
conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
```

## 2. Load one request body + usage

```python
import json

def load_request(conn, request_id: int):
    row = conn.execute(
        """
        SELECT id, created_at, model_id, channel_id, format, request_body
        FROM requests WHERE id = ?
        """,
        (request_id,),
    ).fetchone()
    if row is None:
        raise KeyError(request_id)
    body = row["request_body"]
    if isinstance(body, (bytes, bytearray)):
        body = body.decode("utf-8", "replace")
    if isinstance(body, str):
        body = json.loads(body)
    usage = conn.execute(
        """
        SELECT prompt_tokens, prompt_cached_tokens, completion_tokens
        FROM usage_logs WHERE request_id = ? ORDER BY id DESC LIMIT 1
        """,
        (request_id,),
    ).fetchone()
    hit = None
    if usage and usage["prompt_tokens"]:
        hit = 100.0 * (usage["prompt_cached_tokens"] or 0) / usage["prompt_tokens"]
    return {
        "id": row["id"],
        "created_at": row["created_at"],
        "model_id": row["model_id"],
        "channel_id": row["channel_id"],
        "format": row["format"],
        "body": body,
        "messages": body.get("messages") or [],
        "tools": [
            t.get("name")
            for t in (body.get("tools") or [])
            if isinstance(t, dict)
        ],
        "prompt_tokens": usage["prompt_tokens"] if usage else None,
        "cached_tokens": usage["prompt_cached_tokens"] if usage else None,
        "hit_rate_pct": round(hit, 4) if hit is not None else None,
    }
```

## 3. System text + skills listing classification

```python
SKILLS_MARKERS = (
    "The following skills are available for use with the Skill tool",
    "skills are available for use with the Skill tool",
)

def content_text(content) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return str(content)
    parts = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            parts.append(block.get("text") or "")
        elif block.get("type") == "tool_result":
            result = block.get("content")
            if isinstance(result, str):
                parts.append(result)
            elif isinstance(result, list):
                for item in result:
                    if isinstance(item, dict) and item.get("type") == "text":
                        parts.append(item.get("text") or "")
    return "\n".join(parts)

def classify_system(text: str) -> str:
    value = (text or "").strip()
    if not value:
        return "empty-system"
    if any(marker in value for marker in SKILLS_MARKERS):
        return "skills-listing"
    if value.startswith("The following deferred tools are now available via ToolSearch."):
        return "deferred-tools"
    if value.startswith("The task tools haven't been used recently."):
        return "task-tools"
    if "[SYSTEM NOTIFICATION - NOT USER INPUT]" in value:
        return "background-notification"
    if value.startswith("The user sent a new message while you were working"):
        return "mid-turn-user-inject"
    if value.startswith("Another Claude session sent a message while you were working"):
        return "multi-agent-notification"
    if value.startswith("Contents of ") and (
        "CLAUDE.md" in value or "AGENTS.md" in value or ".md:" in value[:120]
    ):
        return "worktree-instructions"
    if value.startswith("Note:") and "was modified" in value:
        return "file-change-notice"
    return "other-system"

def system_rows(messages):
    rows = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict) or message.get("role") != "system":
            continue
        text = content_text(message.get("content"))
        rows.append(
            {
                "index": index,
                "kind": classify_system(text),
                "chars": len(text),
                "preview": text[:180].replace("\n", " "),
            }
        )
    return rows

def skills_positions(messages):
    return [row["index"] for row in system_rows(messages) if row["kind"] == "skills-listing"]
```

## 4. First changed message + cache_control-only diffs

```python
import json

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

def strip_cache_control(value):
    if isinstance(value, dict):
        return {
            key: strip_cache_control(item)
            for key, item in value.items()
            if key != "cache_control"
        }
    if isinstance(value, list):
        return [strip_cache_control(item) for item in value]
    return value

def first_changes(prev_messages, curr_messages):
    first_raw = None
    first_semantic = None
    cc_only = []
    for index in range(min(len(prev_messages), len(curr_messages))):
        raw_same = canonical(prev_messages[index]) == canonical(curr_messages[index])
        semantic_same = (
            canonical(strip_cache_control(prev_messages[index]))
            == canonical(strip_cache_control(curr_messages[index]))
        )
        if not raw_same and first_raw is None:
            first_raw = index
        if not semantic_same and first_semantic is None:
            first_semantic = index
        if not raw_same and semantic_same:
            cc_only.append(index)
    return {
        "first_raw_changed_msg": first_raw,
        "first_semantic_changed_msg": first_semantic,
        "cache_control_only_diffs": cc_only,
        "skills_prev": skills_positions(prev_messages),
        "skills_curr": skills_positions(curr_messages),
        "skills_listing_changed": skills_positions(prev_messages)
        != skills_positions(curr_messages),
        "last_role_prev": prev_messages[-1].get("role") if prev_messages else None,
        "last_role_curr": curr_messages[-1].get("role") if curr_messages else None,
    }
```

## 5. Same channel/model neighbor hit rates

```python
def neighbor_hits(conn, request_id: int, channel_id: int, model_id: str, radius: int = 5):
    rows = conn.execute(
        """
        SELECT r.id, r.created_at,
               ul.prompt_tokens, ul.prompt_cached_tokens,
               ROUND(100.0 * ul.prompt_cached_tokens / NULLIF(ul.prompt_tokens, 0), 2) AS hit
        FROM requests r
        LEFT JOIN usage_logs ul ON ul.request_id = r.id
        WHERE r.channel_id = ?
          AND r.model_id = ?
          AND r.id BETWEEN ? AND ?
        ORDER BY r.id
        """,
        (channel_id, model_id, request_id - radius, request_id + radius),
    ).fetchall()
    return [dict(row) for row in rows]
```

## 6. Channel-weighted hit rates (24h)

```python
def channel_hit_rates(conn, hours: int = 24):
    return conn.execute(
        """
        SELECT r.channel_id, c.name, c.type, r.model_id, COUNT(*) AS n,
               ROUND(
                   100.0 * SUM(ul.prompt_cached_tokens)
                   / NULLIF(SUM(ul.prompt_tokens), 0),
                   1
               ) AS hit
        FROM requests r
        JOIN usage_logs ul ON ul.request_id = r.id
        LEFT JOIN channels c ON c.id = r.channel_id
        WHERE r.created_at > datetime('now', ?)
          AND ul.prompt_tokens > 0
        GROUP BY r.channel_id, r.model_id
        ORDER BY r.channel_id, hit DESC
        """,
        (f"-{int(hours)} hours",),
    ).fetchall()
```

## 7. Import helpers from the real script

When extending analysis inside this repo, import the permanent helpers instead of
copying forever:

```python
import importlib.util
from pathlib import Path

SCRIPT = Path("scripts/request_inspect.py")
spec = importlib.util.spec_from_file_location("request_inspect", SCRIPT)
request_inspect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(request_inspect)

# then use:
# request_inspect.classify_system(...)
# request_inspect.load_request(conn, rid)
# request_inspect.compare(prev, curr)
```

## 8. Decision checklist after a low-hit row

1. Run `python scripts/request_inspect.py <id> --compare-prev --neighbors 5`.
2. If `skills_listing_changed=true` and listing is last message → skills-listing
   style `appended-system` (DeepSeek `#24772` pattern).
3. If `skills_listing_changed=false` and trailing system is
   `mid-turn-user-inject` / background / worktree → not skills listing
   (Kimi `#22412` pattern).
4. Only then open native execution bodies or write a new permanent check.
