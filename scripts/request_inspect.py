"""Inspect one or more AxonHub request IDs from the live SQLite DB.

Read-only. Prefer this over ad-hoc sqlite one-liners when analyzing a specific
request, comparing adjacent requests, or checking whether skills listing moved.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

DB = Path.home() / "axonhub" / "axonhub.db"

SKILLS_LISTING_MARKERS = (
    "The following skills are available for use with the Skill tool",
    "skills are available for use with the Skill tool",
)
BOOKKEEPING_PREFIXES = (
    ("deferred-tools", "The following deferred tools are now available via ToolSearch."),
    ("task-tools", "The task tools haven't been used recently."),
)


def parse_body(raw):
    if raw is None:
        return None
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", "replace")
    if isinstance(raw, dict):
        return raw
    return json.loads(raw)


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


def content_text(content):
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
        kind = block.get("type")
        if kind == "text":
            parts.append(block.get("text") or "")
        elif kind == "tool_result":
            result = block.get("content")
            if isinstance(result, str):
                parts.append(result)
            elif isinstance(result, list):
                for item in result:
                    if isinstance(item, dict) and item.get("type") == "text":
                        parts.append(item.get("text") or "")
        elif kind == "tool_use":
            parts.append(
                f"tool_use:{block.get('name')}:{json.dumps(block.get('input'), ensure_ascii=False)[:120]}"
            )
        elif kind == "thinking":
            thinking = block.get("thinking") or block.get("text") or ""
            parts.append(f"thinking:{len(thinking)}")
        else:
            parts.append(f"{kind}:...")
    return "\n".join(parts)


def classify_system(text: str) -> str:
    value = (text or "").strip()
    if not value:
        return "empty-system"
    for marker in SKILLS_LISTING_MARKERS:
        if marker in value:
            return "skills-listing"
    for name, prefix in BOOKKEEPING_PREFIXES:
        if value.startswith(prefix):
            return name
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


def tool_names(body):
    tools = body.get("tools") or []
    return [
        tool.get("name")
        for tool in tools
        if isinstance(tool, dict) and isinstance(tool.get("name"), str)
    ]


def system_positions(messages):
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
    return [
        row["index"]
        for row in system_positions(messages)
        if row["kind"] == "skills-listing"
    ]


def skill_calls(messages):
    calls = []
    for index, message in enumerate(messages):
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            continue
        for block in content:
            if (
                isinstance(block, dict)
                and block.get("type") == "tool_use"
                and block.get("name") == "Skill"
            ):
                calls.append(
                    {
                        "index": index,
                        "id": block.get("id"),
                        "input": block.get("input"),
                    }
                )
    return calls


def usage_for(conn, request_id):
    columns = {row[1] for row in conn.execute("PRAGMA table_info(usage_logs)")}
    cache_col = "prompt_cached_tokens" if "prompt_cached_tokens" in columns else None
    if cache_col is None and "cached_tokens" in columns:
        cache_col = "cached_tokens"
    if cache_col is None:
        return None
    row = conn.execute(
        f"""
        SELECT prompt_tokens, {cache_col} AS cached_tokens, completion_tokens,
               total_tokens, model_id, channel_id, format, created_at
        FROM usage_logs
        WHERE request_id = ?
        ORDER BY id DESC
        LIMIT 1
        """,
        (request_id,),
    ).fetchone()
    if not row:
        return None
    prompt = row[0] or 0
    cached = row[1] or 0
    hit = round(100.0 * cached / prompt, 4) if prompt else None
    return {
        "prompt_tokens": prompt,
        "cached_tokens": cached,
        "completion_tokens": row[2],
        "total_tokens": row[3],
        "model_id": row[4],
        "channel_id": row[5],
        "format": row[6],
        "created_at": row[7],
        "hit_rate_pct": hit,
    }


def load_request(conn, request_id):
    row = conn.execute(
        """
        SELECT id, created_at, updated_at, model_id, channel_id, format, status,
               stream, request_headers, request_body
        FROM requests
        WHERE id = ?
        """,
        (request_id,),
    ).fetchone()
    if not row:
        return None
    body = parse_body(row[9])
    messages = body.get("messages") if isinstance(body, dict) else None
    if not isinstance(messages, list):
        messages = []
    headers = parse_body(row[8]) if row[8] else {}
    session = None
    agent = None
    if isinstance(headers, dict):
        for key, value in headers.items():
            lower = str(key).lower()
            if "session" in lower and session is None:
                session = value[0] if isinstance(value, list) and value else value
            if "agent" in lower and agent is None:
                agent = value[0] if isinstance(value, list) and value else value
    return {
        "id": row[0],
        "created_at": row[1],
        "updated_at": row[2],
        "model_id": row[3],
        "channel_id": row[4],
        "format": row[5],
        "status": row[6],
        "stream": row[7],
        "session_id": session,
        "agent_id": agent,
        "body_bytes": len(row[9] or ""),
        "usage": usage_for(conn, request_id),
        "messages": len(messages),
        "tools": tool_names(body) if isinstance(body, dict) else [],
        "system_messages": system_positions(messages),
        "skills_positions": skills_positions(messages),
        "skill_calls": skill_calls(messages),
        "last_role": messages[-1].get("role") if messages else None,
        "last_message_preview": (
            content_text(messages[-1].get("content"))[:180].replace("\n", " ")
            if messages
            else None
        ),
        "top_system_blocks": (
            len(body.get("system") or [])
            if isinstance(body, dict) and isinstance(body.get("system"), list)
            else (1 if isinstance(body, dict) and isinstance(body.get("system"), str) else 0)
        ),
        "_body": body,
        "_messages": messages,
    }


def compare(prev, curr):
    prev_messages = prev["_messages"]
    curr_messages = curr["_messages"]
    prev_body = prev["_body"]
    curr_body = curr["_body"]

    first_raw = None
    first_semantic = None
    cc_only = []
    for index in range(min(len(prev_messages), len(curr_messages))):
        raw_same = canonical(prev_messages[index]) == canonical(curr_messages[index])
        semantic_same = canonical(strip_cache_control(prev_messages[index])) == canonical(
            strip_cache_control(curr_messages[index])
        )
        if not raw_same and first_raw is None:
            first_raw = index
        if not semantic_same and first_semantic is None:
            first_semantic = index
        if not raw_same and semantic_same:
            cc_only.append(index)

    history_prefix = (
        len(curr_messages) >= len(prev_messages)
        and all(
            canonical(prev_messages[index]) == canonical(curr_messages[index])
            for index in range(len(prev_messages))
        )
    )
    appended = curr_messages[len(prev_messages) :] if history_prefix else []
    appended_summary = []
    for offset, message in enumerate(appended):
        index = len(prev_messages) + offset
        text = content_text(message.get("content"))
        kind = (
            classify_system(text)
            if message.get("role") == "system"
            else message.get("role")
        )
        appended_summary.append(
            {
                "index": index,
                "role": message.get("role"),
                "kind": kind,
                "chars": len(text),
                "preview": text[:180].replace("\n", " "),
            }
        )

    prev_tools = prev.get("tools") or tool_names(prev_body)
    curr_tools = curr.get("tools") or tool_names(curr_body)
    prev_count = prev.get("messages")
    if prev_count is None:
        prev_count = len(prev_messages)
    curr_count = curr.get("messages")
    if curr_count is None:
        curr_count = len(curr_messages)
    return {
        "prev_id": prev["id"],
        "curr_id": curr["id"],
        "messages": f"{prev_count} -> {curr_count}",
        "tools_same": prev_tools == curr_tools,
        "tools_added": [name for name in curr_tools if name not in prev_tools],
        "tools_removed": [name for name in prev_tools if name not in curr_tools],
        "tools_order_same": prev_tools == curr_tools,
        "top_system_same": canonical(prev_body.get("system"))
        == canonical(curr_body.get("system")),
        "history_prefix": history_prefix,
        "first_raw_changed_msg": first_raw,
        "first_semantic_changed_msg": first_semantic,
        "cache_control_only_diffs": cc_only[:40],
        "cache_control_only_diff_count": len(cc_only),
        "appended_count": len(appended) if history_prefix else None,
        "appended": appended_summary,
        "skills_prev": prev["skills_positions"],
        "skills_curr": curr["skills_positions"],
        "skills_listing_changed": prev["skills_positions"] != curr["skills_positions"],
        "last_role_prev": prev["last_role"],
        "last_role_curr": curr["last_role"],
        "usage_prev": prev["usage"],
        "usage_curr": curr["usage"],
    }


def neighbors(conn, request_id, channel_id, model_id, radius):
    rows = conn.execute(
        """
        SELECT r.id, r.created_at, length(r.request_body) AS body_bytes,
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
    return [
        {
            "id": row[0],
            "created_at": row[1],
            "body_bytes": row[2],
            "prompt_tokens": row[3],
            "cached_tokens": row[4],
            "hit_rate_pct": row[5],
            "is_target": row[0] == request_id,
        }
        for row in rows
    ]


