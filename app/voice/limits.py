"""Limits every voice call runs under, whichever channel it came in on."""

MAX_LIVE_CALLS = 3


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
