"""SQLite-backed Firebase link batches; no Telegram or dashboard writes."""
import os
import re
import sqlite3
from pathlib import Path


BATCH_NAME = re.compile(r"batch_(\d{4,}) - (\d+) links\.txt")


def atomic_text(path, text):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


class FirebaseBatchWriter:
    def __init__(self, output_dir="firebase_batches", batch_size=1000):
        if batch_size <= 0:
            raise ValueError("batch_size must be positive")
        self.output_dir = Path(output_dir).resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.output_dir / "export.sqlite3", timeout=30)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS links (
                number INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY, value TEXT NOT NULL
            );
        """)
        try:
            with self.db:
                self.db.execute("BEGIN IMMEDIATE")
                existing = self.db.execute(
                    "SELECT value FROM metadata WHERE key='batch_size'"
                ).fetchone()
                if existing and int(existing[0]) != batch_size:
                    raise ValueError(
                        f"This output folder uses batch size {existing[0]}. "
                        "Use another --output-dir for a different batch size."
                    )
                self.batch_size = batch_size
                self.db.execute(
                    "INSERT OR IGNORE INTO metadata VALUES ('batch_size', ?)",
                    (str(batch_size),),
                )
            self.rebuild()
        except BaseException:
            self.db.close()
            raise

    @property
    def count(self):
        return self.db.execute("SELECT COUNT(*) FROM links").fetchone()[0]

    def _publish(self, batch):
        start = (batch - 1) * self.batch_size + 1
        rows = self.db.execute(
            "SELECT url FROM links WHERE number >= ? AND number < ? ORDER BY number",
            (start, start + self.batch_size),
        ).fetchall()
        if not rows:
            return
        destination = self.output_dir / f"batch_{batch:04d} - {len(rows)} links.txt"
        atomic_text(destination, "".join(row[0] + "\n" for row in rows))
        for old in self.output_dir.glob(f"batch_{batch:04d} - * links.txt"):
            if old != destination and BATCH_NAME.fullmatch(old.name):
                old.unlink()

    def rebuild(self):
        """Rebuild TXT views after a crash or a missing/moved batch file."""
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            total = self.count
            for batch in range(1, (total + self.batch_size - 1) // self.batch_size + 1):
                self._publish(batch)
            for old in self.output_dir.glob("batch_* links.txt"):
                match = BATCH_NAME.fullmatch(old.name)
                if match and (int(match[1]) - 1) * self.batch_size >= total:
                    old.unlink()

    def add_urls(self, urls):
        added = 0
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            total = self.count
            batches = set()
            for url in dict.fromkeys(urls):
                if not url:
                    continue
                row = self.db.execute(
                    "INSERT OR IGNORE INTO links(number, url) VALUES (?, ?)",
                    (total + 1, url),
                )
                if row.rowcount:
                    total += 1
                    added += 1
                    batches.add((total - 1) // self.batch_size + 1)
            for batch in sorted(batches):
                self._publish(batch)
        return added

    def cursor(self, source_id, start_from=1):
        row = self.db.execute(
            "SELECT value FROM metadata WHERE key=?", (f"cursor:{source_id}",)
        ).fetchone()
        return max(start_from - 1, int(row[0]) if row else 0)

    def save_cursor(self, source_id, message_id, *, reset=False):
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            current = self.cursor(source_id)
            self.db.execute(
                "INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)",
                (f"cursor:{source_id}", str(message_id if reset else max(current, message_id))),
            )

    def close(self):
        self.db.close()

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()
