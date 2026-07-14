import importlib.util
import io
import json
import sqlite3
from contextlib import redirect_stdout
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "cache_report.py"
SPEC = importlib.util.spec_from_file_location("cache_report", SCRIPT)
cache_report = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cache_report)


def make_db(column):
    conn = sqlite3.connect(":memory:")
    conn.execute(
        f"CREATE TABLE usage_logs ("
        f"id INTEGER, prompt_tokens INTEGER, {column} INTEGER, created_at TEXT)"
    )
    conn.execute(
        f"INSERT INTO usage_logs "
        f"(id, prompt_tokens, {column}, created_at) "
        f"VALUES (1, 100, 99, datetime('now'))"
    )
    return conn


def test_current_schema():
    conn = make_db("prompt_cached_tokens")
    assert cache_report.cache_column(conn) == "prompt_cached_tokens"
    rows = cache_report.query_rows(conn, 10)
    assert rows[0][0:4] == (1, 100, 99, 99.0)


def test_legacy_schema():
    conn = make_db("cached_tokens")
    assert cache_report.cache_column(conn) == "cached_tokens"
    rows = cache_report.query_rows(conn, 10)
    assert rows[0][0:4] == (1, 100, 99, 99.0)


def test_unsupported_schema():
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE usage_logs "
        "(id INTEGER, prompt_tokens INTEGER, created_at TEXT)"
    )
    try:
        cache_report.cache_column(conn)
    except RuntimeError as error:
        assert "cache token column" in str(error)
    else:
        raise AssertionError("unsupported schema should raise RuntimeError")


def make_detailed_db():
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE usage_logs ("
        "id INTEGER, model_id TEXT, prompt_tokens INTEGER, "
        "prompt_cached_tokens INTEGER, created_at TEXT, request_id INTEGER, "
        "format TEXT)"
    )
    conn.execute(
        "CREATE TABLE requests ("
        "id INTEGER, created_at TEXT, model_id TEXT, format TEXT, "
        "request_headers TEXT, request_body TEXT, channel_id INTEGER)"
    )

    def add(
        row_id,
        agent,
        prompt,
        cached,
        messages,
        tools,
        system="stable",
        model="deepseek-v4-flash",
        request_created="datetime('now')",
        usage_created="datetime('now')",
        request_format="anthropic/messages",
    ):
        headers = {
            "x-claude-code-session-id": ["session-1"],
            "x-claude-code-agent-id": [agent],
        }
        body = {
            "model": model,
            "system": [{"type": "text", "text": system}],
            "messages": messages,
            "tools": [{"name": name, "description": name} for name in tools],
        }
        conn.execute(
            f"INSERT INTO requests VALUES (?, {request_created}, ?, ?, ?, ?, ?)",
            (
                row_id,
                model,
                request_format,
                json.dumps(headers),
                json.dumps(body),
                3,
            ),
        )
        conn.execute(
            "INSERT INTO usage_logs VALUES "
            f"(?, ?, ?, ?, {usage_created}, ?, ?)",
            (row_id, model, prompt, cached, row_id, request_format),
        )

    m1 = [{"role": "user", "content": "start"}]
    m2 = m1 + [{"role": "assistant", "content": "ok"}]
    m3 = m2 + [{"role": "user", "content": "next"}]
    m4 = m3 + [{"role": "assistant", "content": "next-ok"}]
    rewritten = [{"role": "user", "content": "rewritten"}]
    grown = rewritten + [{"role": "assistant", "content": "grown"}]
    grown_again = grown + [{"role": "user", "content": "again"}]

    add(1, "agent-a", 100, 0, m1, ["Bash"])
    add(2, "agent-a", 1000, 950, m2, ["Bash"])
    add(3, "agent-a", 100, 10, m3, ["Bash", "WebFetch"])
    add(4, "agent-a", 100, 20, m4, ["Bash", "WebFetch"], system="changed")
    add(5, "agent-a", 100, 30, rewritten, ["Bash", "WebFetch"], system="changed")
    add(6, "agent-a", 100, 0, grown, ["Bash", "WebFetch"], system="changed")
    add(7, "agent-a", 900, 450, grown_again, ["Bash", "WebFetch"], system="changed")
    add(8, "agent-a", 100, 2, m1, ["web_search"])
    add(
        9,
        "agent-a",
        100,
        0,
        m1,
        ["Bash"],
        model="gpt-5.6-sol",
    )
    return conn


