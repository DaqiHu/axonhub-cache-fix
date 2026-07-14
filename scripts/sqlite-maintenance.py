"""Inspect or perform explicit offline maintenance for an AxonHub SQLite DB."""

import argparse
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def _size(path):
    return path.stat().st_size if path.exists() else 0


def inspect_database(db_path):
    db_path = Path(db_path)
    conn = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True, timeout=2)
    try:
        return {
            "db_path": str(db_path.resolve()),
            "db_bytes": _size(db_path),
            "wal_bytes": _size(Path(f"{db_path}-wal")),
            "shm_bytes": _size(Path(f"{db_path}-shm")),
            "journal_mode": conn.execute("pragma journal_mode").fetchone()[0],
            "page_size": conn.execute("pragma page_size").fetchone()[0],
            "page_count": conn.execute("pragma page_count").fetchone()[0],
            "freelist_count": conn.execute("pragma freelist_count").fetchone()[0],
            "busy_timeout_ms": conn.execute("pragma busy_timeout").fetchone()[0],
        }
    finally:
        conn.close()


def run_maintenance(db_path, backup_dir, vacuum=False):
    db_path = Path(db_path)
    backup_dir = Path(backup_dir)
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = backup_dir / f"{db_path.stem}-{stamp}.db"
    suffix = 1
    while backup_path.exists():
        backup_path = backup_dir / f"{db_path.stem}-{stamp}-{suffix}.db"
        suffix += 1

    conn = sqlite3.connect(db_path, timeout=30)
    try:
        conn.execute("pragma busy_timeout=30000")
        backup = sqlite3.connect(backup_path)
        try:
            conn.backup(backup)
        finally:
            backup.close()

        checkpoint = conn.execute("pragma wal_checkpoint(truncate)").fetchone()
        conn.execute("pragma optimize")
        if vacuum:
            conn.execute("vacuum")
        result = {
            "backup_path": str(backup_path.resolve()),
            "checkpoint": list(checkpoint) if checkpoint else None,
            "vacuum": bool(vacuum),
        }
    except Exception:
        if backup_path.exists() and backup_path.stat().st_size == 0:
            backup_path.unlink()
        raise
    finally:
        conn.close()

    result["after"] = inspect_database(db_path)
    return result


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--backup-dir", type=Path)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--vacuum", action="store_true")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if not args.db.exists():
        raise SystemExit(f"DB not found: {args.db}")
    if args.vacuum and not args.execute:
        raise SystemExit("--vacuum requires --execute")
    if args.execute:
        backup_dir = args.backup_dir or args.db.parent / "backups"
        result = run_maintenance(args.db, backup_dir, vacuum=args.vacuum)
    else:
        result = {"preview": True, **inspect_database(args.db)}
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
