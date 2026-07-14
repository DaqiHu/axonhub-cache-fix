import importlib.util
import json
import sqlite3
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "provider_report.py"
SPEC = importlib.util.spec_from_file_location("provider_report", SCRIPT)
provider_report = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(provider_report)


def make_db():
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE requests ("
        "id INTEGER, created_at TEXT, model_id TEXT, format TEXT, channel_id INTEGER, "
        "request_body TEXT, response_body TEXT, response_chunks TEXT, status TEXT)"
    )
    conn.execute("CREATE TABLE channels (id INTEGER, name TEXT)")
    conn.execute("INSERT INTO channels VALUES (10, 'codex-oaifree')")
    return conn


def add(conn, row_id, output, status="completed"):
    body = {
        "model": "gpt-5.6-sol",
        "input": [{"type": "additional_tools", "tools": [{"name": "shell"}]}],
    }
    response = {"output": output}
    conn.execute(
        "INSERT INTO requests VALUES "
        "(?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)",
        (
            row_id,
            "gpt-5.6-sol",
            "openai/responses",
            10,
            json.dumps(body),
            json.dumps(response),
            None,
            status,
        ),
    )


def test_detects_semantic_tool_compatibility():
    conn = make_db()
    add(conn, 1, [{"type": "custom_tool_call", "call_id": "call_1"}])
    add(conn, 2, [{"type": "message", "content": []}])

    rows = provider_report.query_rows(conn, 60)
    classified = provider_report.classify_rows(rows)
    assert classified[0]["additional_tools"] == ["shell"]
    assert classified[0]["classification"] == "compatible-tool-call"
    assert classified[0]["channel_name"] == "codex-oaifree"
    assert classified[1]["classification"] == "no-tool-call"

    expected = provider_report.classify_rows(rows, expect_tool=True)
    assert expected[1]["classification"] == "semantic-incompatibility"

    after_watermark = provider_report.query_rows(conn, 60, after_request_id=1)
    assert [row["request_id"] for row in after_watermark] == [2]


if __name__ == "__main__":
    test_detects_semantic_tool_compatibility()
    print("PASS test_detects_semantic_tool_compatibility")
    print("\nProvider report: 1 passed, 0 failed")
