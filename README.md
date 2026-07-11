# PaperLens

**Ask questions about any PDF and get answers with inline citations pointing at the exact source passages.** Upload a document, ask in plain language, and PaperLens streams back a grounded answer token-by-token — every claim tagged with the page it came from — using a retrieval-augmented generation (RAG) pipeline over Google Gemini.

Built as a full-stack, containerized, single-instance app that runs end-to-end on a free tier at **$0**.

---

## What it does

- 📄 **Upload a PDF** — text is extracted, chunked with overlap, and embedded into an in-memory vector index in seconds.
- 💬 **Ask in plain language** — the most relevant passages are retrieved and injected into a grounded Gemini prompt.
- ⚡ **Streamed answers** — tokens render progressively over Server-Sent Events, so you see the answer as it's written.
- 🔖 **Inline citations** — answers cite their sources as `[1] [2]` pill badges, each mapping to a retrieved snippet with its page number, so every claim is verifiable.
- ✍️ **Markdown formatting** — bold, bullet lists, headings, and tables render cleanly (via a vendored `marked` parser with strict HTML sanitization).
- 🗂️ **Multi-chat library** — every uploaded document and conversation is saved in the browser; reopen any chat and it re-indexes its PDF automatically.
- 🚫 **Grounded, not guessy** — the model answers *only* from the retrieved sources and explicitly says when the document doesn't cover something.

The app is served at `/app`, with a marketing landing page at `/`.

---

## Architecture

```
Browser (vanilla HTML/CSS/JS — no framework)
   │  POST /api/upload (PDF)              POST /api/ask (question)
   ▼                                       ▼
FastAPI ──► pypdf extract ──► overlapping chunks ──► MiniLM embeddings
   │                                              (NumPy in-memory index)
   │  question ──► embed ──► cosine top-k ──► chunks into grounded prompt
   ▼
Google Gemini (streaming) ──► SSE ──► browser renders tokens + citations
```

- **RAG pipeline** ([app/rag.py](app/rag.py)) — `pypdf` text extraction (per-page, for citations), ~800-char chunks with ~150-char overlap, `all-MiniLM-L6-v2` sentence-transformer embeddings (384-dim), brute-force cosine top-k (k=6) over a NumPy array. Brute force is deliberate: one PDF is a few hundred chunks, so a matrix-vector product is sub-millisecond and a vector database would be over-engineering.
- **LLM layer** ([app/llm.py](app/llm.py)) — assembles a grounded, closed-book prompt with numbered sources, streams the answer from `gemini-2.5-flash`, and relays each token to the client as an SSE event. Includes exponential backoff with jitter on HTTP 429 so the app degrades gracefully (with a clear "rate limit reached" message) at AI Studio free-tier limits instead of erroring out.
- **Web layer** ([app/main.py](app/main.py)) — FastAPI routes: `/` serves the landing page, `/app` the application, `/api/upload` and `/api/ask` the JSON/SSE API. Static assets are served from `static/`.
- **Frontend** ([static/](static/)) — no frameworks. `fetch()` + manual SSE frame parsing for progressive rendering; citation-safe Markdown rendering; chat state in `localStorage` and PDF bytes in `IndexedDB`; responsive with a collapsible sidebar.

### Client-side persistence & "re-index on resume"

The backend is deliberately **stateless** and holds exactly one document index in process memory. All persistence lives in the browser:

- **`localStorage`** holds chat metadata and message history (small JSON).
- **`IndexedDB`** holds each PDF's raw bytes (`localStorage` is string-only and too small for binary blobs).

When you reopen a saved chat, its stored PDF bytes are re-POSTed to `/api/upload` to rebuild the server's in-memory index — "re-index on resume." This keeps the backend free of any database while still giving a persistent multi-chat experience.

---

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Python 3.12, FastAPI, Uvicorn |
| PDF / RAG | pypdf, sentence-transformers (`all-MiniLM-L6-v2`), NumPy |
| LLM | Google Gemini (`gemini-2.5-flash`) via the `google-genai` SDK |
| Frontend | Vanilla HTML / CSS / JS, vendored `marked` for Markdown |
| Packaging | Multi-stage Docker (CPU-only Torch, model baked in) |
| Deploy | AWS Elastic Beanstalk (single `t3.micro`, free tier) |

---

## Project structure

