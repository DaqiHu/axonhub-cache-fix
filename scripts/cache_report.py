"""Query AxonHub DB for recent cache hit rates."""
import sqlite3
import sys
from pathlib import Path

DB = Path.home() / "axonhub" / "axonhub.db"
if not DB.exists():
    print(f"DB not found: {DB}")
    sys.exit(1)

conn = sqlite3.connect(str(DB))

# Recent cache hit rates
minutes = int(sys.argv[1]) if len(sys.argv) > 1 else 10
rows = conn.execute(f"""
    SELECT id, prompt_tokens, cached_tokens,
           ROUND(CAST(cached_tokens AS REAL)/prompt_tokens*100,1) as pct,
           created_at
    FROM usage_logs
    WHERE created_at > datetime('now', '-{minutes} minutes')
    ORDER BY created_at
""").fetchall()

if not rows:
    print(f"No data in last {minutes} min")
    conn.close()
    sys.exit(0)

# Count drops
drops = 0
for r in rows:
    tag = ""
    if r[3] < 50:
        tag = " <<< SYSTEM INJECTION"
        drops += 1
    elif r[3] < 90:
        tag = " < low"
        drops += 1
    print(f"#{r[0]:>4}: hit={r[2]:>7}/{r[1]:>7} ={r[3]:>5.1f}%{tag}")

# Summary
total = len(rows)
good = total - drops
first_cold = "(cold start OK)" if rows and rows[0][3] < 50 else ""
print(f"\n{good}/{total} requests >= 90%   {drops} drops {first_cold}")

conn.close()
