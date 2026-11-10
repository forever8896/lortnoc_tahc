"""
The gate pointer store: a reply carries only a short LOCATOR; the sealed frame it points at lives here.

    put(locator, frame, token)  first write wins; only the holder of `token` may write `locator`
    get(locator)                ALWAYS answers: the stored frame, or a decoy for an unknown locator

Why a token. The locator is public: anyone who runs the reader's decode learns it from the reply. If
anyone could write any locator, a censor could write junk to it and read it back — getting their own
junk back would prove no post was there, which is exactly what the decoys exist to hide. So the
writer gets the locator as a hash of a random token it alone holds (locator_for), and a write must
present that token. A locator nobody has a token for can never be claimed, so probing is useless.

Why decoys. A sealed frame (shared/sealed.mjs) is uniformly random bytes to anyone without a key,
and since sealed v2 it is always exactly one of BUCKETS bytes long. An unknown locator answers with
random bytes of a bucket size too — derived from a server secret, so the same locator gives the same
bytes every time, like a stored frame would. A GET therefore never says whether a post exists.
Writes of any other length are refused: an odd-sized frame would be the one thing a decoy never is.

Storage: one file per locator, published with os.link, which fails if the name exists — first write
wins atomically, with no lock and no read-modify-write.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets

LABEL = b"lortnoc/drop/v1"
# MUST match BUCKETS in shared/sealed.mjs.
BUCKETS = (256, 512, 1024, 2048, 4096)
MAX_FRAME = BUCKETS[-1]
# How often each size is drawn for a decoy, per 1000. Roughly what real posts look like: a sealed
# post of up to ~180 characters fits the smallest bucket. Statistical, not exact — refine from real
# traffic (counts only, no contents).
DECOY_WEIGHTS = (880, 90, 25, 4, 1)


def locator_for(token: bytes, nbytes: int) -> bytes:
    """The public locator for a writer's secret token."""
    return hashlib.sha256(LABEL + token).digest()[:nbytes]


def new_token() -> bytes:
    return secrets.token_bytes(16)


class DropStore:
    def __init__(self, root: str, secret: bytes | None = None):
        self.root = root
        os.makedirs(root, exist_ok=True)
        self.secret = secret or self._secret()
        self.archive = None      # archive.Archive, when posts also live on Walrus (set by it)

    def _secret(self) -> bytes:
        """Persisted, so a decoy does not change across restarts (a changing answer would mark it)."""
        env = os.environ.get("DROP_SECRET")
        if env:
            return bytes.fromhex(env)
        path = os.path.join(self.root, ".secret")
        try:
            with open(path, "rb") as f:
                return f.read()
        except FileNotFoundError:
            s = secrets.token_bytes(32)
            tmp = f"{path}.{os.getpid()}.tmp"
            with open(tmp, "wb") as f:
                f.write(s)
            try:
                os.link(tmp, path)
            except FileExistsError:
                pass  # another process won; use its secret
            finally:
                os.unlink(tmp)
            with open(path, "rb") as f:
                return f.read()

    def _path(self, locator: bytes) -> str:
        return os.path.join(self.root, locator.hex())

    def put(self, locator: bytes, frame: bytes, token: bytes) -> str:
        """-> 'stored' | 'exists' | 'forbidden' | 'invalid'"""
        if not 4 <= len(locator) <= 16 or len(frame) not in BUCKETS:
            return "invalid"
        if not hmac.compare_digest(locator_for(token, len(locator)), locator):
            return "forbidden"
        if self.archive and self.archive.has(locator.hex()):
            return "exists"                          # first write wins across the archive too
        final = self._path(locator)
        tmp = f"{final}.{secrets.token_hex(6)}.tmp"
        with open(tmp, "wb") as f:
            f.write(frame)
        try:
            os.link(tmp, final)
            return "stored"
        except FileExistsError:
            return "exists"
        finally:
            os.unlink(tmp)

    def get(self, locator: bytes) -> bytes:
        try:
            with open(self._path(locator), "rb") as f:
                return f.read()
        except FileNotFoundError:
            pass
        if self.archive:
            got = self.archive.get(locator.hex())    # on Walrus, not (or no longer) on this disk
            if got is not None:
                return got
        return self.decoy(locator)

    def cache(self, locator: bytes, frame: bytes):
        """Keep a copy of an archived post on disk (no first-write check: it is already the post)."""
        tmp = f"{self._path(locator)}.{secrets.token_hex(6)}.tmp"
        with open(tmp, "wb") as f:
            f.write(frame)
        os.replace(tmp, self._path(locator))

    def decoy(self, locator: bytes) -> bytes:
        seed = hmac.new(self.secret, b"decoy" + locator, hashlib.sha256).digest()
        pick = int.from_bytes(seed[:4], "big") % sum(DECOY_WEIGHTS)
        for n, w in zip(BUCKETS, DECOY_WEIGHTS):
            if pick < w:
                break
            pick -= w
        out, i = b"", 0
        while len(out) < n:
            out += hmac.new(self.secret, seed + i.to_bytes(4, "big"), hashlib.sha256).digest()
            i += 1
        return out[:n]
