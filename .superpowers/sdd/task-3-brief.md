### Task 3: Operator Documentation

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `.agents/skills/cache-hit-check/SKILL.md`
- Modify: `.agents/skills/cache-hit-debug/SKILL.md`
- Modify: `.agents/skills/e2e-cache-test/SKILL.md`
- Modify: `.agents/skills/session-analyze/SKILL.md`
- Modify: `tests/test-probe-docs.py`

**Interfaces:**
- Documents the archive path, formula, threshold, retention, inspection
  commands, and loss of AxonHub native translation evidence.

- [ ] Add a failing documentation contract for all required operator facts.
- [ ] Update README, AGENTS, and probe skills with the new standalone trace
  workflow.
- [ ] Run `python tests/test-probe-docs.py` and require zero failures.

