"""RAG pipeline: PDF text extraction, overlapping chunking, embedding, retrieval.

Design notes (interview-defensible):
- Chunks are character-based sliding windows *per page*, so every chunk has an
  exact page number for citations. The tradeoff: text spanning a page break is
  split across chunks. Acceptable for a demo; a sentence-aware splitter over
  the full document is the production upgrade.
- Vectors are L2-normalized at insert time, so cosine similarity at query time
  is a single matrix-vector product (dot product of unit vectors == cosine).
- Brute-force search over a NumPy array: one PDF yields ~100-500 chunks, and a
  500x384 matmul is sub-millisecond. A vector DB would add a dependency to
  solve a scale problem this app does not have.
"""

from dataclasses import dataclass
from io import BytesIO

import numpy as np
from pypdf import PdfReader
from sentence_transformers import SentenceTransformer

EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
CHUNK_SIZE = 800  # characters
CHUNK_OVERLAP = 150  # characters
TOP_K = 4


@dataclass
class Chunk:
    id: int
    page: int
    text: str


def extract_pages(pdf_bytes: bytes) -> list[tuple[int, str]]:
    """Return (page_number, text) for each page that has extractable text."""
    reader = PdfReader(BytesIO(pdf_bytes))
    pages = []
    for number, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        if text:
            pages.append((number, text))
    return pages


def chunk_pages(pages: list[tuple[int, str]]) -> list[Chunk]:
    """Split each page into overlapping windows, breaking at whitespace when possible.

    The overlap guarantees that text near a window boundary appears intact in
    at least one chunk, so it stays retrievable as a coherent unit.
    """
    chunks: list[Chunk] = []
    for page_number, text in pages:
        start = 0
        while start < len(text):
            end = min(start + CHUNK_SIZE, len(text))
            if end < len(text):
                # Back up to the last whitespace in the second half of the
                # window to avoid cutting a word (never below half a window,
                # which also keeps the loop advancing past the overlap).
                space = text.rfind(" ", start + CHUNK_SIZE // 2, end)
                if space != -1:
                    end = space
            piece = text[start:end].strip()
            if piece:
                chunks.append(Chunk(id=len(chunks), page=page_number, text=piece))
            if end == len(text):
                break
            start = end - CHUNK_OVERLAP
    return chunks


class DocumentIndex:
    """In-memory vector index over one document's chunks.

    Lives in process memory by design: a restart clears it and the PDF must be
    re-uploaded. The production path is persisting chunks + vectors (S3 or
    pgvector) keyed by a document ID.
    """

    def __init__(self, model: SentenceTransformer):
        self._model = model
        self._chunks: list[Chunk] = []
        self._vectors: np.ndarray | None = None  # shape (n_chunks, 384), unit rows

    @property
    def size(self) -> int:
        return len(self._chunks)

    def build(self, chunks: list[Chunk]) -> None:
        """Embed all chunks and replace the current index (one document at a time)."""
        vectors = self._model.encode(
            [c.text for c in chunks],
            normalize_embeddings=True,  # unit vectors -> cosine == dot product
        )
        self._vectors = np.asarray(vectors, dtype=np.float32)
        self._chunks = chunks

    def search(self, query: str, k: int = TOP_K) -> list[tuple[Chunk, float]]:
        """Top-k chunks by cosine similarity to the query."""
        if self._vectors is None or not self._chunks:
            return []
        query_vec = self._model.encode([query], normalize_embeddings=True)[0]
        scores = self._vectors @ query_vec
        top = np.argsort(scores)[::-1][: min(k, len(self._chunks))]
        return [(self._chunks[i], float(scores[i])) for i in top]
