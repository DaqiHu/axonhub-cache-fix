from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_probe_docs_use_filtered_classified_commands():
    files = [
        ROOT / "README.md",
        ROOT / "AGENTS.md",
        ROOT / ".agents/skills/cache-hit-check/SKILL.md",
        ROOT / ".agents/skills/cache-hit-debug/SKILL.md",
        ROOT / ".agents/skills/e2e-cache-test/SKILL.md",
        ROOT / ".agents/skills/session-analyze/SKILL.md",
        ROOT / ".agents/skills/extension-dev/SKILL.md",
    ]
    for path in files:
        text = path.read_text(encoding="utf-8")
        assert "cache_report.py" in text, path
        assert "--low-only" in text, path
    combined = "\n".join(path.read_text(encoding="utf-8") for path in files)
    assert "provider_report.py" in combined
    assert "appended-system" in combined
    assert "large-growth" in combined
    assert "only the first request" not in combined.lower()


def test_pattern_docs_preserve_meaningful_system_events():
    patterns = (ROOT / ".agents/skills/extension-dev/references/patterns.md").read_text(
        encoding="utf-8"
    )
    assert "background-task" in patterns
    assert "must be preserved" in patterns
    assert "removes all contentful system messages after the last user" not in patterns.lower()


def test_runtime_resilience_docs_cover_operational_contract():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    debug = (ROOT / ".agents/skills/cache-hit-debug/SKILL.md").read_text(
        encoding="utf-8"
    )
    check = (ROOT / ".agents/skills/cache-hit-check/SKILL.md").read_text(
        encoding="utf-8"
    )
    e2e = (ROOT / ".agents/skills/e2e-cache-test/SKILL.md").read_text(
        encoding="utf-8"
    )
    combined = "\n".join([readme, agents, debug, check, e2e])

    assert "supervise.ps1" in combined
    assert "runtime-health.ps1" in combined
    assert "maintain-db.ps1" in combined
    assert "busy_timeout(10000)" in combined
    assert "upstream-error-bodies.jsonl" in combined
    assert "request retention" in combined.lower()
    assert "1 day" in combined.lower()
    assert "online vacuum" in combined.lower()
    assert "does not scan request bodies" in combined.lower()

    assert "runtime-health.ps1" in debug
    assert "upstream-error-bodies.jsonl" in debug
    assert "supervise.ps1" in readme
    assert "maintain-db.ps1" in readme
    assert "busy_timeout(10000)" in agents
    assert "does not scan request bodies" in check.lower()
    assert "upstream-error-bodies.jsonl" in e2e


if __name__ == "__main__":
    test_probe_docs_use_filtered_classified_commands()
    test_pattern_docs_preserve_meaningful_system_events()
    test_runtime_resilience_docs_cover_operational_contract()
    print("PASS test_probe_docs_use_filtered_classified_commands")
    print("PASS test_pattern_docs_preserve_meaningful_system_events")
    print("PASS test_runtime_resilience_docs_cover_operational_contract")
    print("\nProbe docs: 3 passed, 0 failed")
