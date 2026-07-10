"""Gemini integration: grounded prompt assembly and token streaming.

Security invariant: the API key is read from the GEMINI_API_KEY environment
variable only. It is never a function argument from callers, never logged,
and never leaves this process.
"""

import asyncio
import logging
import os
import random
from collections.abc import AsyncIterator

from google import genai
from google.genai import errors, types

from .rag import Chunk

logger = logging.getLogger("paperlens")

MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
MAX_TOKENS = 2048

# Backoff for AI Studio free-tier rate limits (HTTP 429):
# waits of ~1s, 2s, 4s, 8s — each plus 0-1s of jitter so concurrent retries
# don't stampede the endpoint in lockstep.
MAX_RETRIES = 4
BASE_DELAY_S = 1.0
MAX_DELAY_S = 16.0

SYSTEM_PROMPT = """\
You are PaperLens, an assistant that answers questions about a PDF document.

Rules:
- Answer ONLY from the numbered sources provided in the user message. Do not
  use outside knowledge.
- Cite sources inline using their bracket number, e.g. [1] or [2][3], placed
  right after the claim they support. Every factual claim needs a citation.
- If the sources do not contain the answer, say "The document doesn't appear
  to cover this." and briefly note what the sources do cover instead. Do not
  guess.
- Lead with a direct answer, then give supporting detail. For open-ended
  questions (summaries, key findings, explanations), be thorough and draw on
  all relevant sources rather than answering in one line.
"""

class RateLimited(Exception):
    """Free-tier quota still exhausted after all backoff retries."""


def _unwrap_api_error(exc: BaseException) -> errors.APIError | None:
    """Find the underlying google-genai APIError, if any.

    The SDK's internal tenacity retry wraps the real error, so a 429 arrives
    as RetryError(__cause__=ClientError). Walk the cause chain (guarding
    against cycles) instead of matching only the outermost type.
    """
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        if isinstance(current, errors.APIError):
            return current
        seen.add(id(current))
        current = current.__cause__
    return None


_client: genai.Client | None = None


def get_client() -> genai.Client:
    global _client
    if _client is None:
        # Explicit env-var read (rather than the SDK's implicit lookup) so the
        # single source of the key is visible and auditable right here.
        _client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    return _client


def build_user_message(question: str, sources: list[tuple[Chunk, float]]) -> str:
    """Number the retrieved chunks so the model can cite them as [n]."""
    blocks = [
        f"[{n}] (page {chunk.page})\n{chunk.text}"
        for n, (chunk, _score) in enumerate(sources, start=1)
    ]
    return (
        "Sources from the document:\n\n"
        + "\n\n---\n\n".join(blocks)
        + f"\n\nQuestion: {question}"
    )


async def stream_answer(
    question: str, sources: list[tuple[Chunk, float]]
) -> AsyncIterator[str]:
    """Yield answer text token-by-token as Gemini streams it.

    Retries with exponential backoff + jitter on HTTP 429 — but only while
    nothing has been yielded yet. Once tokens have reached the client,
    retrying would duplicate rendered text, so mid-stream failures propagate
    to the caller's error handling instead.
    """
    client = get_client()
    contents = build_user_message(question, sources)
    config = types.GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        max_output_tokens=MAX_TOKENS,
    )

    for attempt in range(MAX_RETRIES + 1):
        yielded = False
        try:
            stream = await client.aio.models.generate_content_stream(
                model=MODEL, contents=contents, config=config
            )
            async for chunk in stream:
                if chunk.text:
                    yielded = True
                    yield chunk.text
            return
        except Exception as exc:
            # google-genai retries internally and re-raises the real APIError
            # wrapped in tenacity.RetryError, so match on the unwrapped cause
            # rather than the outermost exception type.
            api_error = _unwrap_api_error(exc)
            if api_error is None or api_error.code != 429:
                raise
            if yielded or attempt == MAX_RETRIES:
                # Retries exhausted (or unsafe mid-stream): let the caller
                # tell the user this is a rate limit, not a generic failure.
                raise RateLimited from api_error
            delay = min(BASE_DELAY_S * 2**attempt, MAX_DELAY_S) + random.uniform(0, 1)
            logger.warning(
                "Rate limited (429); retry %d/%d in %.1fs",
                attempt + 1,
                MAX_RETRIES,
                delay,
            )
            await asyncio.sleep(delay)
