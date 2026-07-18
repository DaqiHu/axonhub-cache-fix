import importlib.util
import io
import json
import sqlite3
import sys
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "request_inspect.py"
SPEC = importlib.util.spec_from_file_location("request_inspect", SCRIPT)
request_inspect = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(request_inspect)


def _make_db(path: Path):
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE requests (
            id INTEGER PRIMARY KEY,
            created_at TEXT,
            updated_at TEXT,
            model_id TEXT,
            channel_id INTEGER,
            format TEXT,
            status TEXT,
            stream INTEGER,
            request_headers TEXT,
            request_body TEXT
        );
        CREATE TABLE usage_logs (
            id INTEGER PRIMARY KEY,
            request_id INTEGER,
            prompt_tokens INTEGER,
            prompt_cached_tokens INTEGER,
            completion_tokens INTEGER,
            total_tokens INTEGER,
            model_id TEXT,
            channel_id INTEGER,
            format TEXT,
            created_at TEXT
        );
        """
    )
    return conn


def _body(messages, tools=None):
    return json.dumps(
        {
            "model": "deepseek-v4-pro",
            "system": [{"type": "text", "text": "You are Claude Code"}],
            "messages": messages,
            "tools": tools
            or [
                {"name": "Bash"},
                {"name": "Skill"},
            ],
        },
        ensure_ascii=False,
    )


def test_classify_system_kinds():
    assert (
        request_inspect.classify_system(
            "The following skills are available for use with the Skill tool:\n\n- task-handoff: x"
        )
        == "skills-listing"
    )
    assert (
        request_inspect.classify_system(
            "The following deferred tools are now available via ToolSearch.\n- Foo"
        )
        == "deferred-tools"
    )
    assert (
        request_inspect.classify_system(
            "The task tools haven't been used recently. Consider TaskCreate."
        )
        == "task-tools"
    )
    assert (
        request_inspect.classify_system(
            "The user sent a new message while you were working:\nhello"
        )
        == "mid-turn-user-inject"
    )
    assert (
        request_inspect.classify_system(
            "[SYSTEM NOTIFICATION - NOT USER INPUT]\nAgent finished"
        )
        == "background-notification"
    )


def test_compare_detects_skills_listing_append_and_stable_listing():
    prev_messages = [
        {"role": "user", "content": "start"},
        {"role": "assistant", "content": "ok"},
    ]
    curr_with_listing = prev_messages + [
        {
            "role": "system",
            "content": (
                "The following skills are available for use with the Skill tool:\n\n"
                "- task-handoff: Use when dispatching"
            ),
        }
    ]
    prev = {
        "id": 1,
        "tools": ["Bash", "Skill"],
        "skills_positions": [],
        "last_role": "assistant",
        "usage": None,
        "_body": {"system": "s", "tools": [{"name": "Bash"}, {"name": "Skill"}]},
        "_messages": prev_messages,
    }
    curr = {
        "id": 2,
        "tools": ["Bash", "Skill"],
        "skills_positions": [2],
        "last_role": "system",
        "usage": None,
        "_body": {"system": "s", "tools": [{"name": "Bash"}, {"name": "Skill"}]},
        "_messages": curr_with_listing,
    }
    result = request_inspect.compare(prev, curr)
    assert result["history_prefix"] is True
    assert result["skills_listing_changed"] is True
    assert result["appended"][0]["kind"] == "skills-listing"

    # Stable listing mid-history should not look like a skills-listing regression
    stable_prev_messages = [
        {"role": "user", "content": "start"},
        {
            "role": "system",
            "content": "The following skills are available for use with the Skill tool:\n- x: y",
        },
        {"role": "assistant", "content": "ok"},
    ]
    stable_curr_messages = stable_prev_messages + [
        {
            "role": "system",
            "content": "The user sent a new message while you were working:\nping",
        }
    ]
    stable_prev = {
        "id": 10,
        "tools": ["Bash"],
        "skills_positions": [1],
        "last_role": "assistant",
        "usage": None,
        "_body": {"system": "s", "tools": [{"name": "Bash"}]},
        "_messages": stable_prev_messages,
    }
    stable_curr = {
        "id": 11,
        "tools": ["Bash"],
        "skills_positions": [1],
        "last_role": "system",
        "usage": None,
        "_body": {"system": "s", "tools": [{"name": "Bash"}]},
        "_messages": stable_curr_messages,
    }
    stable = request_inspect.compare(stable_prev, stable_curr)
    assert stable["skills_listing_changed"] is False
    assert stable["appended"][0]["kind"] == "mid-turn-user-inject"


def test_load_request_and_cli_json(tmp_path: Path | None = None):
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        db = root / "axonhub.db"
        conn = _make_db(db)
        prev_body = _body(
            [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": [{"type": "text", "text": "hi"}]},
            ]
        )
        curr_body = _body(
            [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": [{"type": "text", "text": "hi"}]},
                {
                    "role": "system",
                    "content": (
                        "The following skills are available for use with the Skill tool:\n"
                        "- report-markdown: dump notes"
                    ),
                },
            ]
        )
        conn.execute(
            """
            INSERT INTO requests
            (id, created_at, updated_at, model_id, channel_id, format, status, stream,
             request_headers, request_body)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                100,
                "2026-07-18 00:00:00",
                "2026-07-18 00:00:01",
                "deepseek-v4-pro",
                1,
                "anthropic/messages",
                "completed",
                1,
                json.dumps({"X-Claude-Code-Session-Id": "ses-1"}),
                prev_body,
            ),
        )
        conn.execute(
            """
            INSERT INTO requests
            (id, created_at, updated_at, model_id, channel_id, format, status, stream,
             request_headers, request_body)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                101,
                "2026-07-18 00:00:02",
                "2026-07-18 00:00:03",
                "deepseek-v4-pro",
                1,
                "anthropic/messages",
                "completed",
                1,
                json.dumps({"X-Claude-Code-Session-Id": "ses-1"}),
                curr_body,
            ),
        )
        conn.execute(
            """
            INSERT INTO usage_logs
            (id, request_id, prompt_tokens, prompt_cached_tokens, completion_tokens,
             total_tokens, model_id, channel_id, format, created_at)
            VALUES (1, 100, 1000, 990, 10, 1010, 'deepseek-v4-pro', 1,
                    'anthropic/messages', '2026-07-18 00:00:01')
            """
        )
        conn.execute(
            """
            INSERT INTO usage_logs
            (id, request_id, prompt_tokens, prompt_cached_tokens, completion_tokens,
             total_tokens, model_id, channel_id, format, created_at)
            VALUES (2, 101, 1200, 20, 10, 1210, 'deepseek-v4-pro', 1,
                    'anthropic/messages', '2026-07-18 00:00:03')
            """
        )
        conn.commit()
        conn.close()

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = request_inspect.main(
                ["101", "--db", str(db), "--compare-prev", "--neighbors", "1", "--json"]
            )
        assert code == 0
        payload = json.loads(buf.getvalue())
        assert payload["compare"]["skills_listing_changed"] is True
        assert payload["compare"]["appended"][0]["kind"] == "skills-listing"
        assert payload["requests"][0]["usage"]["hit_rate_pct"] == 1.6667


def test_parse_ids_accepts_hash_and_csv():
    assert request_inspect.parse_ids(["#22412", "24771,24772"]) == [22412, 24771, 24772]


if __name__ == "__main__":
    import io
    from contextlib import redirect_stdout

    with redirect_stdout(io.StringIO()):
        test_classify_system_kinds()
        test_compare_detects_skills_listing_append_and_stable_listing()
        test_load_request_and_cli_json()
        test_parse_ids_accepts_hash_and_csv()
    print("test-request-inspect.py: all passed")
