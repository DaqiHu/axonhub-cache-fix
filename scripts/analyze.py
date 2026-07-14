"""Analyze downloaded AxonHub request bodies in deterministic request order."""

import argparse
import json
import re
import sys
from pathlib import Path


REQUEST_ID_RE = re.compile(r"(?:Request[_ -]?|request[_ -]?)(\d+)", re.IGNORECASE)


def request_id(path):
    match = REQUEST_ID_RE.search(path.stem)
    if match:
        return int(match.group(1))
    numbers = re.findall(r"\d+", path.stem)
    return int(numbers[-1]) if numbers else -1


def find_requests(directory, pattern="*Request_*.json"):
    return sorted(Path(directory).glob(pattern), key=lambda path: (request_id(path), path.name))


def find_response(directory, rid):
    candidates = [
        path
        for path in Path(directory).glob("*.json")
        if request_id(path) == rid and "response" in path.name.lower()
    ]
    return sorted(candidates, key=lambda path: path.name)[0] if candidates else None


def _load(path):
    with open(path, encoding="utf-8") as handle:
        value = json.load(handle)
    if isinstance(value, dict) and "request_body" in value:
        body = value["request_body"]
        if isinstance(body, str):
            body = json.loads(body)
        if isinstance(body, dict):
            metadata = {
                "format": value.get("format"),
                "channel": value.get("channel_id"),
                "provider": value.get("provider") or value.get("channel_name"),
            }
            return body, metadata
    if isinstance(value, dict) and "response_body" in value:
        body = value["response_body"]
        if isinstance(body, str):
            body = json.loads(body)
        if isinstance(body, dict):
            return body, {}
    return value, {}


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _tool_names(body):
    tools = body.get("tools", []) if isinstance(body, dict) else []
    return [
        tool.get("name")
        for tool in tools
        if isinstance(tool, dict) and isinstance(tool.get("name"), str)
    ]


def _count_cache_control(value):
    if isinstance(value, dict):
        return int("cache_control" in value) + sum(
            _count_cache_control(item) for item in value.values()
        )
    if isinstance(value, list):
        return sum(_count_cache_control(item) for item in value)
    return 0


def infer_format(body):
    if not isinstance(body, dict):
        return "unknown"
    if "input" in body:
        return "openai/responses"
    if "system" in body and "messages" in body:
        return "anthropic/messages"
    if "messages" in body:
        return "openai/chat_completions"
    return "unknown"


def cache_stats(usage):
    if not isinstance(usage, dict):
        return None
    if "cache_read_input_tokens" in usage:
        cached = int(usage.get("cache_read_input_tokens") or 0)
        uncached = int(usage.get("input_tokens") or 0)
        created = int(usage.get("cache_creation_input_tokens") or 0)
        total = cached + created + uncached
    else:
        cached = int(
            (usage.get("prompt_tokens_details") or {}).get("cached_tokens")
            or usage.get("prompt_cache_hit_tokens")
            or 0
        )
        total = int(usage.get("prompt_tokens") or 0)
    rate = cached / total * 100 if total else 0.0
    return cached, total, round(rate, 1)


def analyze_request(req_path, resp_path=None):
    req, metadata = _load(req_path)
    messages = req.get("messages", []) if isinstance(req, dict) else []
    system_messages = [
        message
        for message in messages
        if isinstance(message, dict) and message.get("role") == "system"
    ]
    trailing_system = 0
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "system":
            trailing_system += 1
        else:
            break

    result = {
        "rid": request_id(req_path),
        "messages": len(messages),
        "cc": _count_cache_control(req),
        "system_messages": len(system_messages),
        "trailing_system": trailing_system,
        "model": req.get("model", "?") if isinstance(req, dict) else "?",
        "format": metadata.get("format") or infer_format(req),
        "channel": metadata.get("channel"),
        "provider": metadata.get("provider"),
        "tools": _tool_names(req),
        "size": req_path.stat().st_size,
    }
    if resp_path and resp_path.exists():
        response, _ = _load(resp_path)
        stats = cache_stats(response.get("usage", {}) if isinstance(response, dict) else {})
        if stats:
            result["cache"] = stats
    return result


