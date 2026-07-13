# AxonHub Cache Fix

Optimize DeepSeek API cache hit rate for Claude Code via AxonHub proxy,
from ~25% to ~99%.

## Problem

When using Claude Code against DeepSeek's Anthropic-compatible API, four
patterns silently destroy prompt cache:

| # | Pattern | Impact | Issue |
|---|---------|--------|-------|
| 1 | `x-anthropic-billing-header` nonce in system prompt | 0% cache | [#68900](https://github.com/anthropics/claude-code/issues/68900) |
| 2 | `cache_control` markers move across Claude Code requests | compatibility risk | Current AxonHub removes them during native translation |
| 3 | Claude Code "eats" user text, replaces with empty `[]` | cache break | conversation restructuring |
| 4 | Deferred-tools and task-tools system reminders appear mid-conversation | periodic 13-26% hit | [#64192](https://github.com/anthropics/claude-code/issues/64192) |

DeepSeek reuses only complete persisted prefix units. Claude Code's internal
message restructuring and system-message injection can invalidate the latest
large prefix unit even during trivial tool-call conversations.

## Solution

Four cache-fix proxy extensions running at controlled order:

| Order | Extension | Action |
|-------|-----------|--------|
| 46 | `prefix-hold` | Remember & restore last user msg content across requests |
| 47 | `strip-empty-system` | Delete empty messages and two exact bookkeeping reminders |
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

`setup.ps1` copies built-in cache-fix extensions and helpers into `~/axonhub`,
places custom extensions on top, and loads the generated graph with cache-fix's
real pipeline loader. Setup and start fail if any module cannot load or a
required custom extension is missing. This also prevents `/health: ok` from
hiding an empty extension registry.

## Service Management

```powershell
.\scripts\start.ps1               # Start AxonHub + proxy (default)
.\scripts\start.ps1 -NoCacheFix    # Start AxonHub only
.\scripts\start.ps1 -Status        # Check service & extension health
.\scripts\stop.ps1                 # Stop everything
```

## Autostart (Windows)

Create a shortcut in the Startup folder to run on login:

```powershell
$shortcut = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\AxonHub.lnk"
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
$link.TargetPath = "C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe"
$link.Arguments = '-WindowStyle Hidden -ExecutionPolicy Bypass -File "<repo>\scripts\start.ps1"'
$link.WorkingDirectory = "<repo>"
$link.Save()
```

Replace `<repo>` with the full path to this repository.

After login, both AxonHub (:8090) and cache-fix (:9801) start silently.
Verify with `.\scripts\start.ps1 -Status`.

## Test

```powershell
node tests\run-all.mjs               # extensions, runtime layout, pipeline, DB schema
```

## Troubleshooting

| Symptom | Check |
|---------|-------|
| cache-fix won't start | `npm install -g claude-code-cache-fix` then rerun setup |
| Extensions not loaded | `.\scripts\start.ps1 -Status` — runtime must be `VALID` |
| Logs not appearing | Verify `~/axonhub/logs/` exists; check permissions |
| Cache still 0% | Verify billing header stripped: check `http://localhost:8090` tracing |
| Cache stuck at ~25% | Download request bodies, run `python scripts/analyze.py` |

## License

MIT
