### Task 2: Runtime Configuration And Health

**Files:**
- Modify: `scripts/supervise.ps1`
- Modify: `scripts/runtime-common.ps1`
- Modify: `scripts/runtime-health.ps1`
- Modify: `tests/test-runtime-common.ps1`
- Modify: `tests/test-service-scripts.ps1`

**Interfaces:**
- `Get-CacheFixEnvironment` supplies threshold, retention, and directory.
- `Get-DirectoryHealth` returns aggregate archive bytes and warning state.

- [ ] Add failing tests for exact environment defaults and aggregate directory
  health without file mutation.
- [ ] Implement the environment and health helpers.
- [ ] Run both PowerShell focused suites and require zero failures.

