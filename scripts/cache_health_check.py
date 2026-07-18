#!/usr/bin/env python3
"""Cache health spot-check: weighted hit rates per channel/model with low-cache breakdown.

Usage:
  python scripts/cache_health_check.py                        # last 60 minutes, all channels
  python scripts/cache_health_check.py 120                    # last 120 minutes
  python scripts/cache_health_check.py 60 --channel 1         # single channel
  python scripts/cache_health_check.py 60 --model deepseek-v4-pro  # single model
  python scripts/cache_health_check.py 60 --low-threshold 0.5  # flag hits below 50% as low
  python scripts/cache_health_check.py 60 --json              # machine-readable output
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

DB = Path.home() / "axonhub" / "axonhub.db"
DEFAULT_WINDOW_MINUTES = 60
DEFAULT_LOW_THRESHOLD = 0.20
DEFAULT_MIN_PROMPT = 5000


def get_connection() -> sqlite3.Connection:
    db = DB
    if not db.exists():
        print(f"ERROR: database not found at {db}", file=sys.stderr)
        sys.exit(1)
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def classify_cause(
    conn: sqlite3.Connection, rid: int, channel_id: int, model_id: str
) -> dict[str, Any]:
    """Lightweight root-cause classifier for a single low-cache request."""
    try:
        body_raw = conn.execute(
            "SELECT request_body FROM requests WHERE id=?", (rid,)
        ).fetchone()
        if not body_raw or not body_raw[0]:
            return {"cause": "no-body"}
        body = body_raw[0]
        if isinstance(body, (bytes, bytearray)):
            body = body.decode("utf-8", "replace")
        data = json.loads(body)
    except Exception:
        return {"cause": "parse-error"}

    msgs = data.get("messages") or []
    if not msgs:
        return {"cause": "no-messages"}

    tools = [t.get("name") for t in (data.get("tools") or []) if isinstance(t, dict)]

    # Find system messages
    systems: list[dict] = []
    for i, m in enumerate(msgs):
        if m.get("role") != "system":
            continue
        c = m.get("content")
        text = ""
        if isinstance(c, str):
            text = c
        elif isinstance(c, list):
            text = " ".join(
                b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text"
            )
        if not text.strip():
            systems.append({"i": i, "kind": "empty", "len": 0})
            continue
        kind = "other"
        if "skills are available for use with the Skill tool" in text:
            kind = "skills-listing"
        elif "[SYSTEM NOTIFICATION - NOT USER INPUT]" in text:
            kind = "bg-notif"
        elif "user sent a new message while you were working" in text:
            kind = "mid-turn"
        elif "deferred tools are no longer available" in text:
            kind = "deferred-gone"
        elif "deferred tools are available again" in text:
            kind = "deferred-again"
        elif "deferred tools are now available" in text:
            kind = "deferred-available"
        elif "MCP servers are still connecting" in text:
            kind = "mcp-connecting"
        elif "task tools haven't been used recently" in text:
            kind = "task-tools"
        elif "Available agent types for the Agent tool" in text:
            kind = "agent-types"
        elif "was modified, either by the user or by a linter" in text:
            kind = "file-change"
        elif "Contents of " in text:
            kind = "worktree"
        elif "Another Claude session sent a message" in text:
            kind = "other-session"
        systems.append({"i": i, "kind": kind, "len": len(text)})

    last = msgs[-1] if msgs else {}
    last_role = last.get("role")

    # Compare with previous request (same channel/model)
    prev = conn.execute(
        """
        SELECT r.id, ul.prompt_cached_tokens, ul.prompt_tokens
        FROM requests r
        LEFT JOIN usage_logs ul ON ul.request_id = r.id
        WHERE r.channel_id = ? AND r.model_id = ? AND r.id < ?
        ORDER BY r.id DESC LIMIT 1
        """,
        (channel_id, model_id, rid),
    ).fetchone()

    cause = "unclassified"
    details: dict[str, Any] = {}

    if prev and prev["id"]:
        try:
            pbody_raw = conn.execute(
                "SELECT request_body FROM requests WHERE id=?", (prev["id"],)
            ).fetchone()
            if pbody_raw and pbody_raw[0]:
                pbody = pbody_raw[0]
                if isinstance(pbody, (bytes, bytearray)):
                    pbody = pbody.decode("utf-8", "replace")
                pdata = json.loads(pbody)
                pmsgs = pdata.get("messages") or []
                ptools = [
                    t.get("name")
                    for t in (pdata.get("tools") or [])
                    if isinstance(t, dict)
                ]

                n = min(len(pmsgs), len(msgs))
                first_changed = None
                for i in range(n):
                    if json.dumps(pmsgs[i], sort_keys=True, ensure_ascii=False) != json.dumps(
                        msgs[i], sort_keys=True, ensure_ascii=False
                    ):
                        first_changed = i
                        break
                details["first_changed"] = first_changed
                details["msg_delta"] = len(msgs) - len(pmsgs)

                tools_added = [n for n in tools if n not in ptools]
                tools_removed = [n for n in ptools if n not in tools]

                # Classify
                if len(msgs) <= 10:
                    cause = "cold-first"
                elif tools_added or tools_removed:
                    cause = "tools-changed"
                elif details["msg_delta"] is not None and details["msg_delta"] < -10:
                    cause = "context-compacted"
                elif last_role == "system":
                    last_sys = systems[-1] if systems else None
                    if last_sys:
                        cause = f"last-system:{last_sys['kind']}"
                    else:
                        cause = "last-system:unknown"
                elif details["msg_delta"] is not None and details["msg_delta"] > 0:
                    # appended messages - check if any are system
                    appended_sys = []
                    for i in range(len(pmsgs), len(msgs)):
                        m = msgs[i]
                        if m.get("role") == "system":
                            c = m.get("content")
                            t = ""
                            if isinstance(c, str):
                                t = c
                            elif isinstance(c, list):
                                t = " ".join(
                                    b.get("text", "")
                                    for b in c
                                    if isinstance(b, dict) and b.get("type") == "text"
                                )
                            if "skills are available" in t:
                                appended_sys.append("skills")
                            elif "SYSTEM NOTIFICATION" in t:
                                appended_sys.append("bg-notif")
                            elif "user sent a new message" in t:
                                appended_sys.append("mid-turn")
                            elif "Available agent types" in t:
                                appended_sys.append("agent-types")
                            else:
                                appended_sys.append("other")
                    if appended_sys:
                        cause = f"append-system:{','.join(appended_sys)}"
                    else:
                        cause = "large-growth"
                elif first_changed is not None and first_changed < len(pmsgs):
                    cause = f"history-changed@{first_changed}"
                elif first_changed is None and details["msg_delta"] is not None and details["msg_delta"] == 0:
                    cause = "bytes-drift-same-count"
        except Exception:
            cause = "diff-error"

    return {
        "cause": cause,
        "nmsg": len(msgs),
        "ntools": len(tools),
        "systems": [
            {"i": s["i"], "kind": s["kind"]}
            for s in systems[-3:]
        ],
        "last_role": last_role,
        "details": details,
    }


def run(window_minutes: int, channel_id: int | None, model_id: str | None,
        low_threshold: float, min_prompt: int, json_output: bool) -> None:
    conn = get_connection()

    # Build WHERE clause
    where = [
        "r.created_at > datetime('now', ?)",
        "ul.prompt_tokens > 0",
    ]
    params: list[Any] = [f"-{window_minutes} minutes"]

    if channel_id is not None:
        where.append("r.channel_id = ?")
        params.append(channel_id)
    if model_id is not None:
        where.append("r.model_id = ?")
        params.append(model_id)

    where_clause = " AND ".join(where)

    # Overall hit rates per channel/model
    summary = conn.execute(
        f"""
        SELECT c.name AS channel_name, c.type AS channel_type,
               r.channel_id, r.model_id,
               COUNT(*) AS n,
               COALESCE(SUM(ul.prompt_tokens), 0) AS prompt_total,
               COALESCE(SUM(ul.prompt_cached_tokens), 0) AS cached_total,
               ROUND(100.0 * COALESCE(SUM(ul.prompt_cached_tokens), 0) /
                     NULLIF(COALESCE(SUM(ul.prompt_tokens), 0), 0), 2) AS weighted_hit,
               COALESCE(SUM(CASE WHEN ul.prompt_tokens >= ? AND
                    ul.prompt_cached_tokens * 1.0 / ul.prompt_tokens < ?
                    THEN 1 ELSE 0 END), 0) AS low_n,
               COALESCE(SUM(CASE WHEN ul.prompt_tokens >= ? AND
                    ul.prompt_cached_tokens * 1.0 / ul.prompt_tokens >= 0.95
                    THEN 1 ELSE 0 END), 0) AS high_n
        FROM requests r
        JOIN usage_logs ul ON ul.request_id = r.id
        JOIN channels c ON c.id = r.channel_id
        WHERE {where_clause}
        GROUP BY r.channel_id, r.model_id
        ORDER BY r.channel_id, weighted_hit DESC
        """,
        [min_prompt, low_threshold, min_prompt] + params,
    ).fetchall()

    if json_output:
        output = {"window_minutes": window_minutes, "channels": []}
        for row in summary:
            ch = dict(row)
            ch["low_pct"] = round(100.0 * ch["low_n"] / max(ch["n"], 1), 1)
            ch["high_pct"] = round(100.0 * ch["high_n"] / max(ch["n"], 1), 1)

            # Classify low-cache requests
            if ch["low_n"] > 0:
                causes: defaultdict[str, int] = defaultdict(int)
                low_reqs = conn.execute(
                    f"""
                    SELECT r.id, r.channel_id, r.model_id
                    FROM requests r
                    JOIN usage_logs ul ON ul.request_id = r.id
                    WHERE r.channel_id = ? AND r.model_id = ?
                      AND r.created_at > datetime('now', ?)
                      AND ul.prompt_tokens >= ?
                      AND ul.prompt_cached_tokens * 1.0 / ul.prompt_tokens < ?
                    ORDER BY (ul.prompt_tokens - ul.prompt_cached_tokens) DESC
                    LIMIT 30
                    """,
                    [ch["channel_id"], ch["model_id"], f"-{window_minutes} minutes",
                     min_prompt, low_threshold],
                ).fetchall()
                for lr in low_reqs:
                    result = classify_cause(conn, lr["id"], lr["channel_id"], lr["model_id"])
                    causes[result["cause"]] += 1
                ch["low_causes"] = dict(causes.most_common(10))
            else:
                ch["low_causes"] = {}

            output["channels"].append(ch)
        print(json.dumps(output, ensure_ascii=False, indent=2))
        conn.close()
        return

    # Human-readable output
    print(f"\n  Cache Health Check — last {window_minutes} min")
    print(f"  {'=' * 65}")
    header = f"  {'Channel':<30s} {'Model':<25s} {'N':>5s} {'Prompt':>9s} {'Weighted':>8s} {'Low':>5s} {'High>95%':>9s}"
    print(header)
    print(f"  {'-' * 65}")

    for row in summary:
        prompt_str = f"{row['prompt_total'] / 1_000_000:.1f}M"
        low_pct = 100.0 * row["low_n"] / max(row["n"], 1)
        high_pct = 100.0 * row["high_n"] / max(row["n"], 1)
        name = row["channel_name"][:28] if row["channel_name"] else f"ch{row['channel_id']}"
        model = row["model_id"][:23] if row["model_id"] else "?"
        print(
            f"  {name:<30s} {model:<25s} {row['n']:>5d} {prompt_str:>9s} "
            f"{row['weighted_hit']:>7.2f}% {row['low_n']:>4d}({low_pct:.0f}%) "
            f"{row['high_n']:>4d}({high_pct:.0f}%)"
        )

    print()

    # Low-cache breakdown for top channels
    for row in summary:
        if row["low_n"] == 0:
            continue
        name = row["channel_name"] or f"ch{row['channel_id']}"
        print(f"  --- {name} / {row['model_id']}  low-cache causes ---")

        low_reqs = conn.execute(
            f"""
            SELECT r.id, ul.prompt_tokens, ul.prompt_cached_tokens,
                   ROUND(100.0 * ul.prompt_cached_tokens / ul.prompt_tokens, 1) AS hit,
                   (ul.prompt_tokens - ul.prompt_cached_tokens) AS uncached
            FROM requests r
            JOIN usage_logs ul ON ul.request_id = r.id
            WHERE r.channel_id = ? AND r.model_id = ?
              AND r.created_at > datetime('now', ?)
              AND ul.prompt_tokens >= ?
              AND ul.prompt_cached_tokens * 1.0 / ul.prompt_tokens < ?
            ORDER BY uncached DESC
            LIMIT 25
            """,
            [row["channel_id"], row["model_id"], f"-{window_minutes} minutes",
             min_prompt, low_threshold],
        ).fetchall()

        cause_counts: defaultdict[str, int] = defaultdict(int)
        cause_uncached: defaultdict[str, int] = defaultdict(int)
        for lr in low_reqs:
            result = classify_cause(conn, lr["id"], row["channel_id"], row["model_id"])
            cause_counts[result["cause"]] += 1
            cause_uncached[result["cause"]] += lr["uncached"]

        for cause, count in sorted(cause_counts.items(), key=lambda x: -x[1])[:8]:
            uc = cause_uncached[cause]
            print(f"    {count:>3d} req  {uc/1000:>8.0f}K uncached  {cause}")

    conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cache health spot-check across AxonHub channels"
    )
    parser.add_argument(
        "window", nargs="?", type=int, default=DEFAULT_WINDOW_MINUTES,
        help=f"Time window in minutes (default: {DEFAULT_WINDOW_MINUTES})"
    )
    parser.add_argument(
        "--channel", "-c", type=int, default=None,
        help="Filter to a specific channel ID"
    )
    parser.add_argument(
        "--model", "-m", type=str, default=None,
        help="Filter to a specific model (SQL LIKE pattern)"
    )
    parser.add_argument(
        "--low-threshold", "-t", type=float, default=DEFAULT_LOW_THRESHOLD,
        help=f"Hit rate below this is 'low' (default: {DEFAULT_LOW_THRESHOLD})"
    )
    parser.add_argument(
        "--min-prompt", type=int, default=DEFAULT_MIN_PROMPT,
        help=f"Minimum prompt tokens to consider (default: {DEFAULT_MIN_PROMPT})"
    )
    parser.add_argument(
        "--json", "-j", action="store_true",
        help="Output machine-readable JSON"
    )
    args = parser.parse_args()

    run(
        window_minutes=args.window,
        channel_id=args.channel,
        model_id=args.model,
        low_threshold=args.low_threshold,
        min_prompt=args.min_prompt,
        json_output=args.json,
    )


if __name__ == "__main__":
    main()
