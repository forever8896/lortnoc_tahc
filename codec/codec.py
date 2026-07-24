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
    # CODEC_SELFTEST=0 skips; small payloads keep cold-boot fast (matters on fly).
    n = int(os.environ.get("CODEC_SELFTEST", "3"))
    for _ in range(n):
        x = os.urandom(1 + os.urandom(1)[0] % 8)
        if coder.decode(coder.encode(x, model, K), model, K) != x:
            raise RuntimeError("self-test round-trip failed")


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
            print(f"[codec] gpt2 unavailable ({e}); trying markov")
    if BACKEND in ("auto", "markov"):
        try:
            from model_markov import MarkovModel

            order = int(os.environ.get("CODEC_ORDER", "3"))
            m = MarkovModel(order=order)
            _selftest(m)
            _kind, _model = "markov", m
            MODEL, DIGEST = f"markov-o{order}/k{K}", m.digest()
            print(f"[codec] backend=markov order={order} k={K} ({MODEL} {DIGEST})")
            return
        except Exception as e:  # noqa: BLE001
            if BACKEND == "markov":
                raise
            print(f"[codec] markov unavailable ({e}); falling back to wordmap")
    _kind = "wordmap"
    MODEL, DIGEST = wordmap.MODEL, wordmap.DIGEST
    print(f"[codec] backend=wordmap ({MODEL} {DIGEST})")


_load()


def encode(data: bytes) -> str:
    if _kind in ("gpt2", "markov"):
        with _lock:
            return coder.encode(data, _model, K)
    return wordmap.encode(data)


def decode(cover: str) -> bytes:
    if _kind in ("gpt2", "markov"):
        with _lock:
            return coder.decode(cover, _model, K)
    return wordmap.decode(cover)
