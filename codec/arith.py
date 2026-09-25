"""
Arithmetic (range) steganographic coder — model-agnostic and EXACTLY reversible.

Where the block coder (coder.py) forces EXACTLY k bits per word, this coder lets each
word carry ~its actual information content (variable bits/word ≈ the model's entropy over
its top-`top_n` candidates). Result: on a real peaked LM the cover text stays natural
(high-probability words are cheap) instead of being padded with forced low-rank picks.

How it works — arithmetic coding with the encode/decode roles SWAPPED for stego:

    hide(payload)  = arithmetic-DECODE the payload bit-stream into tokens.
                     Each token is the symbol whose probability sub-interval contains the
                     running code value; high-probability tokens consume few payload bits.
    reveal(tokens) = arithmetic-ENCODE the token sequence back into the exact bit-stream.

`reveal` is a pure, deterministic function of the tokens (it IS the range encoder), so it
is the ground truth. `hide` generates tokens by decoding, then VERIFIES by re-encoding that
the first N payload bits are reproduced byte-for-byte, topping up tokens if the arithmetic
tail needs one more. That verify makes round-trip exactness airtight *by construction*,
not by luck — `test_arith.py` proves it over 100+ payloads with the mock model.

Reversibility does not depend on WHICH model, only that it is deterministic and returns
identical integer weights on both ends — exactly like the block coder, which is why the
mock-model test is a sufficient correctness proof (no GPU needed).

Framing matches coder.py: a random `_NONCE`-byte prefix (varies the opening) + a 2-byte
big-endian length header + payload; trailing bits are padding and ignored on reveal.

The coder is INTEGER-ONLY: model weights are positive integers and the range arithmetic is
32-bit integer math. No floats touch the coder — floats would desync encode/decode across
the finite-precision arithmetic.
"""

import bisect
import os

from coder import _NONCE, _from_bits, _to_bits  # identical framing as the block coder

# ---- 32-bit range coder constants (Witten–Neal–Cleary / CACM style) ----
PRECISION = 32
WHOLE = 1 << PRECISION          # 2^32
HALF = WHOLE >> 1               # 2^31
QUARTER = WHOLE >> 2            # 2^30
THREE_Q = QUARTER * 3           # 3 * 2^30
MASK = WHOLE - 1                # 2^32 - 1

# Total cumulative weight must stay <= QUARTER so the active range (always > QUARTER after
# renormalization) never underflows a symbol's sub-interval to width 0. Our dist() weights
# are tiny (top_n<=~256 tokens, each <= 2^16) so this only ever rescales pathological cases.
MAX_TOTAL = QUARTER


