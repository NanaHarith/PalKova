"""One turn of the AG Studio dashboard's agents, relayed to OpenAI's Responses API.

Studio runs its agent loop in the owner's browser and posts each turn here, so the API key stays on
the server. The server picks the model and caps the output; the browser chooses neither.
"""
from collections.abc import Iterator

# The fields Studio's OpenAI adapter sends. Anything else (store, metadata, background...) is dropped.
FIELDS = {"input", "instructions", "tools", "tool_choice", "text", "reasoning", "parallel_tool_calls"}
MAX_OUTPUT_TOKENS = 16_000


def _reasons(model: str) -> bool:
    """Only reasoning models accept `reasoning.effort`; gpt-4.1 rejects the request outright."""
    return model.startswith(("gpt-5", "o"))


def turn_request(body: dict, model: str) -> dict:
    req = {k: v for k, v in body.items() if k in FIELDS}
    if not _reasons(model):
        req.pop("reasoning", None)
    return {**req, "model": model, "max_output_tokens": MAX_OUTPUT_TOKENS, "stream": True}


def sse(stream) -> Iterator[str]:
    """OpenAI's stream events, re-sent as the server-sent events the adapter reads."""
    for event in stream:
        yield f"data: {event.model_dump_json()}\n\n"
