"""Round-trip tests for the wordmap backend and the active dispatcher backend."""
import os

import wordmap
import codec


def test_wordmap_roundtrip_and_shape():
    for _ in range(100):
        x = os.urandom(1 + os.urandom(1)[0])
        cover = wordmap.encode(x)
        assert cover == cover.strip() and "  " not in cover
        assert cover.isascii() and all(c.islower() or c == " " for c in cover)
        assert wordmap.decode(cover) == x
        assert wordmap.encode(x) == cover  # deterministic


def test_wordmap_empty():
    assert wordmap.encode(b"") == "" and wordmap.decode("") == b""


def test_active_backend_roundtrip():
    # whichever backend loaded (gpt2 if torch present, else wordmap)
    for _ in range(10):
        x = os.urandom(1 + os.urandom(1)[0] % 32)
        assert codec.decode(codec.encode(x)) == x


if __name__ == "__main__":
    test_wordmap_roundtrip_and_shape()
    test_wordmap_empty()
    test_active_backend_roundtrip()
    print(f"ok — wordmap round-trips; active backend = {codec.MODEL}")
