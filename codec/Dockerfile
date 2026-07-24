# GPT-2 codec for fly.io — deterministic LLM stego backend.
# CPU-only torch (small wheel); gpt2 baked into the image so there's no runtime download.
FROM python:3.12-slim

WORKDIR /app

# CPU torch (~200MB) instead of the default CUDA build (~2GB), then transformers.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir transformers

# Pre-download the model (DialoGPT-small, 124M) at build time → fast, offline startup.
ARG CODEC_MODEL=microsoft/DialoGPT-small
RUN python -c "from transformers import AutoModelForCausalLM, AutoTokenizer; \
AutoModelForCausalLM.from_pretrained('${CODEC_MODEL}'); AutoTokenizer.from_pretrained('${CODEC_MODEL}')"

COPY . .

ENV CODEC_BACKEND=gpt2 \
    CODEC_MODEL=microsoft/DialoGPT-small \
    CODEC_K=4 \
    HOST=0.0.0.0 \
    PORT=8080 \
    TRANSFORMERS_OFFLINE=1 \
    HF_HUB_OFFLINE=1 \
    OMP_NUM_THREADS=4

EXPOSE 8080
CMD ["python", "server.py"]
