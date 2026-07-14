"""Query AxonHub DB for recent cache hit rates."""

import json
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path


DB = Path.home() / "axonhub" / "axonhub.db"
CACHE_COLUMNS = ("prompt_cached_tokens", "cached_tokens")
CLASSIFICATIONS = (
    "standalone-web-search",
    "cold-first",
    "tools-changed",
    "system-changed",
    "history-changed",
    "clean-growth",
    "high-hit",
)


def cache_column(conn):
    columns = {row[1] for row in conn.execute("PRAGMA table_info(usage_logs)")}
    for name in CACHE_COLUMNS:
        if name in columns:
            return name
    raise RuntimeError(
        "usage_logs has no supported cache token column "
        f"(expected one of: {', '.join(CACHE_COLUMNS)})"
    )


def query_rows(conn, minutes):
    column = cache_column(conn)
    modifier = f"-{int(minutes)} minutes"
    return conn.execute(
        f"""
        SELECT id, prompt_tokens, {column},
               ROUND(CAST({column} AS REAL) / NULLIF(prompt_tokens, 0) * 100, 1) as pct,
               created_at
        FROM usage_logs
        WHERE created_at > datetime('now', ?)
        ORDER BY created_at
        """,
        (modifier,),
    ).fetchall()


def table_columns(conn, table):
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def request_metadata_available(conn):
    usage_columns = table_columns(conn, "usage_logs")
    request_columns = table_columns(conn, "requests")
    return {"request_id", "model_id"}.issubset(usage_columns) and {
        "id",
        "request_headers",
        "request_body",
        "channel_id",
    }.issubset(request_columns)


def query_detailed_rows(conn, minutes):
    column = cache_column(conn)
    modifier = f"-{int(minutes)} minutes"
    rows = conn.execute(
        f"""
        SELECT u.id, u.request_id, u.model_id, u.prompt_tokens, u.{column},
               ROUND(CAST(u.{column} AS REAL) /
                     NULLIF(u.prompt_tokens, 0) * 100, 1),
               u.created_at, r.request_headers, r.request_body, r.channel_id
        FROM usage_logs u
        JOIN requests r ON r.id = u.request_id
        WHERE u.created_at > datetime('now', ?)
        ORDER BY u.created_at, u.id
        """,
        (modifier,),
    ).fetchall()
    return [
        {
            "id": row[0],
            "request_id": row[1],
            "model_id": row[2],
            "prompt_tokens": row[3],
            "cached_tokens": row[4],
            "pct": row[5] or 0.0,
            "created_at": row[6],
            "request_headers": _json_object(row[7]),
            "request_body": _json_object(row[8]),
            "channel_id": row[9],
        }
        for row in rows
    ]


def _json_object(value):
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _header_value(headers, name):
    value = next(
        (value for key, value in headers.items() if str(key).lower() == name),
        None,
    )
    if isinstance(value, list):
        return str(value[0]) if value else None
    return str(value) if value is not None else None


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _tool_names(body):
    tools = body.get("tools")
    if not isinstance(tools, list):
        return []
    return [
        tool.get("name")
        for tool in tools
        if isinstance(tool, dict) and isinstance(tool.get("name"), str)
    ]


def _messages(body):
    messages = body.get("messages")
    return messages if isinstance(messages, list) else []


def _is_history_growth(previous, current):
    return len(current) >= len(previous) and current[: len(previous)] == previous


def classify_rows(rows):
    states = {}
    classified = []

    for source in rows:
        row = dict(source)
        headers = row["request_headers"]
        body = row["request_body"]
        names = _tool_names(body)
        messages = _messages(body)
        standalone = names == ["web_search"] and len(messages) == 1

        if standalone:
            row["classification"] = "standalone-web-search"
            row["tools"] = names
            row["tools_added"] = names
            classified.append(row)
            continue

        session = _header_value(headers, "x-claude-code-session-id") or "unknown"
        agent = _header_value(headers, "x-claude-code-agent-id") or "main"
        model = body.get("model") or row["model_id"]
        key = (session, agent, str(model), "conversation")
        previous = states.get(key)
        tool_signature = _canonical(body.get("tools", []))
        system_signature = _canonical(body.get("system"))
        added = names if previous is None else [
            name for name in names if name not in previous["tools"]
        ]

        if row["pct"] >= 90:
            classification = "high-hit"
        elif previous is None and len(messages) <= 1:
            classification = "cold-first"
        elif previous is not None and tool_signature != previous["tool_signature"]:
            classification = "tools-changed"
        elif previous is not None and system_signature != previous["system_signature"]:
            classification = "system-changed"
        elif previous is not None and not _is_history_growth(
            previous["messages"], messages
        ):
            classification = "history-changed"
        else:
            classification = "clean-growth"

        row["classification"] = classification
        row["tools"] = names
        row["tools_added"] = added
        classified.append(row)
        states[key] = {
            "tool_signature": tool_signature,
            "system_signature": system_signature,
            "messages": messages,
            "tools": names,
        }

    return classified


def print_report(rows, minutes):
    if not rows:
        print(f"No data in last {minutes} min")
        return

    drops = 0
    for row in rows:
        tag = ""
        if row[3] < 50:
            tag = " < very low"
            drops += 1
        elif row[3] < 90:
            tag = " < low"
            drops += 1
        print(
            f"#{row[0]:>4}: hit={row[2]:>7}/{row[1]:>7} "
            f"={row[3]:>5.1f}%{tag}"
        )

    total = len(rows)
    good = total - drops
    first_cold = "(cold start OK)" if rows[0][3] < 50 else ""
    print(f"\n{good}/{total} requests >= 90%   {drops} drops {first_cold}")


def print_detailed_report(rows, minutes):
    if not rows:
        print(f"No data in last {minutes} min")
        return

    summaries = defaultdict(lambda: {"count": 0, "prompt": 0, "cached": 0})
    for row in rows:
        added = ",".join(row["tools_added"]) or "-"
        print(
            f"#{row['id']:>4} req={row['request_id']:>4}: "
            f"hit={row['cached_tokens']:>7}/{row['prompt_tokens']:>7} "
            f"={row['pct']:>5.1f}%  {row['classification']}  added={added}"
        )
        summary = summaries[row["classification"]]
        summary["count"] += 1
        summary["prompt"] += row["prompt_tokens"]
        summary["cached"] += row["cached_tokens"]

    print("\nClassification summary (token-weighted):")
    for name in CLASSIFICATIONS:
        summary = summaries.get(name)
        if not summary:
            continue
        weighted = (
            summary["cached"] / summary["prompt"] * 100
            if summary["prompt"]
            else 0.0
        )
        noun = "request" if summary["count"] == 1 else "requests"
        print(
            f"  {name:<24} {summary['count']:>3} {noun}, "
            f"{weighted:>5.1f}% weighted "
            f"({summary['cached']}/{summary['prompt']})"
        )


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    minutes = int(args[0]) if args else 10

    if not DB.exists():
        print(f"DB not found: {DB}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True)
    try:
        if request_metadata_available(conn):
            rows = classify_rows(query_detailed_rows(conn, minutes))
            detailed = True
        else:
            rows = query_rows(conn, minutes)
            detailed = False
    except RuntimeError as error:
        print(f"Cache report failed: {error}", file=sys.stderr)
        return 1
    finally:
        conn.close()

    if detailed:
        print_detailed_report(rows, minutes)
    else:
        print_report(rows, minutes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
