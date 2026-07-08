# Prompt Engineering — PaperLens

Material for the report's "Sample prompts used" / Prompt Engineering section.
The live prompt lives in [app/llm.py](app/llm.py); this documents the design.

## 1. The system prompt (verbatim)

```
You are PaperLens, an assistant that answers questions about a PDF document.

Rules:
- Answer ONLY from the numbered sources provided in the user message. Do not
  use outside knowledge.
- Cite sources inline using their bracket number, e.g. [1] or [2][3], placed
  right after the claim they support. Every factual claim needs a citation.
- If the sources do not contain the answer, say "The document doesn't appear
  to cover this." and briefly note what the sources do cover instead. Do not
  guess.
- Be concise: a short direct answer first, supporting detail after.
```

## 2. The user message template (context injection)

Retrieved chunks are injected as *numbered, page-attributed* sources, separated
by `---` delimiters, with the question last:

```
Sources from the document:

[1] (page 3)
<chunk text>

---

[2] (page 7)
<chunk text>

...

Question: <user's question>
```

## 3. Design decisions, and why

| Decision | Rationale |
|---|---|
| **Closed-book instruction** ("ONLY from the numbered sources") | The core grounding constraint. Without it the model happily blends training knowledge with the document, which makes citations meaningless and invites hallucination presented as document fact. |
| **Numbered sources `[n]`** | Gives the model a stable, cheap citation token. Numbers survive streaming token-by-token (no partial-URL or partial-quote states) and map 1:1 to the snippets the UI already received in the `sources` SSE event — so the reader can check every claim. |
| **Page numbers in each source header** | Lets the model say "on page 3" naturally and lets the user find the passage in the original PDF, not just in our snippet view. Carried through the whole pipeline (extraction keeps per-page text precisely for this). |
| **Explicit refusal path** ("The document doesn't appear to cover this") | An escape hatch is the single most effective anti-hallucination lever: without a sanctioned way to say "not here," models answer anyway. Asking it to note what the sources *do* cover keeps the refusal useful rather than dead-ended. |
| **"Every factual claim needs a citation"** | Forces citation density; otherwise models cite once at the end, which defeats claim-level verifiability. |
| **Concise, answer-first format** | Streaming UX: the user sees the direct answer within the first second of tokens rather than after a preamble. |
| **Question placed *after* the sources** | Recency effect: the last thing in the prompt is the task. Also means the (stable-ish) instruction+source block precedes the varying question — the cache-friendly ordering if this scaled to repeated questions on one document. |
| **`max_tokens=1024`** | A grounded answer over 4 chunks does not need more; caps cost and latency per question. |
| **k=4 retrieved chunks** | ~3,200 characters of context — enough to answer section-level questions, small enough that irrelevant chunks don't drown the signal or the token budget. |

## 4. Sample prompts used during development/testing

Questions used against a sample research paper to exercise each behavior:

1. **Direct retrieval** — "What dataset did the authors use?" → expects a short
   answer with one citation.
2. **Synthesis across chunks** — "Summarize the methodology" → expects multiple
   citations `[1][3]` spanning different pages.
3. **Grounding negative test** — "What does this paper say about cryptocurrency?"
   (not in the document) → expects the refusal phrasing, *no* invented answer.
4. **Outside-knowledge trap** — "Who is the president of the USA?" → expects
   refusal even though the model knows the answer: proves the closed-book
   instruction dominates parametric knowledge.
5. **Citation-density check** — "List the paper's three main contributions" →
   expects a citation per listed item, not one trailing citation.

## 5. Model choice & rate-limit handling

`gemini-2.5-flash` (configurable via the `GEMINI_MODEL` env var), called
through the official `google-genai` SDK with the key from Google AI Studio's
free tier — no billing account linked, so inference cost is a hard $0.
Flash-tier is the right fit: RAG answering over pre-retrieved context is a
comprehension task, not a hard-reasoning task, so a larger/paid model buys
nothing here. The system prompt is passed as Gemini's `system_instruction`
(kept separate from user content, as the API intends), and the answer streams
via `generate_content_stream` so the UI renders tokens progressively.

The free tier enforces requests-per-minute/day quotas and answers overflow
with HTTP 429. The backend retries those with **exponential backoff plus
jitter** (~1s, 2s, 4s, 8s, each +0–1s random) — but only before the first
token has streamed to the client; retrying mid-stream would duplicate
already-rendered text, so mid-stream failures surface as a clean error event
instead. The jitter prevents concurrent retries from re-colliding in lockstep.
