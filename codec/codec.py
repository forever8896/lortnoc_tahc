"""
Codec dispatcher. Picks a backend and exposes the stable interface the server uses:
    encode(bytes) -> cover_text
    decode(cover_text) -> bytes
    MODEL, DIGEST

Backend selection (env CODEC_BACKEND, default "auto"):
    gpt2     — REAL LLM stego (model_gpt2 + block coder). Cover text = natural-ish
               lowercase words. Requires torch + transformers.
    wordmap  — deterministic byte→word placeholder (no deps).
    auto     — try gpt2, run a round-trip SELF-TEST; on any failure fall back to wordmap
               with a loud log. So you always get a working codec, and the real one
               whenever it loads and verifies.

CODEC_K (default 3) = bits hidden per token in the gpt2 backend (higher = shorter cover
text, less natural).
"""
import os
import threading

import coder
import wordmap

# The gpt2 backend keeps stateful KV cache, so serialize access (server is threaded).
_lock = threading.Lock()

BACKEND = os.environ.get("CODEC_BACKEND", "auto").lower()
K = int(os.environ.get("CODEC_K", "3"))

_kind: str
_model = None
MODEL: str
DIGEST: str


def _selftest(model) -> None:
    for _ in range(5):
        x = os.urandom(1 + os.urandom(1)[0] % 24)
        if coder.decode(coder.encode(x, model, K), model, K) != x:
            raise RuntimeError("gpt2 self-test round-trip failed")


def _load() -> None:
    global _kind, _model, MODEL, DIGEST
    if BACKEND in ("auto", "gpt2"):
        try:
            from model_gpt2 import GPT2Model

            m = GPT2Model()
            _selftest(m)
            _kind, _model = "gpt2", m
            MODEL, DIGEST = f"gpt2/k{K}", m.digest()
            print(f"[codec] backend=gpt2 k={K} ({MODEL} {DIGEST})")
            return
        except Exception as e:  # noqa: BLE001
            if BACKEND == "gpt2":
                raise
            print(f"[codec] gpt2 unavailable ({e}); falling back to wordmap")
    _kind = "wordmap"
    MODEL, DIGEST = wordmap.MODEL, wordmap.DIGEST
    print(f"[codec] backend=wordmap ({MODEL} {DIGEST})")


_load()


def encode(data: bytes) -> str:
    if _kind == "gpt2":
        with _lock:
            return coder.encode(data, _model, K)
    return wordmap.encode(data)


def decode(cover: str) -> bytes:
    if _kind == "gpt2":
        with _lock:
            return coder.decode(cover, _model, K)
    return wordmap.decode(cover)
