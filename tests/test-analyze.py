import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "analyze.py"
SPEC = importlib.util.spec_from_file_location("analyze", SCRIPT)
analyze = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(analyze)


def test_request_files_sort_by_request_id():
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        for rid in (10, 2, 1):
            (root / f"axonhub_Request_{rid}.json").write_text("{}", encoding="utf-8")
        files = analyze.find_requests(root, "*Request_*.json")
        assert [analyze.request_id(path) for path in files] == [1, 2, 10]


def test_infers_request_family_from_raw_body_shape():
    assert analyze.infer_format({"input": []}) == "openai/responses"
    assert analyze.infer_format({"messages": []}) == "openai/chat_completions"
    assert analyze.infer_format({"system": [], "messages": []}) == "anthropic/messages"


def test_cache_rate_understands_anthropic_and_openai_usage():
    assert analyze.cache_stats(
        {"cache_read_input_tokens": 90, "input_tokens": 10}
    ) == (90, 100, 90.0)
    assert analyze.cache_stats(
        {"prompt_tokens": 100, "prompt_tokens_details": {"cached_tokens": 90}}
    ) == (90, 100, 90.0)
    assert analyze.cache_stats(
        {
            "cache_read_input_tokens": 90,
            "cache_creation_input_tokens": 5,
            "input_tokens": 5,
        }
    ) == (90, 100, 90.0)


def test_response_wrapper_is_matched_and_unwrapped():
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        request = root / "axonhub_Request_7.json"
        response = root / "axonhub_Response_7.json"
        request.write_text(
            json.dumps({"model": "deepseek-v4-flash", "messages": []}),
            encoding="utf-8",
        )
        response.write_text(
            json.dumps(
                {
                    "response_body": json.dumps(
                        {
                            "usage": {
                                "cache_read_input_tokens": 90,
                                "input_tokens": 10,
                            }
                        }
                    )
                }
            ),
            encoding="utf-8",
        )
        assert analyze.find_response(root, 7) == response
        result = analyze.analyze_request(request, response)
        assert result["cache"] == (90, 100, 90.0)


def test_comparison_reports_added_tools_and_system_messages():
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        first = root / "Request_1.json"
        second = root / "Request_2.json"
        first.write_text(
            json.dumps({
                "model": "deepseek-v4-flash",
                "messages": [{"role": "user", "content": "start"}],
                "tools": [{"name": "Bash"}],
            }),
            encoding="utf-8",
        )
        second.write_text(
            json.dumps({
                "model": "deepseek-v4-flash",
                "messages": [
                    {"role": "user", "content": "start"},
                    {"role": "system", "content": "meaningful"},
                ],
                "tools": [{"name": "Bash"}, {"name": "WebFetch"}],
            }),
            encoding="utf-8",
        )
        result = analyze.compare_requests(first, second)
        assert result["history_prefix"] is True
        assert result["tools_added"] == ["WebFetch"]
        assert result["appended_system"] == 1


if __name__ == "__main__":
    tests = [
        test_request_files_sort_by_request_id,
        test_infers_request_family_from_raw_body_shape,
        test_cache_rate_understands_anthropic_and_openai_usage,
        test_response_wrapper_is_matched_and_unwrapped,
        test_comparison_reports_added_tools_and_system_messages,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"\nAnalyze: {len(tests)} passed, 0 failed")
