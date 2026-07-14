"""Read-only report for Responses additional_tools provider compatibility."""

import argparse
import json
import sqlite3
import sys
from pathlib import Path


DB = Path.home() / "axonhub" / "axonhub.db"


def _json(value):
    if not value:
        return None
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return None


def _additional_tools(body):
    names = []
    for item in body.get("input", []) if isinstance(body, dict) else []:
        if not isinstance(item, dict) or item.get("type") != "additional_tools":
            continue
        for tool in item.get("tools", []):
            if isinstance(tool, dict):
                name = tool.get("name") or tool.get("type")
                if name:
                    names.append(str(name))
    return names


def _contains_type(value, expected):
    if isinstance(value, dict):
        if value.get("type") == expected:
            return True
        return any(_contains_type(item, expected) for item in value.values())
    if isinstance(value, list):
        return any(_contains_type(item, expected) for item in value)
    return False


def query_rows(conn, minutes, after_request_id=None):
    modifier = f"-{int(minutes)} minutes"
    request_filter = " AND id > ?" if after_request_id is not None else ""
    params = (modifier, after_request_id) if after_request_id is not None else (modifier,)
    rows = conn.execute(
        f"""
        SELECT id, created_at, model_id, format, channel_id,
               request_body, response_body, response_chunks, status
        FROM requests
        WHERE created_at > datetime('now', ?)
          AND format = 'openai/responses'{request_filter}
        ORDER BY created_at, id
        """,
        params,
    ).fetchall()
    tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
    )}
    channel_names = (
        dict(conn.execute("SELECT id, name FROM channels"))
        if "channels" in tables
        else {}
    )
    result = []
    for row in rows:
        body = _json(row[5])
        tools = _additional_tools(body)
        if not tools:
            continue
        result.append(
            {
                "request_id": row[0],
                "created_at": row[1],
                "model_id": row[2],
                "format": row[3],
                "channel_id": row[4],
                "channel_name": channel_names.get(row[4]),
                "request_body": body,
                "response_body": _json(row[6]),
                "response_chunks": _json(row[7]),
                "status": row[8],
                "additional_tools": tools,
            }
        )
    return result


def classify_rows(rows, expect_tool=False):
    result = []
    for source in rows:
        row = dict(source)
        has_call = _contains_type(row.get("response_body"), "custom_tool_call") or _contains_type(
            row.get("response_chunks"), "custom_tool_call"
        )
        if row.get("status") != "completed":
            classification = "request-failed"
        elif has_call:
            classification = "compatible-tool-call"
        elif expect_tool:
            classification = "semantic-incompatibility"
        else:
            classification = "no-tool-call"
        row["classification"] = classification
        result.append(row)
    return result


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("minutes", nargs="?", type=int, default=1440)
    parser.add_argument("--db", type=Path, default=DB)
    parser.add_argument("--after-request-id", type=int)
    parser.add_argument(
        "--expect-tool",
        action="store_true",
        help="classify completed no-call rows as semantic incompatibility",
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if not args.db.exists():
        print(f"DB not found: {args.db}", file=sys.stderr)
        return 1
    conn = sqlite3.connect(f"file:{args.db.resolve().as_posix()}?mode=ro", uri=True)
    try:
        rows = classify_rows(
            query_rows(conn, args.minutes, after_request_id=args.after_request_id),
            expect_tool=args.expect_tool,
        )
    finally:
        conn.close()
    if not rows:
        print(f"No Responses additional_tools requests in last {args.minutes} min")
        return 0
    for row in rows:
        print(
            f"req={row['request_id']} model={row['model_id']} "
            f"channel={row['channel_name'] or row['channel_id']} "
            f"tools={','.join(row['additional_tools'])} {row['classification']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
