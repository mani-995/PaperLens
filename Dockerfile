# ---------- Stage 1: builder — deps + baked embedding model ----------
FROM python:3.12-slim AS builder

ENV PIP_NO_CACHE_DIR=1
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# CPU-only torch from PyTorch's own index, installed BEFORE requirements.txt.
# The default PyPI wheel bundles CUDA (~2.5GB); the CPU wheel is ~190MB and
# is all a t3.micro can use anyway. requirements.txt then finds torch already
# satisfied and does not replace it.
RUN pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install -r requirements.txt

# Bake the embedding model into the image at build time. At runtime this is a
# disk read — no Hugging Face download, no cold-start stall on the t3.micro.
ENV HF_HOME=/opt/hf-cache
RUN python -c "from sentence_transformers import SentenceTransformer; \
    SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')"

# ---------- Stage 2: runtime — minimal, non-root ----------
FROM python:3.12-slim

RUN useradd --create-home --uid 1000 appuser

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /opt/hf-cache /opt/hf-cache

ENV PATH="/opt/venv/bin:$PATH" \
    HF_HOME=/opt/hf-cache \
    HF_HUB_OFFLINE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY app ./app
COPY static ./static

USER appuser
EXPOSE 8000

# Exactly one worker: the vector index lives in process memory, and a second
# worker would answer questions against an empty index. Also correct sizing
# for a 1-vCPU t3.micro.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