def test_detailed_classification_and_weighted_summary():
    conn = make_detailed_db()
    assert cache_report.request_metadata_available(conn)

    rows = cache_report.query_detailed_rows(conn, 10, lookback_minutes=60)
    classified = cache_report.classify_rows(rows)
    assert [row["classification"] for row in classified] == [
        "cold-first",
        "high-hit",
        "tools-changed",
        "top-system-changed",
        "history-changed",
        "clean-growth",
        "clean-growth",
        "standalone-web-search",
    ]

    output = io.StringIO()
    with redirect_stdout(output):
        cache_report.print_detailed_report(classified, 10)
    report = output.getvalue()
    assert "clean-growth" in report
    assert "2 requests" in report
    assert "45.0% weighted" in report
    assert "SYSTEM INJECTION" not in report


def test_default_query_excludes_foreign_models_and_formats():
    conn = make_detailed_db()
    rows = cache_report.query_detailed_rows(conn, 10, lookback_minutes=60)
    assert {row["model_id"] for row in rows} == {"deepseek-v4-flash"}
    assert {row["format"] for row in rows} == {"anthropic/messages"}


def test_health_summary_uses_filtered_usage_aggregates():
    conn = make_detailed_db()
    summary = cache_report.query_health_summary(conn, 10)
    assert summary["requests"] == 8
    assert summary["low_requests"] == 7
    assert summary["model_pattern"] == "deepseek%"
    assert summary["format"] == "anthropic/messages"
    assert summary["prompt_tokens"] == 2500
    assert summary["cached_tokens"] == 1462


def test_query_orders_by_request_creation_and_keeps_lookback_state():
    conn = make_detailed_db()
    messages = [{"role": "user", "content": "old"}]
    headers = {
        "x-claude-code-session-id": ["lookback-session"],
        "x-claude-code-agent-id": ["lookback-agent"],
    }
    body1 = {
        "model": "deepseek-v4-flash",
        "system": [],
        "messages": messages,
        "tools": [{"name": "Bash"}],
    }
    body2 = dict(body1, messages=messages + [{"role": "assistant", "content": "new"}])
    conn.execute(
        "INSERT INTO requests VALUES "
        "(20, datetime('now', '-11 minutes'), ?, ?, ?, ?, ?)",
        ("deepseek-v4-flash", "anthropic/messages", json.dumps(headers), json.dumps(body1), 3),
    )
    conn.execute(
        "INSERT INTO requests VALUES "
        "(21, datetime('now', '-1 minute'), ?, ?, ?, ?, ?)",
        ("deepseek-v4-flash", "anthropic/messages", json.dumps(headers), json.dumps(body2), 3),
    )
    # Completion order is intentionally reversed.
    conn.execute(
        "INSERT INTO usage_logs VALUES "
        "(20, ?, 100, 0, datetime('now'), 20, ?)",
        ("deepseek-v4-flash", "anthropic/messages"),
    )
    conn.execute(
        "INSERT INTO usage_logs VALUES "
        "(21, ?, 100, 10, datetime('now', '-2 minutes'), 21, ?)",
        ("deepseek-v4-flash", "anthropic/messages"),
    )

    rows = cache_report.query_detailed_rows(conn, 10, lookback_minutes=60)
    lookback_rows = [row for row in rows if row["request_id"] in (20, 21)]
    assert [row["request_id"] for row in lookback_rows] == [20, 21]
    classified = cache_report.classify_rows(lookback_rows)
    visible = [row for row in classified if row["in_window"]]
    assert [row["request_id"] for row in visible] == [21]
    assert visible[0]["classification"] == "clean-growth"

    scoped = cache_report.query_detailed_rows(
        conn, 10, lookback_minutes=60, after_request_id=20
    )
    scoped_visible = [row for row in scoped if row["in_window"]]
    assert [row["request_id"] for row in scoped_visible] == [21]
    scoped_classified = cache_report.classify_rows(scoped)
    assert [row for row in scoped_classified if row["in_window"]][0][
        "classification"
    ] == "clean-growth"


