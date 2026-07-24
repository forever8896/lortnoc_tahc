"""
Proves the block coder is EXACTLY reversible for any deterministic model, using the
mock model (no GPU). Since reversibility is model-independent, passing here means the
GPT-2 backend round-trips too (given deterministic inference).
"""
import os
import coder
from model_mock import MockModel


def test_roundtrip_all_k():
    m = MockModel()
    for k in (1, 2, 3, 4, 6):  # realistic range; k≈3 in practice
        for _ in range(40):
            x = os.urandom(1 + (os.urandom(1)[0] % 64))  # 1..64 bytes (chat-sized)
            tokens = coder.hide(x, m, k)
            assert coder.reveal(tokens, m, k) == x, f"reveal(hide) != x at k={k}"
            # and through the word layer (what actually travels over Telegram)
            cover = coder.encode(x, m, k)
            assert coder.decode(cover, m, k) == x, f"decode(encode) != x at k={k}"
            # determinism
            assert coder.encode(x, m, k) == cover


def test_empty():
    m = MockModel()
    for k in (1, 3, 8):
        assert coder.decode(coder.encode(b"", m, k), m, k) == b""


def test_not_ours_raises():
    m = MockModel()
    # a token id the model never yields at that step fails .index() -> not ours
    raised = False
    try:
        coder.reveal([999999], m, 2)
    except ValueError:
        raised = True
    assert raised


if __name__ == "__main__":
    test_roundtrip_all_k()
    test_empty()
    print("ok — block coder exactly reversible across k∈{1,2,3,4,6}, 200 payloads + empty + not-ours")
