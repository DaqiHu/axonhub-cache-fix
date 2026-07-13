# AxonHub Cache Fix

Optimize DeepSeek API cache hit rate for Claude Code via AxonHub proxy,
from ~25% to ~99%.

## Problem

When using Claude Code against DeepSeek's Anthropic-compatible API, four
patterns silently destroy prompt cache:

| # | Pattern | Impact | Issue |
|---|---------|--------|-------|
| 1 | `x-anthropic-billing-header` nonce in system prompt | 0% cache | [#68900](https://github.com/anthropics/claude-code/issues/68900) |
| 2 | `cache_control` fields produce different tokens across requests | cache break | DeepSeek ignores cc but raw JSON differs |
| 3 | Claude Code "eats" user text, replaces with empty `[]` | cache break | conversation restructuring |
| 4 | "task tools haven't been used recently" injection every ~5 turns | cache break | [#64192](https://github.com/anthropics/claude-code/issues/64192) |

DeepSeek uses **full-prefix matching** for cache: any byte diff anywhere
busts downstream cache. Claude Code's internal restructurings (pattern 2-4)
happen even on trivial conversations, pushing cache below 25% periodically.

## Solution

Four cache-fix proxy extensions running at controlled order:

| Order | Extension | Action |
|-------|-----------|--------|
| 46 | `prefix-hold` | Remember & restore last user msg content across requests |
| 47 | `strip-empty-system` | Delete empty & tail-injected system messages |
| 48 | `deepseek-cache-optimize` | Strip all `cache_control` fields from DeepSeek requests |
| 85 | `strip-billing-header` | Remove billing header block |

## Prerequisites

| Component | Default location | Install |
|-----------|-----------------|---------|
| AxonHub | `~/axonhub/` | Download from [axonhub.com](https://axonhub.com), extract to `~/axonhub/` |
| cache-fix proxy | `%APPDATA%\npm\node_modules\claude-code-cache-fix\` | `npm install -g claude-code-cache-fix` |
| Extensions runtime | `~/axonhub/` (shared with AxonHub) | `.\scripts\setup.ps1` |

`~/axonhub/` is both the AxonHub runtime directory and our extension directory.
Extensions, config, and logs live alongside AxonHub's `axonhub.exe` and `axonhub.db`.

## Setup

```powershell
# 1. Install dependencies
npm install -g claude-code-cache-fix

# 2. Clone this repo
git clone https://github.com/DaqiHu/axonhub-cache-fix.git
cd axonhub-cache-fix

# 3. Run setup (copies built-in extensions from npm, installs custom ones)
.\scripts\setup.ps1

# 4. Start
.\scripts\start.ps1
.\scripts\start.ps1 -Status
```

`setup.ps1` copies built-in cache-fix extensions and helpers from npm to a
local directory, then places our custom extensions on top. This isolates us
from `npm update -g claude-code-cache-fix` overwrites.

## Service Management

```powershell
.\scripts\start.ps1               # Start AxonHub + proxy (default)
.\scripts\start.ps1 -NoCacheFix    # Start AxonHub only
.\scripts\start.ps1 -Status        # Check service & extension health
.\scripts\stop.ps1                 # Stop everything
```

## Test

```powershell
node tests\test-deepseek-cache.mjs   # cc stripping (32 tests)
node tests\test-prefix-hold.mjs      # content stabilization (21 tests)
node tests\test-strip-system.mjs     # system message removal (15 tests)
node tests\test-pipeline.mjs         # integration scenarios (28 tests)
```

## Troubleshooting

| Symptom | Check |
|---------|-------|
| cache-fix won't start | `npm install -g claude-code-cache-fix` then rerun setup |
| Extensions not loaded | `.\scripts\start.ps1 -Status` — look for DEGRADED |
| Logs not appearing | Verify `~/axonhub/logs/` exists; check permissions |
| Cache still 0% | Verify billing header stripped: check `http://localhost:8090` tracing |
| Cache stuck at ~25% | Download request bodies, run `python scripts/analyze.py` |

## License

MIT
