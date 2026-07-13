---
name: extension-dev
description: Develop, test, and deploy cache-fix proxy extensions for the
  AxonHub + DeepSeek pipeline. Use when adding a new extension, modifying
  an existing one, or fixing a cache-breaking pattern discovered in
  Claude Code request traces.
---

# Extension Development

Develop cache-fix proxy extensions that modify `/v1/messages` request bodies
before they reach DeepSeek. Each extension runs at a fixed `order` in the
pipeline and can mutate `ctx.body`.

## Scaffold

Copy the template and register:

```bash
cp scripts/template.mjs extensions/<name>.mjs
# Edit: replace $NAME, $DESC, $ORDER
# Register in extensions/extensions.json
```

## Template structure

```js
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Log to fixed system path; falls back to ~/.axonhub-cache-fix/logs/
const LOG_DIR = process.env.AXONHUB_CACHE_FIX_LOG_DIR
  || join(homedir(), ".axonhub-cache-fix", "logs");

function log(msg) {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  const line = `[${new Date().toISOString()}] <name>: ${msg}\n`;
  try { appendFileSync(join(LOG_DIR, "<name>.log"), line); } catch {}
}

export default {
  name: "<name>",
  description: "<what it does>",
  order: <number>,

  async onRequest(ctx) {
    const { body } = ctx;
    if (!body) return;
    // Your mutation logic here
    log("processed request");
  },
};
```

## Log contract

Every extension MUST write structured logs to `LOG_DIR/<extension-name>.log`.
Log format: `[ISO8601] <extension-name>: <message>`.
Log at minimum: first request (session start), every body mutation (what changed),
and any skip/error conditions.

## Development workflow

1. **Write extension** using the template above
2. **Write unit tests** in `tests/test-<name>.mjs`:
   ```js
   // Pattern:
   import { pathToFileURL } from "node:url";
   const ext = (await import(pathToFileURL("extensions/<name>.mjs").href)).default;
   // Test with realistic body objects
   const ctx = { body: { model: "deepseek-v4-flash", messages: [...] } };
   await ext.onRequest(ctx);
   // Assert ctx.body was mutated correctly
   ```
3. **Test in isolation**: `node tests/test-<name>.mjs`
4. **Register**: Add to `extensions/extensions.json` with the chosen order
5. **Full suite**: `node tests/run-all.mjs`
6. **Deploy**: Restart services (`scripts/start.ps1`)

## Where to get test fixtures

Download real request bodies from AxonHub tracing:
1. http://localhost:8090 → Tracing → Requests
2. Find requests showing the problematic pattern
3. Download as JSON
4. Extract the relevant message structure as test data

## Process — real observations into fixes

The standard loop:

1. User reports cache hit drops at specific request IDs
2. Download request bodies from those IDs
3. Run `python scripts/analyze.py` to check byte-level consistency
4. Identify the pattern (see `references/patterns.md`)
5. Write an extension to fix the pattern
6. Write tests using the downloaded body as fixture
7. Deploy and verify cache hit improvement

## Order assignment

Lower = runs earlier. Current pipeline:

| Order | Extension | Why this order |
|-------|-----------|----------------|
| 46 | prefix-hold | Must see original user positions before any modification |
| 47 | strip-empty-system | Remove system noise early |
| 48 | deepseek-cache-optimize | Strip cc after content is stabilized |
| 85 | strip-billing-header | Can run after cc strip (billing header is separate) |

New extensions should pick an order that runs BEFORE or AFTER existing
extensions based on whether they need original or stabilized content.

## Log location

All extension logs go to `$env:LOCALAPPDATA\axonhub-cache-fix\logs\`
(fallback: `~/.axonhub-cache-fix/logs/`).

To view recent activity across all extensions:
```bash
ls -t $env:LOCALAPPDATA\axonhub-cache-fix\logs\
tail -3 $env:LOCALAPPDATA\axonhub-cache-fix\logs\*.log
```
