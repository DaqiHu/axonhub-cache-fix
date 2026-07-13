---
name: cache-hit-check
description: "Query AxonHub cache hit rates from the SQLite database, web UI, or response files. Use when checking cache, asking about cache hit rate, or monitoring DeepSeek prompt cache efficiency."
---

# Cache Hit Check

Query DeepSeek cache hit rates across all available data sources.

## Fastest: SQLite query

```bash
python -c "
import sqlite3
conn = sqlite3.connect(r'C:\Users\hudaq\axonhub\axonhub.db')
rows = conn.execute('''
    SELECT prompt_tokens, cached_tokens,
           ROUND(CAST(cached_tokens AS REAL)/prompt_tokens*100,1) as pct,
           created_at
    FROM usage_logs ORDER BY created_at DESC LIMIT 20
''').fetchall()
for r in rows:
    flag = ' !!' if r[2] < 90 else ''
    print(f'{r[3][:19]}  hit={r[1]:>6}/{r[0]:>6} ={r[2]:>5.1f}%{flag}')
conn.close()
"
```

Columns in `usage_logs`: `prompt_tokens` (total), `cached_tokens` (cache hit), `created_at`, `format`, `request_id`.

Flag anything below 90% — those are the injection drops.

## Recent cache health

```bash
python -c "
import sqlite3
conn = sqlite3.connect(r'C:\Users\hudaq\axonhub\axonhub.db')

# Last 50 requests hit rate distribution
rows = conn.execute('''
    SELECT ROUND(CAST(cached_tokens AS REAL)/prompt_tokens*100) as bucket,
           COUNT(*)
    FROM usage_logs
    WHERE created_at > datetime('now', '-1 hour')
    GROUP BY bucket ORDER BY bucket
''').fetchall()

total = sum(r[1] for r in rows)
print('Last hour cache distribution:')
for bucket, count in rows:
    bar = '#' * (count * 40 // max(r[1] for r in rows))
    pct = count / total * 100
    print(f'  {bucket:>3}%: {bar} ({count} reqs, {pct:.0f}%)')
if not rows:
    print('  No data in last hour')
conn.close()
"
```

## Find specific low-hit requests

```bash
python -c "
import sqlite3, json
conn = sqlite3.connect(r'C:\Users\hudaq\axonhub\axonhub.db')

# Find requests below 50% cache hit
rows = conn.execute('''
    SELECT id, prompt_tokens, cached_tokens,
           ROUND(CAST(cached_tokens AS REAL)/prompt_tokens*100,1) as pct,
           created_at, request_id
    FROM usage_logs
    WHERE CAST(cached_tokens AS REAL)/prompt_tokens < 0.5
    ORDER BY created_at DESC LIMIT 10
''').fetchall()

for r in rows:
    print(f'usage_log id={r[0]} request_{r[5]}  hit={r[2]}/{r[1]}={r[3]}%  {r[4][:19]}')
conn.close()
"
```

Usage log IDs can be cross-referenced with AxonHub Tracing (http://localhost:8090) to download the full request body for diagnosis.

## Web UI check

Open http://localhost:8090 → Tracing tab.
Each request shows `usage.cache_read_input_tokens` in the response body.

For native format cache data, use Request Execution view — response has `cached_tokens` in `prompt_tokens_details`.

## Response file check

If response body JSON files are downloaded:

```bash
python -c "
import json, sys
for f in sys.argv[1:]:
    with open(f) as fp: resp = json.load(fp)
    u = resp.get('usage', {})
    hit = u.get('cache_read_input_tokens') or u.get('prompt_tokens_details',{}).get('cached_tokens', '?')
    inp = u.get('input_tokens') or u.get('prompt_tokens', '?')
    print(f'{f}: hit={hit} input={inp}')
" response-*.json
```

## Service check

`scripts/start.ps1 -Status` shows extension health and recent log activity.
