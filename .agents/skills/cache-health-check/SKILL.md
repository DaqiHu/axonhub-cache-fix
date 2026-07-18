---
name: cache-health-check
description: Use when the user wants a quick multi-channel cache health dashboard, needs to compare weighted hit rates across channels and models, or wants a regular spot-check of AxonHub prompt cache efficiency without deep-diving individual request IDs.
---

# Cache Health Check

Quick dashboard-style overview of AxonHub cache performance across all channels.

## Primary script

```powershell
python scripts/cache_health_check.py [minutes] [options]
```

## Quick usage

```powershell
# Last 60 minutes, all channels
python scripts/cache_health_check.py

# Last 2 hours
python scripts/cache_health_check.py 120

# Single channel deep-dive
python scripts/cache_health_check.py 120 --channel 1

# Machine-readable
python scripts/cache_health_check.py 120 --json

# Lower threshold for flagging (default <20%)
python scripts/cache_health_check.py 60 --low-threshold 0.50
```

## Output includes

- Per channel/model: request count, prompt tokens, **weighted hit rate**, low-cache count, high-cache count
- For channels with low-cache requests: root-cause breakdown with uncached token estimates
- Root causes: `cold-first`, `tools-changed`, `context-compacted`, `last-system:*`, `append-system:*`, `history-changed`, `bytes-drift-same-count`

## Weighted hit rate formula

```
SUM(prompt_cached_tokens) / SUM(prompt_tokens) * 100
```

Token-weighted, not request-count average. Large requests dominate the metric,
which reflects real cost savings.

## When to use

- User asks "how's the cache doing?" or "check hit rates"
- Regular health spot-check
- After enabling/disabling passthrough or changing channel config
- After a Claude Code upgrade
- Baseline comparison before/after a change

## When NOT to use

- Drill into a specific request ID → use `cache-hit-debug`
- Classify individual low-cache requests with full body diff → use `cache-hit-check --low-only`
- Session-level diff analysis → use `session-analyze`

## Extending

The script imports from the same DB schema as `cache_report.py` and `request_inspect.py`.
To add a new root-cause classifier, extend `classify_cause()` in the script.
