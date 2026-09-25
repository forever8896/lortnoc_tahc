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

CODEC_K (default 3) = bits hidden per token, BLOCK coder only (higher = shorter cover
text, less natural).

CODEC_CODER (default "block") selects the coder over the chosen model:
    block  — fixed k bits per token (coder.py). Simple; wastes capacity where the model is
             uncertain and forces unnatural picks where it is confident.
    arith  — variable-rate arithmetic coder (arith.py); each token carries ~its actual
             information content. Measured ~25% shorter cover text than block k=3 on gpt2,
             AND more natural, because it follows the model's own distribution instead of
             overriding it. CODEC_TOPN (default 64) sets the candidate-set size.
"""
import os
import threading

import arith
import coder
import wordmap
import zerog

# The gpt2 backend keeps stateful KV cache, so serialize access (server is threaded).
_lock = threading.Lock()

BACKEND = os.environ.get("CODEC_BACKEND", "auto").lower()
K = int(os.environ.get("CODEC_K", "3"))
CODER = os.environ.get("CODEC_CODER", "block").lower()  # "block" | "arith"
TOPN = int(os.environ.get("CODEC_TOPN", "64"))  # arith candidate-set size
# Falling back to the wordmap placeholder is allowed only when asked for explicitly, or when
# it IS what was asked for. Tests and local dev set CODEC_BACKEND=wordmap; production does
# not, and there a silent fallback should be a startup failure rather than a quiet downgrade.
ALLOW_WORDMAP = BACKEND == "wordmap" or os.environ.get("CODEC_ALLOW_WORDMAP", "") == "1"

_kind: str
_model = None
MODEL: str
DIGEST: str


def _pick(which: str | None) -> str:
    """Resolve a per-request coder name against the deployment default.

    The coder is PER REQUEST, not per deployment, and that is load-bearing: both extensions
    call the SAME codec instance (§6.2 — one warm process is what makes encode and decode
    deterministic against each other). Flipping a global default would therefore silently
    change the coder under the Telegram build too, and every message already sitting in a
    Telegram chat would stop decoding — encoded with block, read back with arith. Letting the
    caller name its coder means the X build can take the shorter one without touching history.
    """
    name = (which or CODER).lower()
    return name if name in ("block", "arith") else CODER


def _hide(data: bytes, model, which: str | None = None) -> str:
    """Encode via the selected coder. Single choke point: the self-test, the encoder and the
    decoder all route through here, so a mismatched coder is impossible by construction."""
    if _pick(which) == "arith":
        return arith.encode(data, model, TOPN)
    return coder.encode(data, model, K)


def _seek(cover: str, model, which: str | None = None) -> bytes:
    if _pick(which) == "arith":
        return arith.decode(cover, model, TOPN)
    return coder.decode(cover, model, K)


def _rate() -> str:
    """The coder half of the MODEL string, so /health reports what actually ran."""
    return f"arith-t{TOPN}" if CODER == "arith" else f"k{K}"


def _selftest(model) -> None:
    # CODEC_SELFTEST=0 skips; small payloads keep cold-boot fast (matters on fly).
    n = int(os.environ.get("CODEC_SELFTEST", "3"))
    for _ in range(n):
        x = os.urandom(1 + os.urandom(1)[0] % 8)
        if _seek(_hide(x, model), model) != x:
            raise RuntimeError("self-test round-trip failed")


def _load() -> None:
    global _kind, _model, MODEL, DIGEST
    if BACKEND in ("auto", "gpt2"):
        try:
            from model_gpt2 import GPT2Model

            m = GPT2Model()
            _selftest(m)
            _kind, _model = "gpt2", m
            MODEL, DIGEST = f"gpt2/{_rate()}", m.digest()
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
            MODEL, DIGEST = f"markov-o{order}/{_rate()}", m.digest()
            print(f"[codec] backend=markov order={order} k={K} ({MODEL} {DIGEST})")
            return
        except Exception as e:  # noqa: BLE001
            if BACKEND == "markov":
                raise
            print(f"[codec] markov unavailable ({e}); falling back to wordmap")
    # wordmap is a byte->word table, not steganography: the cover text is a deterministic
    # public encoding anyone can reverse without a key. Confidentiality still rests entirely
    # on AES-SIV, so nothing leaks — but the product claim ("hidden in ordinary chatter") does
    # not hold, and a silent degradation is exactly the kind of thing that goes unnoticed
    # until it is on stage. In production, refuse rather than pretend.
    if ALLOW_WORDMAP:
        _kind = "wordmap"
        MODEL, DIGEST = wordmap.MODEL, wordmap.DIGEST
        print(f"[codec] backend=wordmap ({MODEL} {DIGEST})")
        print("[codec] WARNING: wordmap is a placeholder, NOT steganography — cover text is "
              "publicly reversible. Set CODEC_BACKEND=gpt2 or markov for a real backend.")
        return
    raise RuntimeError(
        "no real codec backend loaded (gpt2 and markov both unavailable) and wordmap is "
        "disabled. Set CODEC_ALLOW_WORDMAP=1 to run on the placeholder anyway."
    )


_load()


def select_info() -> str:
    return f"0g-best-of-{zerog.VARIANTS}" if zerog.enabled() else "off"


def encode(data: bytes, fast: bool = False, coder_name: str | None = None) -> tuple[str, str]:
    """(cover text, selection method). fast=True skips best-of-N (single cover, no 0G
    round-trip) — used for handshake frames, which carry only public keys.

    The method is returned rather than dropped because 0G selection fails SILENTLY by
    design (falls back to the first cover). Without it, a 0G outage is invisible: the
    client keeps claiming "0G judged this" on a blind timer, and the one thing the 0G
    prize asks us to prove is the thing we would stop noticing had stopped happening."""
    if _kind not in ("gpt2", "markov"):
        return wordmap.encode(data), "single"
    # generate N candidate covers (only if 0G selection is enabled AND not fast — else 1)
    n = 1 if fast or not zerog.enabled() else zerog.VARIANTS
    with _lock:  # model is stateful; hold the lock only for generation
        covers = [_hide(data, _model, coder_name) for _ in range(n)]
    if n == 1:
        return covers[0], "single"
    return zerog.select_best(covers)  # 0G network call OUTSIDE the lock


def decode(cover: str, coder_name: str | None = None) -> bytes:
    if _kind in ("gpt2", "markov"):
        with _lock:
            return _seek(cover, _model, coder_name)
    return wordmap.decode(cover)
