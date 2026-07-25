# GPT-2 codec for fly.io — deterministic LLM stego backend.
# CPU-only torch (small wheel); gpt2 baked into the image so there's no runtime download.
FROM python:3.12-slim

WORKDIR /app

# CPU torch (~200MB) instead of the default CUDA build (~2GB), then transformers.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir transformers

# Pre-download gpt2 (124M) at build time → fast, offline startup.
RUN python -c "from transformers import GPT2LMHeadModel, GPT2TokenizerFast; \
GPT2LMHeadModel.from_pretrained('gpt2'); GPT2TokenizerFast.from_pretrained('gpt2')"

COPY . .

ENV CODEC_BACKEND=gpt2 \
    CODEC_MODEL=gpt2 \
    CODEC_K=5 \
    HOST=0.0.0.0 \
    PORT=8080 \
    TRANSFORMERS_OFFLINE=1 \
    HF_HUB_OFFLINE=1 \
    OMP_NUM_THREADS=4

EXPOSE 8080
CMD ["python", "server.py"]
