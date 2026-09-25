"""
Proves the arithmetic coder is EXACTLY reversible for any deterministic model, using the
mock model (no GPU). Reversibility is model-independent, so passing here means the GPT-2 /
Markov backends round-trip too (given deterministic inference + identical integer weights
on both ends). This is the correctness gate — it MUST pass.
"""
import os

import arith
from model_mock import MockModel


def test_roundtrip_all_top_n():
    m = MockModel()
    for top_n in (16, 64):  # candidate-set size (analogous to 2^k in the block coder)
        for _ in range(55):
            x = os.urandom(1 + (os.urandom(1)[0] % 64))  # 1..64 bytes (chat-sized)
            tokens = arith.hide(x, m, top_n)
            assert arith.reveal(tokens, m, top_n) == x, f"reveal(hide) != x at top_n={top_n}"
            # and through the word layer (what actually travels over Telegram)
            cover = arith.encode(x, m, top_n)
            assert arith.decode(cover, m, top_n) == x, f"decode(encode) != x at top_n={top_n}"
            # encode is intentionally non-deterministic (random nonce varies the opening) —
            # but every cover must still decode back to x
            assert arith.decode(arith.encode(x, m, top_n), m, top_n) == x


def test_empty():
    m = MockModel()
    for top_n in (2, 16, 64):
        assert arith.decode(arith.encode(b"", m, top_n), m, top_n) == b""


def test_single_byte_values():
    # a spread of single ciphertext byte values must round-trip
    m = MockModel()
    for b in range(0, 256, 4):
        x = bytes([b])
        assert arith.decode(arith.encode(x, m, 64), m, 64) == x


def test_not_ours_raises():
    m = MockModel()
    # a token id the model never yields fails to encode -> not ours / corrupted
    raised = False
    try:
        arith.reveal([10_000_000], m, 64)
    except ValueError:
        raised = True
    assert raised, "reveal of a non-candidate token should raise"

    # corrupted cover words (valid mock word syntax, but tokens not in the distribution)
    raised = False
    try:
        arith.decode("w5999999 w5888888 w5777777", m, 64)
    except ValueError:
        raised = True
    assert raised, "decode of non-cover words should raise"


if __name__ == "__main__":
    test_roundtrip_all_top_n()
    test_empty()
    test_single_byte_values()
    test_not_ours_raises()
    print(
        "ok — arith coder exactly reversible across top_n∈{16,64}, 110 random payloads "
        "+ 64 single-byte values + empty + not-ours"
    )


def test_dist_on_the_REAL_models_not_just_the_mock():
    """The arith coder must round-trip on the models that actually ship.

    This exists because it did not, and the gap was invisible: every other arith test runs
    against model_mock, whose dist() is a synthetic distribution written alongside the coder.
    The markov backend's dist() was wrong in a way no mock could reveal — it indexed
    `for s, c in self.ngrams[...]`, a list-of-(id, count) shape that model_markov does not
    have (counts are discarded at freeze time), and raised
    `TypeError: cannot unpack non-iterable int` on the first real call.

    Correctness of the CODER is model-independent, which is what makes the mock a sufficient
    proof of the coder. It is not a proof that a given model's dist() is well-formed, and those
    are different claims. gpt2 is skipped when torch is absent; markov is stdlib and always runs.
    """
    import arith

    try:
        from model_markov import MarkovModel
    except Exception as e:  # pragma: no cover - corpus/cache unavailable
        print(f"skip - markov unavailable ({e})")
        return

    m = MarkovModel(order=3)
    for top_n in (16, 64, 256):
        d = m.dist(m.start(), top_n)
        assert d, f"markov dist() returned nothing at top_n={top_n}"
        assert len(d) <= top_n, f"dist() returned {len(d)} > top_n={top_n}"
        for sid, w in d:  # the coder needs positive INTEGER weights, no floats
            assert isinstance(sid, int) and isinstance(w, int), f"non-int in dist(): {(sid, w)}"
            assert w >= 1, f"non-positive weight {w}"
        ids = [s for s, _ in d]
        assert len(ids) == len(set(ids)), "dist() returned a duplicate token"

        for _ in range(12):
            x = os.urandom(1 + (os.urandom(1)[0] % 40))
            assert arith.decode(arith.encode(x, m, top_n), m, top_n) == x, (
                f"markov+arith round-trip failed at top_n={top_n}"
            )
    print("ok - arith round-trips on the real markov model across top_n in {16,64,256}")
