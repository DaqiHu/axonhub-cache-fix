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
        "prompt_cached_tokens INTEGER, created_at TEXT, request_id INTEGER)"
    )
    conn.execute(
        "CREATE TABLE requests ("
        "id INTEGER, request_headers TEXT, request_body TEXT, channel_id INTEGER)"
    )

    def add(row_id, agent, prompt, cached, messages, tools, system="stable"):
        headers = {
            "x-claude-code-session-id": ["session-1"],
            "x-claude-code-agent-id": [agent],
        }
        body = {
            "model": "deepseek-v4-flash",
            "system": [{"type": "text", "text": system}],
            "messages": messages,
            "tools": [{"name": name, "description": name} for name in tools],
        }
        conn.execute(
            "INSERT INTO requests VALUES (?, ?, ?, ?)",
            (row_id, json.dumps(headers), json.dumps(body), 3),
        )
        conn.execute(
            "INSERT INTO usage_logs VALUES "
            "(?, 'deepseek-v4-flash', ?, ?, datetime('now'), ?)",
            (row_id, prompt, cached, row_id),
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
    return conn


def test_detailed_classification_and_weighted_summary():
    conn = make_detailed_db()
    assert cache_report.request_metadata_available(conn)

    rows = cache_report.query_detailed_rows(conn, 10)
    classified = cache_report.classify_rows(rows)
    assert [row["classification"] for row in classified] == [
        "cold-first",
        "high-hit",
        "tools-changed",
        "system-changed",
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


def test_legacy_schema_has_no_request_metadata():
    conn = make_db("cached_tokens")
    assert not cache_report.request_metadata_available(conn)


if __name__ == "__main__":
    tests = [
        test_current_schema,
        test_legacy_schema,
        test_unsupported_schema,
        test_detailed_classification_and_weighted_summary,
        test_legacy_schema_has_no_request_metadata,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"\nCache report: {len(tests)} passed, 0 failed")
