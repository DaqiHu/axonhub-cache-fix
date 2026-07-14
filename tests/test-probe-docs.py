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


if __name__ == "__main__":
    test_probe_docs_use_filtered_classified_commands()
    test_pattern_docs_preserve_meaningful_system_events()
    print("PASS test_probe_docs_use_filtered_classified_commands")
    print("PASS test_pattern_docs_preserve_meaningful_system_events")
    print("\nProbe docs: 2 passed, 0 failed")
