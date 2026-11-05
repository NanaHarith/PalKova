"""In-process event hub: dashboard SSE fan-out and the live-call registry. Safe to call from any thread."""
import asyncio


class Hub:
    def __init__(self):
        self.loop: asyncio.AbstractEventLoop | None = None
        self._subs: set[asyncio.Queue] = set()
        self._live: dict[str, object] = {}

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)

    def publish(self, event: str, data: dict) -> None:
        if self.loop is None:
            return
        for q in list(self._subs):
            self.loop.call_soon_threadsafe(q.put_nowait, (event, data))

    def register(self, conversation_id: str, speaker) -> None:
        self._live[conversation_id] = speaker

    def unregister(self, conversation_id: str) -> None:
        self._live.pop(conversation_id, None)

    def speak(self, conversation_id: str, text: str, system_note: str) -> bool:
        speaker = self._live.get(conversation_id)
        if speaker is None or self.loop is None:
            return False
        asyncio.run_coroutine_threadsafe(speaker.say(text, system_note), self.loop)
        return True


hub = Hub()