def public_request(data):
    return {key: value for key, value in data.items() if not key.startswith("_")}


def print_human(report):
    for request in report["requests"]:
        usage = request.get("usage") or {}
        print(f"=== request {request['id']} ===")
        print(
            f"model={request['model_id']} channel={request['channel_id']} "
            f"format={request['format']} status={request['status']}"
        )
        print(
            f"created_at={request['created_at']} messages={request['messages']} "
            f"tools={len(request['tools'])} body_bytes={request['body_bytes']}"
        )
        print(
            f"usage prompt={usage.get('prompt_tokens')} cached={usage.get('cached_tokens')} "
            f"hit={usage.get('hit_rate_pct')}%"
        )
        print(f"session={request.get('session_id')} last_role={request.get('last_role')}")
        print(f"skills_positions={request.get('skills_positions')}")
        print(f"skill_calls={request.get('skill_calls')}")
        print("system_messages:")
        for row in request.get("system_messages") or []:
            print(
                f"  [{row['index']}] {row['kind']} chars={row['chars']} "
                f"preview={row['preview']}"
            )
        print()

    if report.get("neighbors"):
        print("=== neighbors ===")
        for row in report["neighbors"]:
            marker = " <<<" if row["is_target"] else ""
            print(
                f"{row['id']}: hit={row['hit_rate_pct']}% "
                f"prompt={row['prompt_tokens']} body={row['body_bytes']}{marker}"
            )
        print()

    if report.get("compare"):
        compare_result = report["compare"]
        print("=== compare ===")
        for key in (
            "prev_id",
            "curr_id",
            "messages",
            "tools_same",
            "tools_added",
            "tools_removed",
            "top_system_same",
            "history_prefix",
            "first_raw_changed_msg",
            "first_semantic_changed_msg",
            "cache_control_only_diff_count",
            "skills_prev",
            "skills_curr",
            "skills_listing_changed",
            "last_role_prev",
            "last_role_curr",
        ):
            print(f"{key}={compare_result.get(key)}")
        if compare_result.get("appended"):
            print("appended:")
            for row in compare_result["appended"]:
                print(
                    f"  [{row['index']}] role={row['role']} kind={row['kind']} "
                    f"chars={row['chars']} preview={row['preview']}"
                )


