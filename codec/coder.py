"""
Block (bin) steganographic coder — model-agnostic and EXACTLY reversible.

At each step the model yields its top 2^k candidate tokens (deterministic order); we
consume k ciphertext bits as an index into them and emit that token. To reverse, we
re-run the model over the same tokens, find each token's index → recover the k bits.
Because generation only ever picks from the model's own top-2^k, decoding always finds
the token there — reversibility does not depend on WHICH model, only that it is
deterministic. That's why `test_coder.py` can prove correctness with a mock model,
with no GPU.

A 4-byte big-endian length header prefixes the payload so decode knows where the real
bytes end (the last token's spare bits are padding and ignored).
"""

import os

# Random prefix in front of the payload so the cover text OPENS differently every message
# — otherwise the (mostly-zero) length header makes every message start with the model's
# greedy continuation of the fixed prime (a visible tell). Ignored on decode.
_NONCE = 2


def _to_bits(data: bytes) -> list[int]:
    return [(byte >> i) & 1 for byte in data for i in range(7, -1, -1)]


def _from_bits(bits: list[int]) -> bytes:
    out = bytearray()
    n = len(bits) - (len(bits) % 8)
    for i in range(0, n, 8):
        b = 0
        for j in range(8):
            b = (b << 1) | bits[i + j]
        out.append(b)
    return bytes(out)


def hide(data: bytes, model, k: int) -> list[int]:
    """ciphertext bytes -> list of token ids (each token carries k bits)."""
    payload = os.urandom(_NONCE) + len(data).to_bytes(2, "big") + data
    bits = _to_bits(payload)
    bits += [0] * ((-len(bits)) % k)  # pad up to a whole number of tokens
    ctx = model.start()
    tokens: list[int] = []
    for i in range(0, len(bits), k):
        idx = 0
        for j in range(k):
            idx = (idx << 1) | bits[i + j]
        cands = model.topk(ctx, k)
        tok = cands[idx]
        tokens.append(tok)
        ctx = model.extend(ctx, tok)
    return tokens


def reveal(tokens: list[int], model, k: int) -> bytes:
    """list of token ids -> ciphertext bytes."""
    ctx = model.start()
    bits: list[int] = []
    for tok in tokens:
        cands = model.topk(ctx, k)
        idx = cands.index(tok)  # ValueError if not one of ours
        for j in range(k - 1, -1, -1):
            bits.append((idx >> j) & 1)
        ctx = model.extend(ctx, tok)
    data = _from_bits(bits)
    length = int.from_bytes(data[_NONCE : _NONCE + 2], "big")
    start = _NONCE + 2
    if start + length > len(data):
        raise ValueError("truncated payload")
    return data[start : start + length]


def encode(data: bytes, model, k: int) -> str:
    """ciphertext bytes -> cover text."""
    return model.to_words(hide(data, model, k))


def decode(cover: str, model, k: int) -> bytes:
    """cover text -> ciphertext bytes. Raises on any non-cover word / bad token."""
    return reveal(model.from_words(cover), model, k)