def compare_requests(first_path, second_path):
    with open(first_path, encoding="utf-8") as handle:
        raw1 = handle.read()
    with open(second_path, encoding="utf-8") as handle:
        raw2 = handle.read()
    first, _ = _load(first_path)
    second, _ = _load(second_path)

    first_byte = next(
        (index for index, pair in enumerate(zip(raw1, raw2)) if pair[0] != pair[1]),
        None,
    )
    byte_prefix = (
        min(len(raw1), len(raw2)) if first_byte is None else first_byte
    )
    first_messages = first.get("messages", [])
    second_messages = second.get("messages", [])
    first_message = next(
        (
            index
            for index in range(min(len(first_messages), len(second_messages)))
            if _canonical(first_messages[index]) != _canonical(second_messages[index])
        ),
        None,
    )
    history_prefix = (
        len(second_messages) >= len(first_messages)
        and second_messages[: len(first_messages)] == first_messages
    )
    appended = second_messages[len(first_messages):] if history_prefix else []
    first_tools = _tool_names(first)
    second_tools = _tool_names(second)

    return {
        "first_byte": first_byte,
        "byte_prefix_pct": byte_prefix / len(raw1) * 100 if raw1 else 100.0,
        "first_message": first_message,
        "history_prefix": history_prefix,
        "top_system_same": _canonical(first.get("system")) == _canonical(second.get("system")),
        "tools_same": _canonical(first.get("tools", [])) == _canonical(second.get("tools", [])),
        "tools_added": [name for name in second_tools if name not in first_tools],
        "tools_removed": [name for name in first_tools if name not in second_tools],
        "growth": len(second_messages) - len(first_messages),
        "growth_chars": sum(len(_canonical(message)) for message in appended),
        "appended_system": sum(
            1
            for message in appended
            if isinstance(message, dict) and message.get("role") == "system"
        ),
    }


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("patterns", nargs="*", default=["*Request_*.json"])
    parser.add_argument("--dir", type=Path, default=Path.cwd())
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    patterns = args.patterns or ["*Request_*.json"]
    files = []
    for pattern in patterns:
        files.extend(find_requests(args.dir, pattern))
    files = sorted(set(files), key=lambda path: (request_id(path), path.name))
    if not files:
        print(f"No request files in {args.dir} for: {', '.join(patterns)}")
        return 1

    print("=== Request Analysis ===")
    for path in files:
        result = analyze_request(path, find_response(args.dir, request_id(path)))
        scope = f"model={result['model']} format={result['format']}"
        if result["channel"] is not None:
            scope += f" channel={result['channel']}"
        print(
            f"{result['rid']}: msgs={result['messages']} cc={result['cc']} "
            f"system={result['system_messages']} trailing_system={result['trailing_system']} "
            f"tools={len(result['tools'])} {scope}"
        )
        if "cache" in result:
            cached, total, rate = result["cache"]
            print(f"  cache={cached}/{total} {rate:.1f}%")

    print("\n=== Consecutive Comparison ===")
    for first, second in zip(files, files[1:]):
        result = compare_requests(first, second)
        print(
            f"{request_id(first)}->{request_id(second)}: "
            f"byte_prefix={result['byte_prefix_pct']:.1f}% "
            f"first_msg={result['first_message']} history_prefix={result['history_prefix']} "
            f"top_system_same={result['top_system_same']} tools_same={result['tools_same']} "
            f"added={','.join(result['tools_added']) or '-'} "
            f"removed={','.join(result['tools_removed']) or '-'} "
            f"growth={result['growth']:+d}/{result['growth_chars']}c "
            f"appended_system={result['appended_system']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
