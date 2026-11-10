# codec2 on fly.io: short reply covers + the drop store. Build context = codec2/.
#   flyctl deploy --config codec2/fly.toml --dockerfile codec2/Dockerfile codec2
FROM node:22-slim AS node

FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
# CPU torch wheel (small) from PyTorch's index; the rest from PyPI, all pinned.
RUN pip install --no-cache-dir torch==2.14.1 --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir -r requirements.txt

# The model, baked in at a PINNED revision: no runtime download, and a rebuild cannot silently pick
# up new weights (which would change the coder's tables and break every reply already posted).
ARG MODEL=Qwen/Qwen3-0.6B-Base
ARG REVISION=da87bfb608c14b7cf20ba1ce41287e8de496c0cd
RUN python -c "from transformers import AutoModelForCausalLM, AutoTokenizer as T; \
T.from_pretrained('$MODEL', revision='$REVISION'); AutoModelForCausalLM.from_pretrained('$MODEL', revision='$REVISION')"

# Node runs the Walrus uploader (walrus/flush.mjs, recover.mjs) — the official SDK is TypeScript.
# Added AFTER the heavy torch + model layers so changing it never re-downloads them.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY walrus/package.json walrus/package-lock.json walrus/
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN cd walrus && node /usr/local/lib/node_modules/npm/bin/npm-cli.js ci --omit=dev --no-audit --no-fund \
 && rm -rf /usr/local/lib/node_modules/npm
COPY walrus/*.mjs walrus/
COPY drops.py stego.py server.py archive.py ./

ENV CODEC2_MODEL=$MODEL \
    CODEC2_REVISION=$REVISION \
    DROP_DIR=/data/drops \
    PORT=8080 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    THREADS=4

EXPOSE 8080
CMD ["python", "server.py"]
