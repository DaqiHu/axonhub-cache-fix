"""Query AxonHub DB for recent cache hit rates."""

import sqlite3
import sys
from pathlib import Path


DB = Path.home() / "axonhub" / "axonhub.db"
CACHE_COLUMNS = ("prompt_cached_tokens", "cached_tokens")


def cache_column(conn):
    columns = {row[1] for row in conn.execute("PRAGMA table_info(usage_logs)")}
    for name in CACHE_COLUMNS:
        if name in columns:
            return name
    raise RuntimeError(
        "usage_logs has no supported cache token column "
        f"(expected one of: {', '.join(CACHE_COLUMNS)})"
    )


def query_rows(conn, minutes):
    column = cache_column(conn)
    modifier = f"-{int(minutes)} minutes"
    return conn.execute(
        f"""
        SELECT id, prompt_tokens, {column},
               ROUND(CAST({column} AS REAL) / NULLIF(prompt_tokens, 0) * 100, 1) as pct,
               created_at
        FROM usage_logs
        WHERE created_at > datetime('now', ?)
        ORDER BY created_at
        """,
        (modifier,),
    ).fetchall()


def print_report(rows, minutes):
    if not rows:
        print(f"No data in last {minutes} min")
        return

    drops = 0
    for row in rows:
        tag = ""
        if row[3] < 50:
            tag = " <<< SYSTEM INJECTION"
            drops += 1
        elif row[3] < 90:
            tag = " < low"
            drops += 1
        print(
            f"#{row[0]:>4}: hit={row[2]:>7}/{row[1]:>7} "
            f"={row[3]:>5.1f}%{tag}"
        )

    total = len(rows)
    good = total - drops
    first_cold = "(cold start OK)" if rows[0][3] < 50 else ""
    print(f"\n{good}/{total} requests >= 90%   {drops} drops {first_cold}")


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    minutes = int(args[0]) if args else 10

    if not DB.exists():
        print(f"DB not found: {DB}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True)
    try:
        rows = query_rows(conn, minutes)
    except RuntimeError as error:
        print(f"Cache report failed: {error}", file=sys.stderr)
        return 1
    finally:
        conn.close()

    print_report(rows, minutes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
