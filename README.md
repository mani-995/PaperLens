# PaperLens

Ask questions about any PDF. Upload a document, and PaperLens answers with
inline citations pointing at the exact source passages — powered by a
retrieval-augmented (RAG) pipeline and Google Gemini, streamed token-by-token.

## Architecture

```
Browser (vanilla HTML/CSS/JS)
   │  POST /api/upload (PDF)          POST /api/ask (question)
   ▼                                   ▼
FastAPI ──► pypdf extract ──► overlapping chunks ──► MiniLM embeddings
   │                                                 (NumPy in-memory index)
   │  question ──► embed ──► cosine top-k ──► chunks into Gemini prompt
   ▼
Google Gemini (streaming) ──► SSE ──► browser renders tokens + citations
```

- **RAG pipeline** ([app/rag.py](app/rag.py)): pypdf text extraction,
  ~800-char chunks with ~150-char overlap, `all-MiniLM-L6-v2` embeddings
  (384-dim), brute-force cosine top-k over a NumPy array.
- **LLM layer** ([app/llm.py](app/llm.py)): grounded prompt with numbered
  sources, Gemini (`gemini-2.5-flash`) streaming relayed to the client as
  Server-Sent Events, with exponential backoff + jitter on HTTP 429 so the
  app degrades gracefully at AI Studio free-tier rate limits.
- **Frontend** ([static/](static/)): no frameworks; `fetch()` + manual SSE
  parsing for progressive rendering; responsive layout.

**Known limitation (by design):** the vector index lives in process memory.
A container restart clears it and the PDF must be re-uploaded. The production
path is persisting chunks + vectors (e.g. S3 or pgvector) keyed by document
ID; for a single-instance demo, in-memory is the right size.

## Run locally

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows (use `source .venv/bin/activate` on Unix)
pip install -r requirements.txt
copy .env.example .env           # then put your real key in .env
uvicorn app.main:app --reload
```

Open http://localhost:8000.

> First run downloads the embedding model (~90MB) into your local
> Hugging Face cache. The Docker image bakes the model in at build time,
> so the container never downloads anything at runtime.

> Troubleshooting: if streaming fails with
> `StreamReader.readline() got an unexpected keyword argument`, an old
> globally-installed `aiohttp` is shadowing the SDK's httpx path —
> `pip install -U aiohttp` (>= 3.14) or use a clean venv as above.

## Run in Docker

```bash
docker build -t paperlens .
docker run -p 8000:8000 -e GEMINI_API_KEY=your-key paperlens
```

## Deploy (AWS Elastic Beanstalk, free tier)

Single `t3.micro` instance, Docker platform, no load balancer
(`eb create --single`), API key injected as an EB environment property.
Full step-by-step guide: [DEPLOY.md](DEPLOY.md).

## Security & cost

- The Gemini API key is read **only** from the `GEMINI_API_KEY` environment
  variable — never hardcoded, never logged, never sent to the browser. All
  model calls happen server-side.
- `.env` is gitignored; `.env.example` documents the required variables.
- The key comes from [Google AI Studio](https://aistudio.google.com/apikey)
  with **no billing account linked** — the project cannot spend money on
  inference; exceeding free-tier limits returns HTTP 429 (which the backend
  retries with backoff) rather than a charge.