def _prepare(dist):
    """[(tok, w), ...] -> (tokens, cumulative, total) with positive integer weights.

    Deterministically rescales if the total would exceed MAX_TOTAL. Floors every weight at
    1 so no symbol has a zero-width interval. Identical output for identical input on both
    ends (integer-only) — the determinism the round-trip relies on.
    """
    tokens = [t for t, _ in dist]
    weights = [max(1, int(w)) for _, w in dist]
    total = sum(weights)
    if total > MAX_TOTAL:
        weights = [max(1, (w * MAX_TOTAL) // total) for w in weights]
        total = sum(weights)
    cum = [0]
    for w in weights:
        cum.append(cum[-1] + w)
    return tokens, cum, cum[-1]


def _encode_tokens(tokens, model, top_n):
    """Range-ENCODE a token sequence -> list of bits. This is reveal()'s core.

    Raises ValueError if a token is not in the model's candidate set at its step (the
    stego detector: a non-cover / corrupted word can't be encoded — analogous to the block
    coder's .index() failure and the AES-SIV auth-tag check upstream).
    """
    low = 0
    high = MASK
    pending = 0
    bits = []

    def emit(bit):
        nonlocal pending
        bits.append(bit)
        while pending:
            bits.append(bit ^ 1)
            pending -= 1

    ctx = model.start()
    for tok in tokens:
        toks, cum, total = _prepare(model.dist(ctx, top_n))
        try:
            j = toks.index(tok)
        except ValueError:
            raise ValueError("token not in model distribution (not our cover / corrupted)")
        rng = high - low + 1
        high = low + (rng * cum[j + 1]) // total - 1
        low = low + (rng * cum[j]) // total
        while True:
            if high < HALF:
                emit(0)
            elif low >= HALF:
                emit(1)
                low -= HALF
                high -= HALF
            elif low >= QUARTER and high < THREE_Q:
                pending += 1
                low -= QUARTER
                high -= QUARTER
            else:
                break
            low <<= 1
            high = (high << 1) | 1
        ctx = model.extend(ctx, tok)

    # flush: emit one bit that disambiguates the final interval, plus the pending run
    pending += 1
    emit(0 if low < QUARTER else 1)
    return bits


class _Decoder:
    """Range-DECODER: turns a payload bit-stream into tokens (hide()'s generator).

    Reads bits from `payload_bits`, returning 0 once exhausted (the arithmetic tail reads a
    little past the real payload; those zero-driven tokens re-encode to padding bits that
    reveal() ignores). `renorm` counts renormalization shifts ≈ payload bits consumed, used
    only as a cheap stop heuristic — correctness is enforced by hide()'s re-encode verify.
    """

    def __init__(self, model, top_n, payload_bits):
        self.model = model
        self.top_n = top_n
        self.bits = payload_bits
        self.pos = 0
        self.renorm = 0
        self.low = 0
        self.high = MASK
        self.value = 0
        for _ in range(PRECISION):
            self.value = (self.value << 1) | self._next()
        self.ctx = model.start()

    def _next(self):
        if self.pos < len(self.bits):
            b = self.bits[self.pos]
            self.pos += 1
            return b
        return 0

    def step(self):
        toks, cum, total = _prepare(self.model.dist(self.ctx, self.top_n))
        rng = self.high - self.low + 1
        scaled = ((self.value - self.low + 1) * total - 1) // rng
        j = bisect.bisect_right(cum, scaled) - 1
        if j < 0:
            j = 0
        elif j > len(cum) - 2:
            j = len(cum) - 2
        tok = toks[j]
        self.high = self.low + (rng * cum[j + 1]) // total - 1
        self.low = self.low + (rng * cum[j]) // total
        while True:
            if self.high < HALF:
                pass
            elif self.low >= HALF:
                self.value -= HALF
                self.low -= HALF
                self.high -= HALF
            elif self.low >= QUARTER and self.high < THREE_Q:
                self.value -= QUARTER
                self.low -= QUARTER
                self.high -= QUARTER
            else:
                break
            self.low <<= 1
            self.high = (self.high << 1) | 1
            self.value = ((self.value << 1) & MASK) | self._next()
            self.renorm += 1
        self.ctx = self.model.extend(self.ctx, tok)
        return tok


def hide(data: bytes, model, top_n: int) -> list:
    """ciphertext bytes -> list of token ids (variable bits per token)."""
    payload = os.urandom(_NONCE) + len(data).to_bytes(2, "big") + data
    bits = _to_bits(payload)
    n = len(bits)

    dec = _Decoder(model, top_n, bits)
    tokens = []
    cap = n * 8 + 128  # safety only; real stop is renorm/verify below
    # Over-generate slightly (+PRECISION covers the 32-bit look-ahead buffer) so the verify
    # below almost always passes on the first try — keeps hide O(2n) model calls, not O(n^2).
    while dec.renorm < n + PRECISION and len(tokens) < cap:
        tokens.append(dec.step())

    # Airtight check: reveal() is exactly _encode_tokens(); require it to reproduce the
    # payload's meaningful prefix. Top up one token at a time only if the arithmetic tail
    # falls short (rare; bounded).
    for _ in range(64):
        produced = _encode_tokens(tokens, model, top_n)
        if len(produced) >= n and produced[:n] == bits:
            return tokens
        if len(tokens) >= cap:
            break
        tokens.append(dec.step())
    raise RuntimeError("arith hide failed to converge (should never happen)")


def reveal(tokens: list, model, top_n: int) -> bytes:
    """list of token ids -> ciphertext bytes. Raises on any non-cover word / bad token."""
    bits = _encode_tokens(tokens, model, top_n)
    data = _from_bits(bits)
    if len(data) < _NONCE + 2:
        raise ValueError("truncated payload")
    length = int.from_bytes(data[_NONCE : _NONCE + 2], "big")
    start = _NONCE + 2
    if start + length > len(data):
        raise ValueError("truncated payload")
    return data[start : start + length]


def encode(data: bytes, model, top_n: int) -> str:
    """ciphertext bytes -> cover text."""
    return model.to_words(hide(data, model, top_n))


def decode(cover: str, model, top_n: int) -> bytes:
    """cover text -> ciphertext bytes. Raises on any non-cover word / bad token."""
    return reveal(model.from_words(cover), model, top_n)
