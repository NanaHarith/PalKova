"""Supabase Storage: keeps a copy of the SQLite file so state survives restarts on a host with no persistent disk.
Off unless DB_SNAPSHOT_BUCKET is set; a host with a volume does not need it."""
import hashlib
import logging
import sqlite3
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

OBJECT = "db/palkova.db"


class DbSnapshot:
    # Whole-file copy every tick, single instance; writes in the last tick before a crash
    # (or during a deploy's brief overlap) are lost. Move to a hosted database if that matters.
    def __init__(self, url: str, service_key: str, bucket: str):
        self.object_url = f"{url.rstrip('/')}/storage/v1/object/{bucket}/{OBJECT}"
        self.headers = {"Authorization": f"Bearer {service_key}", "apikey": service_key}
        self.last_hash = ""

    def restore(self, path: str) -> None:
        """Download the saved copy, only onto a fresh disk."""
        if Path(path).exists():
            return
        r = httpx.get(self.object_url, headers=self.headers, timeout=30)
        if r.status_code in (400, 404):  # nothing saved yet
            return
        r.raise_for_status()
        Path(path).write_bytes(r.content)
        self.last_hash = hashlib.sha256(r.content).hexdigest()

    def save(self, conn: sqlite3.Connection) -> None:
        """Upload the database when it changed since the last save."""
        data = conn.serialize()
        digest = hashlib.sha256(data).hexdigest()
        if digest == self.last_hash:
            return
        r = httpx.post(self.object_url, content=data, timeout=30,
                       headers={**self.headers, "x-upsert": "true", "Content-Type": "application/octet-stream"})
        r.raise_for_status()
        self.last_hash = digest