def test_appended_system_and_large_growth_are_distinct():
    base = {
        "id": 1,
        "request_id": 1,
        "model_id": "deepseek-v4-flash",
        "format": "anthropic/messages",
        "prompt_tokens": 100,
        "cached_tokens": 0,
        "pct": 0.0,
        "request_headers": {
            "x-claude-code-session-id": ["s"],
            "x-claude-code-agent-id": ["a"],
        },
        "channel_id": 3,
        "in_window": True,
    }
    first = dict(
        base,
        request_body={
            "model": "deepseek-v4-flash",
            "system": [],
            "messages": [{"role": "user", "content": "start"}],
            "tools": [{"name": "Bash"}],
        },
    )
    appended_system = dict(
        base,
        id=2,
        request_id=2,
        request_body=dict(
            first["request_body"],
            messages=first["request_body"]["messages"]
            + [{"role": "system", "content": "meaningful" * 1000}],
        ),
    )
    large_growth = dict(
        base,
        id=3,
        request_id=3,
        request_body=dict(
            appended_system["request_body"],
            messages=appended_system["request_body"]["messages"]
            + [{"role": "user", "content": "x" * 25000}],
        ),
    )

    rows = cache_report.classify_rows([first, appended_system, large_growth])
    assert rows[1]["classification"] == "appended-system"
    assert rows[1]["appended_system_chars"] >= 10000
    assert rows[2]["classification"] == "large-growth"
    assert rows[2]["growth_chars"] >= 25000


def test_ten_kilobyte_exact_prefix_growth_is_not_called_clean():
    base = {
        "id": 1,
        "request_id": 1,
        "model_id": "deepseek-v4-flash",
        "format": "anthropic/messages",
        "prompt_tokens": 100,
        "cached_tokens": 0,
        "pct": 0.0,
        "request_headers": {
            "x-claude-code-session-id": ["growth-session"],
            "x-claude-code-agent-id": ["growth-agent"],
        },
        "channel_id": 3,
        "in_window": True,
    }
    first_messages = [{"role": "user", "content": "start"}]
    first = dict(
        base,
        request_body={
            "model": "deepseek-v4-flash",
            "system": [],
            "messages": first_messages,
            "tools": [{"name": "Bash"}],
        },
    )
    second = dict(
        base,
        id=2,
        request_id=2,
        request_body=dict(
            first["request_body"],
            messages=first_messages + [{"role": "user", "content": "x" * 10000}],
        ),
    )
    rows = cache_report.classify_rows([first, second])
    assert rows[1]["classification"] == "large-growth"


def test_low_only_output_is_concise_and_identifies_model_and_format():
    conn = make_detailed_db()
    rows = cache_report.classify_rows(
        cache_report.query_detailed_rows(conn, 10, lookback_minutes=60)
    )
    output = io.StringIO()
    with redirect_stdout(output):
        cache_report.print_detailed_report(rows, 10, low_only=True)
    report = output.getvalue()
    assert "deepseek-v4-flash" in report
    assert "anthropic/messages" in report
    assert "req=   2" not in report


def test_legacy_schema_has_no_request_metadata():
    conn = make_db("cached_tokens")
    assert not cache_report.request_metadata_available(conn)


if __name__ == "__main__":
    tests = [
        test_current_schema,
        test_legacy_schema,
        test_unsupported_schema,
        test_detailed_classification_and_weighted_summary,
        test_default_query_excludes_foreign_models_and_formats,
        test_health_summary_uses_filtered_usage_aggregates,
        test_query_orders_by_request_creation_and_keeps_lookback_state,
        test_appended_system_and_large_growth_are_distinct,
        test_ten_kilobyte_exact_prefix_growth_is_not_called_clean,
        test_low_only_output_is_concise_and_identifies_model_and_format,
        test_legacy_schema_has_no_request_metadata,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"\nCache report: {len(tests)} passed, 0 failed")
