"""Classify recent AxonHub cache behavior without mixing request families."""

import argparse
import json
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path


DB = Path.home() / "axonhub" / "axonhub.db"
CACHE_COLUMNS = ("prompt_cached_tokens", "cached_tokens")
LOW_HIT_THRESHOLD = 90.0
LARGE_GROWTH_CHARS = 8_000
CLASSIFICATIONS = (
    "standalone-web-search",
    "cold-first",
    "tools-changed",
    "top-system-changed",
    "appended-system",
    "history-changed",
    "large-growth",
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
               ROUND(CAST({column} AS REAL) / NULLIF(prompt_tokens, 0) * 100, 1),
               created_at
        FROM usage_logs
        WHERE created_at > datetime('now', ?)
        ORDER BY created_at, id
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
        "created_at",
        "model_id",
        "format",
        "request_headers",
        "request_body",
        "channel_id",
    }.issubset(request_columns)


def query_detailed_rows(
    conn,
    minutes,
    lookback_minutes=1440,
    model_pattern="deepseek%",
    request_format="anthropic/messages",
    after_request_id=None,
):
    column = cache_column(conn)
    history_modifier = f"-{int(minutes) + int(lookback_minutes)} minutes"
    window_modifier = f"-{int(minutes)} minutes"
    filters = ["r.created_at > datetime('now', ?)"]
    params = [window_modifier, after_request_id, after_request_id, history_modifier]
    if model_pattern:
        filters.append("r.model_id LIKE ?")
        params.append(model_pattern)
    if request_format:
        filters.append("r.format = ?")
        params.append(request_format)
    rows = conn.execute(
        f"""
        SELECT u.id, u.request_id, r.model_id, u.prompt_tokens, u.{column},
               ROUND(CAST(u.{column} AS REAL) /
                     NULLIF(u.prompt_tokens, 0) * 100, 1),
               r.created_at, u.created_at, r.request_headers, r.request_body,
               r.channel_id, r.format,
               (r.created_at > datetime('now', ?)
                AND (? IS NULL OR r.id > ?)) AS in_window
        FROM usage_logs u
        JOIN requests r ON r.id = u.request_id
        WHERE {' AND '.join(filters)}
        ORDER BY r.created_at, r.id, u.id
        """,
        tuple(params),
    ).fetchall()
    return [
        {
            "id": row[0],
            "request_id": row[1],
            "model_id": row[2],
            "prompt_tokens": row[3],
            "cached_tokens": row[4],
            "pct": row[5] or 0.0,
            "request_created_at": row[6],
            "usage_created_at": row[7],
            "request_headers": _json_object(row[8]),
            "request_body": _json_object(row[9]),
            "channel_id": row[10],
            "format": row[11],
            "in_window": bool(row[12]),
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
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


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


def _message_chars(messages):
    return sum(len(_canonical(message)) for message in messages)


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
            row.update(
                classification="standalone-web-search",
                tools=names,
                tools_added=names,
                messages_added=0,
                growth_chars=0,
                appended_system=0,
                appended_system_chars=0,
            )
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
        history_growth = previous is not None and _is_history_growth(
            previous["messages"], messages
        )
        appended = messages[len(previous["messages"]):] if history_growth else []
        appended_system = [
            message
            for message in appended
            if isinstance(message, dict) and message.get("role") == "system"
        ]
        growth_chars = _message_chars(appended)

        if row["pct"] >= LOW_HIT_THRESHOLD:
            classification = "high-hit"
        elif previous is None and len(messages) <= 1:
            classification = "cold-first"
        elif previous is not None and tool_signature != previous["tool_signature"]:
            classification = "tools-changed"
        elif previous is not None and system_signature != previous["system_signature"]:
            classification = "top-system-changed"
        elif previous is not None and not history_growth:
            classification = "history-changed"
        elif appended_system:
            classification = "appended-system"
        elif growth_chars >= LARGE_GROWTH_CHARS:
            classification = "large-growth"
        else:
            classification = "clean-growth"

        row.update(
            classification=classification,
            tools=names,
            tools_added=added,
            messages_added=len(appended),
            growth_chars=growth_chars,
            appended_system=len(appended_system),
            appended_system_chars=_message_chars(appended_system),
        )
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
        elif row[3] < LOW_HIT_THRESHOLD:
            tag = " < low"
            drops += 1
        print(
            f"#{row[0]:>4}: hit={row[2]:>7}/{row[1]:>7} "
            f"={row[3]:>5.1f}%{tag}"
        )

    print(f"\n{len(rows) - drops}/{len(rows)} requests >= 90%   {drops} low")


def print_detailed_report(rows, minutes, low_only=False, summary_only=False):
    rows = [row for row in rows if row.get("in_window", True)]
    if not rows:
        print(f"No matching data in last {minutes} min")
        return

    models = ",".join(sorted({row["model_id"] for row in rows}))
    formats = ",".join(sorted({row["format"] for row in rows}))
    print(f"Scope: model={models} format={formats} window={minutes}m")

    detail_rows = (
        [row for row in rows if row["pct"] < LOW_HIT_THRESHOLD]
        if low_only
        else rows
    )
    if not summary_only:
        if not detail_rows:
            print("No rows below 90%")
        for row in detail_rows:
            added = ",".join(row["tools_added"]) or "-"
            growth = f" growth={row['growth_chars']}c" if row["growth_chars"] else ""
            system = (
                f" system={row['appended_system_chars']}c"
                if row["appended_system"]
                else ""
            )
            print(
                f"#{row['id']:>4} req={row['request_id']:>4}: "
                f"hit={row['cached_tokens']:>7}/{row['prompt_tokens']:>7} "
                f"={row['pct']:>5.1f}%  {row['classification']}  "
                f"added={added}{growth}{system} channel={row['channel_id']}"
            )

    summaries = defaultdict(lambda: {"count": 0, "prompt": 0, "cached": 0})
    for row in rows:
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


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("minutes", nargs="?", type=int, default=10)
    parser.add_argument("--db", type=Path, default=DB)
    parser.add_argument("--lookback", type=int, default=1440)
    parser.add_argument("--after-request-id", type=int)
    parser.add_argument("--model", default="deepseek%", help="SQLite LIKE pattern")
    parser.add_argument("--format", dest="request_format", default="anthropic/messages")
    parser.add_argument("--all-models", action="store_true")
    parser.add_argument("--all-formats", action="store_true")
    parser.add_argument("--low-only", action="store_true")
    parser.add_argument("--summary", action="store_true")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if not args.db.exists():
        print(f"DB not found: {args.db}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(f"file:{args.db.resolve().as_posix()}?mode=ro", uri=True)
    try:
        if request_metadata_available(conn):
            rows = query_detailed_rows(
                conn,
                args.minutes,
                lookback_minutes=args.lookback,
                model_pattern=None if args.all_models else args.model,
                request_format=None if args.all_formats else args.request_format,
                after_request_id=args.after_request_id,
            )
            rows = classify_rows(rows)
            detailed = True
        else:
            rows = query_rows(conn, args.minutes)
            detailed = False
    except RuntimeError as error:
        print(f"Cache report failed: {error}", file=sys.stderr)
        return 1
    finally:
        conn.close()

    if detailed:
        print_detailed_report(
            rows,
            args.minutes,
            low_only=args.low_only,
            summary_only=args.summary,
        )
    else:
        print_report(rows, args.minutes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
