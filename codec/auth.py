#!/usr/bin/env python3
"""
Capability gate for /encode (CLAUDE.md §7, §8, §9). Turns the freemium limit from a
client-side honor-system counter into SERVER-SIDE enforcement at the one server we run —
the codec, which is the actual paid resource (GPT-2 + 0G inference). A modified client
can no longer bypass by clearing local storage: without a valid capability it simply gets
no cover text back.

Two tiers:
  FREE  — metered server-side by the client-asserted Telegram handle (§9, non-anonymous).
          The count lives HERE, not in the browser, so clearing local storage no longer
          resets it — farming free quota now costs a fresh Telegram account (Sybil-cost).
  PAID  — a signed MEMBERSHIP token bypasses metering (unlimited). The token carries the
          Semaphore NULLIFIER, never the handle or the payment wallet, so the codec never
          learns which payment maps to which usage (§8 unlinkability preserved).

Honesty (keep it in the pitch):
  * The handle is client-ASSERTED — a determined client can spoof it. This raises the cost
    of cheating from "clear storage" to "create Telegram accounts"; it is not unforgeable.
  * Counts are in-memory: a redeploy/restart resets them. Fine for the demo; a persistent
    store (SQLite/Redis) is the production upgrade.
  * The membership token is a bearer capability (shareable within its short lifetime). The
    clean version has the client present a fresh zk-proof per session that we verify on
    0G directly (verify_nullifier_onchain seam below), not a minted token we trust.

Config (env):
  CODEC_ENFORCE  "1" to enforce. Default OFF, so an un-updated client keeps working; flip
                 it on (fly secret) once the extension sends the handle.
  CODEC_SECRET   HMAC secret for signing/verifying membership tokens (paid path).
  FREE_LIMIT     free sends per handle before 402 (default 10).
  UPGRADE_URL    where the 402 tells the client to go.
"""
import base64
import hashlib
import hmac
import json
import os
import threading
import time

ENFORCE = os.environ.get("CODEC_ENFORCE", "") == "1"
SECRET = os.environ.get("CODEC_SECRET", "").encode()
FREE_LIMIT = int(os.environ.get("FREE_LIMIT", "10"))
UPGRADE_URL = os.environ.get("UPGRADE_URL", "https://app.lortnoctahc.com/upgrade")
TOKEN_TTL = int(os.environ.get("MEMBERSHIP_TTL", "3600"))  # membership token lifetime (s)

_counts = {}  # handle -> free sends used (in-memory; resets on restart)
_lock = threading.Lock()

_ANON = "@anon"  # bucket for requests that assert no handle — shared, so still limited


def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign_token(nullifier: str, ttl: int = None) -> str:
    """Mint a membership token: base64url(json).base64url(hmac). Server-side ONLY — the
    holder of SECRET (this codec or a trusted gateway) mints it after confirming the
    caller's nullifier is a registered member on 0G. Never ship SECRET to the client."""
    if not SECRET:
        raise RuntimeError("CODEC_SECRET not set")
    payload = {"v": 1, "nul": nullifier, "exp": int(time.time()) + (ttl or TOKEN_TTL)}
    body = _b64u(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    sig = _b64u(hmac.new(SECRET, body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"


def verify_membership(token) -> bool:
    """True iff `token` is a validly-signed, unexpired membership token carrying a nullifier."""
    if not token or not SECRET:
        return False
    try:
        body, sig = token.split(".", 1)
        expected = _b64u(hmac.new(SECRET, body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return False
        payload = json.loads(_unb64u(body))
        if int(payload.get("exp", 0)) < int(time.time()):
            return False
        return bool(payload.get("nul"))  # must carry a nullifier (§8)
    except Exception:
        return False


def verify_nullifier_onchain(nullifier: str) -> bool:
    """SEAM for the clean paid path: check `nullifier` is a registered, unspent member on the
    0G-mainnet LortnocMembership contract via a read-only eth_call, replacing bearer tokens
    with per-session on-chain verification. Wire this to the deployed contract; stubbed now."""
    raise NotImplementedError("on-chain nullifier verification not wired yet")


def _norm_handle(handle) -> str:
    h = (handle or "").strip().lower()
    if not h:
        return _ANON
    return h if h.startswith("@") else "@" + h


def authorize(handle, membership) -> dict:
    """Decide whether this /encode may proceed. Does NOT spend — call spend() after a
    successful encode. Returns {allow, member, remaining} (remaining=-1 for members)."""
    if verify_membership(membership):
        return {"allow": True, "member": True, "remaining": -1}
    key = _norm_handle(handle)
    with _lock:
        used = _counts.get(key, 0)
    return {"allow": used < FREE_LIMIT, "member": False, "remaining": max(0, FREE_LIMIT - used)}


def spend(handle) -> int:
    """Record one used free send against the handle. Returns the new count."""
    key = _norm_handle(handle)
    with _lock:
        _counts[key] = _counts.get(key, 0) + 1
        return _counts[key]


def status() -> dict:
    """Non-sensitive gate config for /health."""
    return {"enforce": ENFORCE, "freeLimit": FREE_LIMIT, "paid": "hmac-token" if SECRET else "off"}
