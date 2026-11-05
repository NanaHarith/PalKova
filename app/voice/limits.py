"""Limits every voice call runs under, whichever channel it came in on."""
import sqlite3
from datetime import datetime, timedelta, timezone

MAX_LIVE_CALLS = 3
MAX_CALL_SECONDS = 6 * 60
MAX_CALLS_PER_NUMBER = 5
CALL_WINDOW = timedelta(hours=5)


def calls_from(conn: sqlite3.Connection, number: str, now: datetime | None = None) -> int:
    """Calls from one number in the window, counted from `conversations` so a restart keeps the count."""
    since = ((now or datetime.now(timezone.utc)) - CALL_WINDOW).isoformat()
    return conn.execute("SELECT COUNT(*) FROM conversations WHERE from_number=? AND started_at>=?",
                        (number, since)).fetchone()[0]


# In-process count (uvicorn runs one worker); move to a shared store if multi-instance.
class CallSlots:
    def __init__(self, limit: int = MAX_LIVE_CALLS):
        self.limit, self.live = limit, 0

    @property
    def full(self) -> bool:
        return self.live >= self.limit

    def acquire(self) -> bool:
        if self.full:
            return False
        self.live += 1
        return True

    def release(self) -> None:
        self.live -= 1
