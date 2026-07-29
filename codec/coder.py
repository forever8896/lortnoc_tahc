"""
Block (bin) steganographic coder — model-agnostic and EXACTLY reversible.

At each step the model yields its top 2^k candidate tokens (deterministic order); we
consume k ciphertext bits as an index into them and emit that token. To reverse, we
re-run the model over the same tokens, find each token's index → recover the k bits.
Because generation only ever picks from the model's own top-2^k, decoding always finds
the token there — reversibility does not depend on WHICH model, only that it is
deterministic. That's why `test_coder.py` can prove correctness with a mock model,
with no GPU.

Payload framing, in order:

    nonce(_NONCE bytes) · length(2 bytes, big-endian) · data · zero-bit padding

The 2-byte length caps a single payload at 65,535 bytes; `hide` rejects anything larger up
front rather than letting `int.to_bytes` raise from the middle of the framing. The trailing
padding fills the last token's spare bits and is ignored on the way back.
"""

import os

#: Largest payload the 2-byte length header can describe.
MAX_PAYLOAD = 0xFFFF


class NotCoverText(ValueError):
    """This text is not something we encoded — ordinary chatter.

    A DISTINCT type on purpose. server.py answers /decode with 422, and the extension treats
    422 as the *cacheable* "definitely not ours" verdict: it records the bubble and never
    retries it. That is only safe if 422 means exactly this. When every ValueError mapped to
    422, any internal coder bug would have been cached as a verdict about the user's message
    and silently swallowed it forever — the same failure mode the RETRY symbol in inbound.ts
    exists to prevent, arriving through the server instead of the client.
    """

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
    if len(data) > MAX_PAYLOAD:
        # Explicit, rather than an OverflowError from int.to_bytes below. server.py accepts
        # bodies far larger than this (MAX_BODY is 256 KiB), so the boundary is reachable.
        raise ValueError(f"payload too large: {len(data)} bytes, max {MAX_PAYLOAD}")
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
        try:
            idx = cands.index(tok)
        except ValueError:
            # The model never offered this token at this step, so we did not emit it.
            raise NotCoverText("token is not one of ours") from None
        for j in range(k - 1, -1, -1):
            bits.append((idx >> j) & 1)
        ctx = model.extend(ctx, tok)
    data = _from_bits(bits)
    length = int.from_bytes(data[_NONCE : _NONCE + 2], "big")
    start = _NONCE + 2
    if start + length > len(data):
        # Every token was one of ours but the framing does not add up: text that looks like
        # cover text and is not (or a truncated copy of ours). Either way, not decodable.
        raise NotCoverText("length header does not match the decoded payload")
    return data[start : start + length]


def encode(data: bytes, model, k: int) -> str:
    """ciphertext bytes -> cover text."""
    return model.to_words(hide(data, model, k))


def decode(cover: str, model, k: int) -> bytes:
    """cover text -> ciphertext bytes. Raises on any non-cover word / bad token."""
    return reveal(model.from_words(cover), model, k)