def parse_ids(values):
    ids = []
    for value in values:
        for part in re.split(r"[,\s]+", str(value).strip()):
            if not part:
                continue
            ids.append(int(part.lstrip("#")))
    return ids


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=(
            "Inspect AxonHub request IDs from the live DB. "
            "Use for single-request triage and adjacent diffs."
        )
    )
    parser.add_argument(
        "request_ids",
        nargs="+",
        help="Request ID(s), e.g. 22412 or 22411 22412",
    )
    parser.add_argument(
        "--db",
        default=str(DB),
        help=f"SQLite path (default: {DB})",
    )
    parser.add_argument(
        "--compare-prev",
        action="store_true",
        help="When one ID is given, compare it with the previous same channel/model request",
    )
    parser.add_argument(
        "--neighbors",
        type=int,
        default=0,
        metavar="N",
        help="Show N previous/next same-channel/model requests with hit rates",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON",
    )
    args = parser.parse_args(argv)
    ids = parse_ids(args.request_ids)
    if not ids:
        parser.error("no request ids")

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"database not found: {db_path}", file=sys.stderr)
        return 2

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        requests = []
        for request_id in ids:
            data = load_request(conn, request_id)
            if data is None:
                print(f"request not found: {request_id}", file=sys.stderr)
                return 1
            requests.append(data)

        report = {"requests": [public_request(item) for item in requests]}

        if len(requests) == 1 and (args.compare_prev or args.neighbors):
            target = requests[0]
            if args.neighbors:
                report["neighbors"] = neighbors(
                    conn,
                    target["id"],
                    target["channel_id"],
                    target["model_id"],
                    args.neighbors,
                )
            if args.compare_prev:
                prev_id = conn.execute(
                    """
                    SELECT id FROM requests
                    WHERE channel_id = ? AND model_id = ? AND id < ?
                    ORDER BY id DESC
                    LIMIT 1
                    """,
                    (target["channel_id"], target["model_id"], target["id"]),
                ).fetchone()
                if prev_id:
                    prev = load_request(conn, prev_id[0])
                    report["compare"] = compare(prev, target)
                    # include prev summary for context
                    report["previous"] = public_request(prev)
                else:
                    report["compare"] = None
        elif len(requests) >= 2:
            report["compare"] = compare(requests[-2], requests[-1])

        if args.json:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            print_human(report)
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
