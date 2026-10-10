import argparse
import base64
import hashlib
import json
import shutil
import sqlite3
from pathlib import Path


def value_digest(value):
    if isinstance(value, bytes):
        return {"bytes": base64.b64encode(value).decode("ascii")}
    return value


def snapshot(source, destination, backup):
    source = source.resolve(strict=True)
    files = {}
    databases = {}
    for item in sorted(source.rglob("*")):
        if not item.is_file():
            continue
        relative = item.relative_to(source)
        if item.name.endswith(("-wal", "-shm")):
            continue
        if item.suffix.lower() in {".db", ".sqlite", ".sqlite3"}:
            with sqlite3.connect(item.as_uri() + "?mode=ro", uri=True) as connection:
                integrity = [row[0] for row in connection.execute("PRAGMA integrity_check")]
                if integrity != ["ok"]:
                    raise RuntimeError("数据库完整性检查失败：" + str(relative))
                tables = {}
                for (table,) in connection.execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name"):
                    quoted = '"' + table.replace('"', '""') + '"'
                    rows = connection.execute("SELECT * FROM " + quoted).fetchall()
                    row_hashes = sorted(hashlib.sha256(json.dumps([value_digest(value) for value in row], ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest() for row in rows)
                    tables[table] = {"rows": len(rows), "sha256": hashlib.sha256("\n".join(row_hashes).encode("ascii")).hexdigest()}
                databases[relative.as_posix()] = {
                    "version": connection.execute("PRAGMA user_version").fetchone()[0],
                    "tables": tables,
                    "foreignKeyFailures": len(connection.execute("PRAGMA foreign_key_check").fetchall()),
                }
                if databases[relative.as_posix()]["foreignKeyFailures"]:
                    raise RuntimeError("数据库外键检查失败：" + str(relative))
                if backup:
                    target = backup / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with sqlite3.connect(target) as copy:
                        connection.backup(copy)
        else:
            files[relative.as_posix()] = {"bytes": item.stat().st_size, "sha256": hashlib.sha256(item.read_bytes()).hexdigest()}
            if backup:
                target = backup / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(item, target)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps({"files": files, "databases": databases}, ensure_ascii=False, indent=2), encoding="utf-8")


def compare(before, after):
    original = json.loads(before.read_text(encoding="utf-8"))
    current = json.loads(after.read_text(encoding="utf-8"))
    if current != original:
        raise RuntimeError("升级前后的实际用户数据不一致")
    print(json.dumps({"preservedFiles": len(original["files"]), "preservedDatabases": len(original["databases"]), "preservedRows": sum(table["rows"] for database in original["databases"].values() for table in database["tables"].values())}))


parser = argparse.ArgumentParser()
commands = parser.add_subparsers(dest="command", required=True)
capture = commands.add_parser("snapshot")
capture.add_argument("--source", type=Path, required=True)
capture.add_argument("--output", type=Path, required=True)
capture.add_argument("--backup", type=Path)
check = commands.add_parser("compare")
check.add_argument("--before", type=Path, required=True)
check.add_argument("--after", type=Path, required=True)
arguments = parser.parse_args()
if arguments.command == "snapshot":
    snapshot(arguments.source, arguments.output, arguments.backup)
else:
    compare(arguments.before, arguments.after)
