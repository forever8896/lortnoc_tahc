"""decode(encode(x)) == x for random payloads, and deterministic across calls."""
import os
import codec


def test_roundtrip_and_determinism():
    for _ in range(100):
        x = os.urandom(1 + (os.urandom(1)[0]))  # 1..256 random bytes
        cover = codec.encode(x)
        # plain ASCII, words + single spaces only (invariant §4)
        assert cover == cover.strip()
        assert "  " not in cover
        assert all(c.islower() or c == " " for c in cover), cover
        assert cover.isascii()
        assert codec.decode(cover) == x
        # deterministic
        assert codec.encode(x) == cover


def test_empty():
    assert codec.encode(b"") == ""
    assert codec.decode("") == b""


if __name__ == "__main__":
    test_roundtrip_and_determinism()
    test_empty()
    print("ok — 100 random round-trips + determinism + empty case pass")