```
paperlens/
├── app/
│   ├── main.py          # FastAPI app: routes, /api/upload, /api/ask (SSE)
│   ├── rag.py           # PDF extract, chunk, embed, cosine top-k retrieval
│   └── llm.py           # Grounded prompt + Gemini streaming + 429 backoff
├── static/
│   ├── landing.html/css # Marketing landing page (served at /)
│   ├── index.html       # The app (served at /app)
│   ├── style.css
│   ├── app.js           # SSE streaming, citations, Markdown, multi-chat
│   └── vendor/marked.min.js
├── .platform/nginx/     # Elastic Beanstalk nginx tuning
├── Dockerfile           # Multi-stage build
├── requirements.txt
├── DEPLOY.md            # Step-by-step AWS Elastic Beanstalk guide
└── PROMPTS.md           # Prompt-engineering write-up
```

---

## Configuration

PaperLens needs exactly one secret, read from an environment variable:

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | Google AI Studio API key. Create one free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). |
| `GEMINI_MODEL` | — | Override the model (default `gemini-2.5-flash`). |

The key is read **only** from the environment — never hardcoded, never logged, never sent to the browser (all model calls happen server-side). Create a `.env` file in the project root for local development:

```bash
# .env  (git-ignored — never commit this)
GEMINI_API_KEY=your-ai-studio-key-here
```

---

## Run locally

```bash
python -m venv .venv
.venv\Scripts\activate            # Windows  (use `source .venv/bin/activate` on macOS/Linux)
pip install -r requirements.txt
# create a .env file with your GEMINI_API_KEY (see Configuration above)
uvicorn app.main:app --reload
```

Then open **http://localhost:8000** (landing page) or **http://localhost:8000/app** (the app).

> The first run downloads the embedding model (~90 MB) into your local Hugging Face cache. The Docker image bakes the model in at build time, so the container never downloads anything at runtime.

> **Troubleshooting:** if streaming fails with `StreamReader.readline() got an unexpected keyword argument`, an old globally-installed `aiohttp` is shadowing the SDK's HTTP path — run `pip install -U aiohttp` (≥ 3.14) or use a clean virtualenv as above.

---

## Run in Docker

The image is built multi-stage: dependencies and the embedding model are installed in a builder stage, and only the runtime venv + model cache are copied into a slim final image, so the model is baked in and never downloaded at runtime.

```bash
docker build -t paperlens .
docker run -p 8000:8000 -e GEMINI_API_KEY=your-key paperlens
```

Open http://localhost:8000.

---

## Deploy (AWS Elastic Beanstalk — free tier)

A single `t3.micro` instance on the Docker platform with **no load balancer** (`eb create --single`), with the API key injected as an Elastic Beanstalk environment property (never baked into the image). Full step-by-step instructions, including a $1 budget alarm and teardown: **[DEPLOY.md](DEPLOY.md)**.

---

## Security & cost

- The `GEMINI_API_KEY` is read only from the environment; it never appears in code, logs, the client, or version control. `.env` is git-ignored.
- The key comes from Google AI Studio with **no billing account linked** — the project structurally cannot spend money on inference. Exceeding free-tier limits returns HTTP 429 (which the backend retries with backoff, then surfaces a friendly message) rather than a charge.
- Model output is untrusted: streamed Markdown is HTML-sanitized through a strict tag/attribute allowlist before rendering, and citation markers are protected from the Markdown parser so they can't be turned into arbitrary links.

---

## Known limitations (by design)

- **The vector index lives in process memory.** A server restart clears it, and the PDF must be re-uploaded (the browser handles this automatically via "re-index on resume"). The production path is persisting chunks + vectors — e.g. S3 or pgvector — keyed by a document ID. For a single-instance demo, in-memory is the right size.
- **One document indexed server-side at a time.** Switching chats re-indexes; fine for a single-user demo, not for concurrent multi-user load.
- **Free-tier request quota.** `gemini-2.5-flash` on the AI Studio free tier is capped per minute and per day; heavy use hits 429 (handled gracefully). Set `GEMINI_MODEL` to a higher-quota model or attach billing for production traffic.

---

## Prompt engineering

The grounding strategy — closed-book instruction, numbered sources, mandatory inline citations, and an explicit "not in the document" escape hatch — is documented with rationale in **[PROMPTS.md](PROMPTS.md)**.
