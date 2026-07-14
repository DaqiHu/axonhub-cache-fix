# AxonHub Cache Fix

Optimize DeepSeek API cache hit rate for Claude Code via AxonHub proxy,
from ~25% to ~99%.

## Problem

When using Claude Code against DeepSeek's Anthropic-compatible API, five
structural patterns can destroy prompt cache. Claude Code also emits meaningful
system events that cause expected one-time misses and must not be stripped:

| # | Pattern | Impact | Issue |
|---|---------|--------|-------|
| 1 | `x-anthropic-billing-header` nonce in system prompt | 0% cache | [#68900](https://github.com/anthropics/claude-code/issues/68900) |
| 2 | `cache_control` markers move across Claude Code requests | compatibility risk | Current AxonHub removes them during native translation |
| 3 | Claude Code "eats" user text, replaces with empty `[]` | cache break | conversation restructuring |
| 4 | Deferred-tools and task-tools system reminders appear mid-conversation | periodic 13-26% hit | [#64192](https://github.com/anthropics/claude-code/issues/64192) |
| 5 | Newly visible tools are alphabetically inserted into the existing tool list | 1-9% hit on the transition | Claude Code dynamic tool exposure |
| 6 | Worktree instructions, file-change notices, and background-task events are appended | one-time low hit | Semantic input; preserve and classify |

DeepSeek reuses only complete persisted prefix units. Claude Code's internal
message restructuring and system-message injection can invalidate the latest
large prefix unit even during trivial tool-call conversations.

## Solution

Five cache-fix proxy extensions running at controlled order:

| Order | Extension | Action |
|-------|-----------|--------|
| 46 | `prefix-hold` | Remember & restore last user msg content across requests |
| 47 | `strip-empty-system` | Delete empty messages and two exact bookkeeping reminders |
| 48 | `deepseek-cache-optimize` | Strip all `cache_control` fields from DeepSeek requests |
| 85 | `strip-billing-header` | Remove billing header block |
| 210 | `tool-order-hold` | Preserve prior tool order and append newly visible tools |

`tool-order-hold` runs after the built-in alphabetical stabilizer at order 200.
For each session, agent, model, and request family, it remembers the prior tool
name order. Tools that remain visible keep that relative order; tools that are
new in the current request are appended in their current deterministic order.
The current tool objects are reused unchanged. The extension never invents a
tool, suppresses a tool, or restores an old schema.

Standalone one-tool `web_search` requests use an independent state family.
This prevents Claude Code's internal search worker from replacing the main
conversation's remembered tool order.

## How The Dynamic-Tool Miss Was Found

The misleading symptom was a growing number of low-hit usage rows, not a
single reproducible exception. The investigation joined `usage_logs` to
`requests`, grouped rows by Claude session and agent, and compared consecutive
Anthropic request bodies. Three transitions isolated the same cause:

| Request transition | Newly visible tools | Hit after transition |
|--------------------|---------------------|---------------------:|
| `2765 -> 2767` | `SendMessage` | 1.6% |
| `2771 -> 2775` | `WebFetch`, `WebSearch` | 9.3% |
| `2813 -> 2814` | `EnterWorktree`, `ExitWorktree` | 5.1% |

Existing tool definitions were byte-identical, but the built-in
`sort-stabilization` extension sorted the complete array. A new name inserted
near the middle moved every following definition, invalidating a large prompt
suffix. The fix therefore owns only ordering: preserve the established order
and append the new definitions.

Several approaches were deliberately rejected:

- Pre-injecting every possible tool would expose tools Claude Code had not made
  available and could cause invalid tool calls.
- Keeping removed tools would change request semantics and stale their schemas.
- Sharing state only by session ID is unsafe because subagents share the parent
  session and issue unrelated concurrent histories.
- Treating every sub-90% row as a regression confuses cold agents, standalone
  search workers, large clean conversation growth, and real prefix mutation.

The state is process-local. After a proxy restart, the first request establishes
a new baseline. This intentionally avoids persisting stale tool inventories
across Claude Code or extension upgrades.

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
python scripts\cache_report.py 60 --low-only  # DeepSeek Anthropic low rows only
python scripts\cache_report.py 60 --summary   # token-weighted health summary
```

By default `cache_report.py` includes only `deepseek%` models in
`anthropic/messages`, orders by `requests.created_at`, and reads 24 hours of
lookback state so a resumed conversation is not mistaken for a new stream.
Use `--all-models --all-formats` only for an explicit cross-provider audit.

When request metadata is available, `cache_report.py` classifies rows as:

- `standalone-web-search`: Claude Code's one-message internal search worker;
- `cold-first`: the first low-hit request for a new session/agent stream;
- `tools-changed`: tool list, order, or definition changed;
- `top-system-changed`: the top-level system prompt changed;
- `appended-system`: exact history growth containing a system message;
- `history-changed`: prior messages are no longer an exact prefix;
- `large-growth`: exact old history plus at least 8k serialized chars;
- `clean-growth`: history only grew, so a lower hit may be cache construction
  timing or genuinely new content;
- `high-hit`: at least 90% of prompt tokens were served from cache.

Category summaries use `sum(prompt_cached_tokens) / sum(prompt_tokens)`, not an
unweighted average of per-request percentages. On older AxonHub schemas the
script falls back to the original basic report.

`appended-system` is a diagnostic category, not permission to delete content.
The safe strip allowlist contains only empty system messages and the two exact
bookkeeping families: deferred-tools availability and task-tools inactivity
reminders. Repository instructions, user/linter file diffs, and background-task
completion/failure notifications change model behavior and must remain.

### Trace and provider probes

Downloaded request bodies can be analyzed from any directory. Files are sorted
by numeric request ID rather than mtime:

```powershell
python scripts\analyze.py --dir .\test-data "*Request_*.json"
```

For Codex Responses provider compatibility, first run a deliberate prompt that
must invoke a tool and record a DB watermark. Then inspect the saved traces:

```powershell
python scripts\provider_report.py 30 --after-request-id <watermark> --expect-tool
```

The provider report is read-only and never sends paid requests. Without
`--expect-tool`, a completed response without `custom_tool_call` is only
`no-tool-call`, not enough evidence to declare incompatibility.

### Why sporadic low rows remain

DeepSeek states that cache construction takes seconds. Real traces show three
non-regression families: cold subagents, exact-prefix requests with large new
tool/skill content, and meaningful appended system events. One exact-prefix
request followed the previous completion by about 0.3 seconds, appended roughly
10.8k serialized chars, reused only older cache units, and recovered on the next
request. The proxy cannot repair that after the response; a blanket delay would
increase latency without guaranteeing a hit.

Representative 2026-07-14 traces:

| Request | Hit | Exact-prefix addition | Classification |
|---:|---:|---|---|
| `3883` | 34.7% | ~10.8k chars of skill/tool content, sent ~0.3s after prior completion | `large-growth`; next request recovered |
| `4032` | 0.5% | ~30.6k chars of worktree `CLAUDE.md` / `AGENTS.md` | `appended-system`; preserve |
| `4044` | 10.4% | ~8.6k chars of intentional file-change diff | `appended-system`; preserve |
| `4121`, `4131` | 0.6%, 0.9% | background-task completion/failure events | `appended-system`; preserve |

### Measured dynamic-tool benchmark

On 2026-07-14, two fresh `claude -p --model deepseek-v4-flash` sessions used
equal-length system markers and the same serial workload: Bash, ToolSearch,
then WebFetch. The disabled run inserted `WebFetch` before `Workflow`; the
enabled run appended it after the established tool order.

| Measurement | Extension disabled | Extension enabled | Reduction |
|-------------|-------------------:|------------------:|----------:|
| Dynamic transition uncached tokens | 32,211 | 27,023 | 5,188 (16.1%) |
| Whole session uncached tokens | 71,905 | 66,909 | 4,996 (6.9%) |
| Dynamic transition cache hit | 19.0% | 32.1% | +13.1 points |

Both runs completed four model turns. A separate three-Bash stable-tool run
produced one expected cold request followed by 99.9%, 99.7%, and 99.8% hits.
Across the before, after, and stable sessions, all 14 traced requests completed
without duplicate tools, orphaned tool results, missing tool results, or the
`tool_calls`/`tool_call_id` 400 error.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| cache-fix won't start | `npm install -g claude-code-cache-fix` then rerun setup |
| Extensions not loaded | `.\scripts\start.ps1 -Status` — runtime must be `VALID` |
| Logs not appearing | Verify `~/axonhub/logs/` exists; check permissions |
| Cache still 0% | Verify billing header stripped: check `http://localhost:8090` tracing |
| Cache stuck at ~25% | Run `python scripts/cache_report.py 60 --low-only`, then analyze adjacent bodies |
| 400 says `tool_calls` lack matching tool messages | Compare adjacent tool IDs in AxonHub tracing; `prefix-hold` state must be isolated by session and agent |
| Low rows increased after using web search | Exclude classified `standalone-web-search` from main-conversation conclusions |
| Low row is `appended-system` | Inspect exact text; preserve meaningful or unknown events |
| Low row is `large-growth` | Verify exact native prefix and measure appended chars/tokens |
| Miss occurs exactly when tools appear | Check `tool-order-hold.log`; existing tools must keep their prior order and new tools must be appended |
| Codex says no tools on one provider | Run a deliberate tool probe, then `python scripts/provider_report.py 30 --after-request-id <watermark> --expect-tool`; see [provider compatibility research](docs/research/2026-07-14-codex-additional-tools-provider-compatibility.md) |

## License

MIT
