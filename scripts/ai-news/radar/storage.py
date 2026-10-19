"""SQLite state, HTTP cache, and atomic private artifacts."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from types import TracebackType
from typing import Literal

from .models import ContentItem

SCHEMA_VERSION = 1


class _ClosingConnection(sqlite3.Connection):
    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> Literal[False]:
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


class Storage:
    def __init__(self, state_dir: Path):
        self.state_dir = state_dir
        self.database_path = state_dir / "state.db"

    def initialize(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            os.chmod(self.state_dir, 0o700)
        with self._connect() as connection:
            current_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            if current_version > SCHEMA_VERSION:
                raise ValueError(
                    f"state database schema {current_version} is newer than supported {SCHEMA_VERSION}"
                )
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS items (
                    item_key TEXT PRIMARY KEY,
                    item_id TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    source TEXT NOT NULL,
                    title TEXT NOT NULL,
                    published_at TEXT NOT NULL,
                    url TEXT NOT NULL,
                    raw_source_text TEXT NOT NULL,
                    recommendation TEXT NOT NULL,
                    extra TEXT NOT NULL,
                    discovered_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS digest_items (
                    digest_date TEXT NOT NULL,
                    item_key TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    PRIMARY KEY (digest_date, item_key),
                    FOREIGN KEY (item_key) REFERENCES items(item_key)
                );
                CREATE TABLE IF NOT EXISTS http_cache (
                    url TEXT PRIMARY KEY,
                    etag TEXT NOT NULL,
                    last_modified TEXT NOT NULL,
                    body BLOB NOT NULL,
                    fetched_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS github_repository_snapshots (
                    repository TEXT NOT NULL,
                    observed_date TEXT NOT NULL,
                    stars INTEGER NOT NULL,
                    forks INTEGER NOT NULL,
                    pushed_at TEXT NOT NULL,
                    captured_at TEXT NOT NULL,
                    PRIMARY KEY (repository, observed_date)
                );
                CREATE TABLE IF NOT EXISTS collection_runs (
                    digest_date TEXT PRIMARY KEY,
                    generated_at TEXT NOT NULL,
                    status TEXT NOT NULL,
                    quality_gate_json TEXT NOT NULL,
                    source_health_json TEXT NOT NULL,
                    total INTEGER NOT NULL,
                    available INTEGER NOT NULL
                );
                """
            )
            connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self.database_path,
            timeout=30,
            factory=_ClosingConnection,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def get_http_cache(self, url: str) -> dict[str, object] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT etag, last_modified, body, fetched_at FROM http_cache WHERE url = ?",
                (url,),
            ).fetchone()
        return dict(row) if row else None

    def put_http_cache(
        self,
        url: str,
        body: bytes,
        etag: str = "",
        last_modified: str = "",
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO http_cache (url, etag, last_modified, body, fetched_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(url) DO UPDATE SET
                    etag=excluded.etag,
                    last_modified=excluded.last_modified,
                    body=excluded.body,
                    fetched_at=excluded.fetched_at
                """,
                (url, etag, last_modified, body, datetime.now(timezone.utc).isoformat()),
            )

    def previous_github_snapshot(
        self, repository: str, before_date: str
    ) -> dict[str, object] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT stars, forks, pushed_at, captured_at, observed_date
                FROM github_repository_snapshots
                WHERE repository = ? AND observed_date < ?
                ORDER BY observed_date DESC
                LIMIT 1
                """,
                (repository.casefold(), before_date),
            ).fetchone()
        return dict(row) if row else None

    def put_github_snapshot(
        self,
        repository: str,
        observed_date: str,
        stars: int,
        forks: int,
        pushed_at: datetime,
        captured_at: datetime,
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO github_repository_snapshots (
                    repository, observed_date, stars, forks, pushed_at, captured_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(repository, observed_date) DO UPDATE SET
                    stars=excluded.stars,
                    forks=excluded.forks,
                    pushed_at=excluded.pushed_at,
                    captured_at=excluded.captured_at
                """,
                (
                    repository.casefold(),
                    observed_date,
                    stars,
                    forks,
                    pushed_at.isoformat(),
                    captured_at.isoformat(),
                ),
            )

    def has_seen_github_repository(self, url: str) -> bool:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT 1
                FROM items
                WHERE source_type = 'github_trending' AND url = ?
                LIMIT 1
                """,
                (url,),
            ).fetchone()
        return row is not None

    def add_new_items_to_digest(self, date_str: str, items: list[ContentItem]) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as connection:
            existing_urls = {
                ContentItem(
                    item_id=str(row["item_id"]),
                    source_type=str(row["source_type"]),
                    source=str(row["source"]),
                    title=str(row["title"]),
                    published_at=datetime.fromisoformat(str(row["published_at"])),
                    url=str(row["url"]),
                    extra=str(row["extra"]),
                ).dedup_identity: str(row["item_key"])
                for row in connection.execute(
                    """
                    SELECT item_key, item_id, source_type, source, title,
                           published_at, url, extra
                    FROM items
                    """
                ).fetchall()
            }
            position_row = connection.execute(
                "SELECT COALESCE(MAX(position), 0) AS value FROM digest_items WHERE digest_date = ?",
                (date_str,),
            ).fetchone()
            position = int(position_row["value"])
            for item in items:
                url_key = item.dedup_identity
                existing_item_key = existing_urls.get(url_key)
                if existing_item_key is not None and existing_item_key != item.key:
                    continue
                cursor = connection.execute(
                    """
                    INSERT OR IGNORE INTO items (
                        item_key, item_id, source_type, source, title, published_at,
                        url, raw_source_text, recommendation, extra, discovered_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        item.key,
                        item.item_id,
                        item.source_type,
                        item.source,
                        item.title,
                        item.published_at.isoformat(),
                        item.url,
                        item.raw_source_text,
                        item.recommendation,
                        item.extra,
                        now,
                    ),
                )
                already_in_digest = connection.execute(
                    "SELECT 1 FROM digest_items WHERE digest_date = ? AND item_key = ?",
                    (date_str, item.key),
                ).fetchone()
                if cursor.rowcount != 1 and not already_in_digest:
                    continue
                if not already_in_digest:
                    position += 1
                    connection.execute(
                        "INSERT INTO digest_items (digest_date, item_key, position) VALUES (?, ?, ?)",
                        (date_str, item.key, position),
                    )
                existing_urls[url_key] = item.key

    def items_for_digest(self, date_str: str) -> list[ContentItem]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT i.* FROM digest_items d
                JOIN items i ON i.item_key = d.item_key
                WHERE d.digest_date = ?
                ORDER BY i.published_at DESC, d.position ASC
                """,
                (date_str,),
            ).fetchall()
        return [
            ContentItem(
                item_id=row["item_id"],
                source_type=row["source_type"],
                source=row["source"],
                title=row["title"],
                published_at=datetime.fromisoformat(row["published_at"]),
                url=row["url"],
                raw_source_text=row["raw_source_text"],
                recommendation=row["recommendation"],
                extra=row["extra"],
            )
            for row in rows
        ]

    def items_since(self, since: datetime) -> list[ContentItem]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT * FROM items WHERE published_at >= ?
                ORDER BY published_at DESC
                """,
                (since.astimezone(timezone.utc).isoformat(),),
            ).fetchall()
        return [
            ContentItem(
                item_id=row["item_id"],
                source_type=row["source_type"],
                source=row["source"],
                title=row["title"],
                published_at=datetime.fromisoformat(row["published_at"]),
                url=row["url"],
                raw_source_text=row["raw_source_text"],
                recommendation=row["recommendation"],
                extra=row["extra"],
            )
            for row in rows
        ]


    def record_collection_run(
        self,
        date_str: str,
        status: str,
        quality_gate: dict[str, object],
        source_health: list[dict[str, object]],
        total: int,
        available: int,
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO collection_runs (
                    digest_date, generated_at, status, quality_gate_json,
                    source_health_json, total, available
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(digest_date) DO UPDATE SET
                    generated_at=excluded.generated_at,
                    status=excluded.status,
                    quality_gate_json=excluded.quality_gate_json,
                    source_health_json=excluded.source_health_json,
                    total=excluded.total,
                    available=excluded.available
                """,
                (
                    date_str,
                    datetime.now(timezone.utc).isoformat(),
                    status,
                    json.dumps(quality_gate, ensure_ascii=False, sort_keys=True),
                    json.dumps(source_health, ensure_ascii=False, sort_keys=True),
                    total,
                    available,
                ),
            )

    def collection_run_summary(self, since_date: str) -> dict[str, object]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT status, total, available, source_health_json
                FROM collection_runs WHERE digest_date >= ? ORDER BY digest_date
                """,
                (since_date,),
            ).fetchall()
        source_failures = 0
        for row in rows:
            health = json.loads(row["source_health_json"])
            source_failures += sum(int(entry.get("failed", 0)) for entry in health)
        total = sum(int(row["total"]) for row in rows)
        available = sum(int(row["available"]) for row in rows)
        return {
            "runs": len(rows),
            "failed_runs": sum(str(row["status"]) == "failed" for row in rows),
            "signals": total,
            "availability_ratio": round(available / total, 4) if total else 0,
            "source_failures": source_failures,
        }


def atomic_write_json(path: Path, payload: object) -> None:
    atomic_write_text(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(text, encoding="utf-8")
    if os.name != "nt":
        os.chmod(temporary, 0o600)
    os.replace(temporary, path)
