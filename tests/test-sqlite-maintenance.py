import importlib.util
import json
import sqlite3
from pathlib import Path
from tempfile import TemporaryDirectory


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "sqlite-maintenance.py"
SPEC = importlib.util.spec_from_file_location("sqlite_maintenance", SCRIPT)
maintenance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(maintenance)


def make_wal_db(root):
    db = root / "test.db"
    conn = sqlite3.connect(db)
    conn.execute("pragma journal_mode=wal")
    conn.execute("create table items(id integer primary key, value text)")
    conn.executemany("insert into items(value) values (?)", [("x" * 1000,) for _ in range(100)])
    conn.commit()
    conn.close()
    return db


def test_preview_is_read_only_and_reports_storage():
    with TemporaryDirectory() as tmp:
        db = make_wal_db(Path(tmp))
        before = db.stat().st_size
        report = maintenance.inspect_database(db)
        assert report["journal_mode"] == "wal"
        assert report["page_count"] > 0
        assert report["db_bytes"] == before
        assert db.stat().st_size == before


def test_execute_creates_consistent_backup_and_truncates_wal():
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        db = make_wal_db(root)
        result = maintenance.run_maintenance(db, root / "backups", vacuum=False)
        backup = Path(result["backup_path"])
        assert backup.exists()
        conn = sqlite3.connect(backup)
        assert conn.execute("select count(*) from items").fetchone()[0] == 100
        conn.close()
        wal = Path(f"{db}-wal")
        assert not wal.exists() or wal.stat().st_size == 0
        assert result["vacuum"] is False


def test_optional_vacuum_reclaims_freelist():
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        db = make_wal_db(root)
        conn = sqlite3.connect(db)
        conn.execute("delete from items where id <= 90")
        conn.commit()
        before = conn.execute("pragma freelist_count").fetchone()[0]
        conn.close()
        result = maintenance.run_maintenance(db, root / "backups", vacuum=True)
        assert result["vacuum"] is True
        conn = sqlite3.connect(db)
        after = conn.execute("pragma freelist_count").fetchone()[0]
        conn.close()
        assert after <= before


if __name__ == "__main__":
    tests = [
        test_preview_is_read_only_and_reports_storage,
        test_execute_creates_consistent_backup_and_truncates_wal,
        test_optional_vacuum_reclaims_freelist,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"\nSQLite maintenance: {len(tests)} passed, 0 failed")
