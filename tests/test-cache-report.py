import importlib.util
import sqlite3
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


if __name__ == "__main__":
    tests = [test_current_schema, test_legacy_schema, test_unsupported_schema]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"\nCache report: {len(tests)} passed, 0 failed")
