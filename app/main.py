"""FastAPI app: routes, SSE streaming endpoint, static frontend."""

import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

from . import llm, rag

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Load .env relative to the project, not the launch directory, so `uvicorn`
# started from anywhere still finds the key. No-op in production (EB sets the
# environment property directly and no .env file is shipped).
load_dotenv(PROJECT_ROOT / ".env")

logger = logging.getLogger("paperlens")

MAX_PDF_BYTES = 20 * 1024 * 1024  # 20 MB — matches the client-side guard
STATIC_DIR = PROJECT_ROOT / "static"

state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail fast at startup, not on the first question mid-demo.
    if not os.environ.get("GEMINI_API_KEY"):
        raise RuntimeError(
            "GEMINI_API_KEY is not set. Copy .env.example to .env locally, "
            "or set it as an environment property in production."
        )
    # Loaded once per process. In the Docker image the model files are baked
    # in, so this is a disk read, not a network download.
    model = SentenceTransformer(rag.EMBEDDING_MODEL)
    state["index"] = rag.DocumentIndex(model)
    logger.info("Embedding model loaded; index ready.")
    yield
    state.clear()


app = FastAPI(title="PaperLens", lifespan=lifespan)


class AskRequest(BaseModel):
    question: str


def sse_event(event: str, data: dict) -> str:
    """Format one Server-Sent Event. JSON payloads keep multi-line text safe
    inside SSE's line-oriented framing."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@app.post("/api/upload")
async def upload_pdf(file: UploadFile):
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Please upload a .pdf file.")
    data = await file.read()
    if len(data) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail="PDF is larger than 20 MB.")

    try:
        pages = rag.extract_pages(data)
    except Exception:
        logger.exception("PDF extraction failed")
        raise HTTPException(status_code=400, detail="Could not read this PDF.")
    if not pages:
        raise HTTPException(
            status_code=422,
            detail="No extractable text found. Scanned/image-only PDFs are not supported.",
        )

    chunks = rag.chunk_pages(pages)
    # Embedding is CPU-bound; run it off the event loop so the server stays
    # responsive while a large document is being indexed.
    await run_in_threadpool(state["index"].build, chunks)
    return {"pages": len(pages), "chunks": len(chunks)}


@app.post("/api/ask")
async def ask(req: AskRequest):
    question = req.question.strip()
    if not question:
        raise HTTPException(status_code=422, detail="Question is empty.")
    index: rag.DocumentIndex = state["index"]
    if index.size == 0:
        raise HTTPException(status_code=409, detail="Upload a PDF first.")

    sources = await run_in_threadpool(index.search, question)

    async def event_stream():
        # Sources go out first so the UI can render citations while the
        # answer is still streaming.
        yield sse_event(
            "sources",
            {
                "sources": [
                    {"n": n, "page": c.page, "score": round(score, 3), "text": c.text}
                    for n, (c, score) in enumerate(sources, start=1)
                ]
            },
        )
        try:
            async for token in llm.stream_answer(question, sources):
                yield sse_event("token", {"text": token})
        except llm.RateLimited:
            logger.warning("Free-tier rate limit exhausted after retries")
            yield sse_event(
                "error",
                {
                    "message": "Rate limit reached — the free tier allows a "
                    "limited number of questions per minute and per day. "
                    "Wait a bit and ask again."
                },
            )
        except Exception:
            # Full detail to server logs only; a generic message to the client.
            logger.exception("Gemini streaming failed")
            yield sse_event("error", {"message": "The model request failed. Try again."})
        yield sse_event("done", {})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # EB's nginx buffers proxied responses by default, which would
            # turn the stream into one big flush; this header disables that.
            "X-Accel-Buffering": "no",
        },
    )


# HTML entry points. Defined before the static mount so these exact paths win
# over it. Both are served WITHOUT a trailing slash, so each page's relative
# asset links (e.g. "style.css") resolve against "/" and hit the mount below.
@app.get("/", include_in_schema=False)
async def landing():
    return FileResponse(STATIC_DIR / "landing.html")


@app.get("/app", include_in_schema=False)
async def app_page():
    return FileResponse(STATIC_DIR / "index.html")


# Mounted last so /api/* and the HTML routes above take precedence. html=False:
# this only serves real asset files (style.css, landing.css, app.js, …). The
# "/" index-file behavior is intentionally off — landing/app are the routes.
app.mount("/", StaticFiles(directory=STATIC_DIR, html=False), name="static")
