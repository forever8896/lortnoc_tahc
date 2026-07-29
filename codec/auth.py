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

# ---- x402 (HTTP 402 payment protocol) — the paywall is a real x402 resource ----------------
# The codec sells a MEMBERSHIP as an x402 resource: an unpaid request gets a spec-shaped 402
# with `accepts` payment requirements; a request bearing a valid X-PAYMENT is settled (via a
# facilitator) and gets a membership token back. Membership (not per-call) keeps §8 intact:
# pay once via a wallet ≠ identity → reusable bearer token carrying a nullifier, never the
# handle. All fields env-configurable so the chain/asset/price aren't hardcoded (prize req).
X402_NETWORK = os.environ.get("X402_NETWORK", "base-sepolia")  # x402 network slug
X402_PAY_TO = os.environ.get("X402_PAY_TO", "")  # 0x recipient (treasury; ≠ identity, §4)
X402_ASSET = os.environ.get("X402_ASSET", "")  # 0x token (e.g. USDC); "" = native
X402_PRICE = os.environ.get("X402_PRICE", "10000")  # atomic units (10000 = 0.01 USDC @ 6dp)
X402_ASSET_NAME = os.environ.get("X402_ASSET_NAME", "USDC")  # EIP-712 domain name
X402_ASSET_VERSION = os.environ.get("X402_ASSET_VERSION", "2")  # EIP-712 domain version
X402_FACILITATOR = os.environ.get("X402_FACILITATOR", "https://x402.org/facilitator")
X402_DEV_ACCEPT = os.environ.get("X402_DEV_ACCEPT", "") == "1"  # accept any payment (dev only)
X402_TIMEOUT = int(os.environ.get("X402_TIMEOUT", "60"))  # maxTimeoutSeconds

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


def reserve(handle, membership) -> dict:
    """Atomically check-and-claim one free send. Returns {allow, member, remaining}
    (remaining=-1 for members).

    Reserve/release rather than check-then-spend, because the caller does a multi-second model
    call between deciding and charging. When those were separate steps, N concurrent requests
    from one handle at remaining=1 all passed the check before any of them charged, and every
    one got cover text — the free limit was soft against a trivially parallel client. Claiming
    the slot inside the same lock as the check closes that; `release` refunds it if the encode
    fails, so a codec error still costs the user nothing.
    """
    if verify_membership(membership):
        return {"allow": True, "member": True, "remaining": -1}
    key = _norm_handle(handle)
    with _lock:
        used = _counts.get(key, 0)
        if used >= FREE_LIMIT:
            return {"allow": False, "member": False, "remaining": 0}
        _counts[key] = used + 1
        return {"allow": True, "member": False, "remaining": FREE_LIMIT - (used + 1)}


def release(handle) -> int:
    """Refund a reservation whose encode failed. Never goes below zero."""
    key = _norm_handle(handle)
    with _lock:
        _counts[key] = max(0, _counts.get(key, 0) - 1)
        return _counts[key]


def authorize(handle, membership) -> dict:
    """Read-only view of the gate, for callers that must not consume quota (tests, /health).
    The request path uses reserve()."""
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
    return {
        "enforce": ENFORCE,
        "freeLimit": FREE_LIMIT,
        "paid": "hmac-token" if SECRET else "off",
        "x402": {"network": X402_NETWORK, "price": X402_PRICE, "payTo": bool(X402_PAY_TO)},
    }


# ---- x402 protocol helpers -----------------------------------------------------------------

def x402_requirements(resource: str, description: str) -> dict:
    """One `accepts` entry per the x402 spec (scheme=exact)."""
    entry = {
        "scheme": "exact",
        "network": X402_NETWORK,
        "maxAmountRequired": X402_PRICE,
        "resource": resource,
        "description": description,
        "mimeType": "application/json",
        "payTo": X402_PAY_TO,
        "maxTimeoutSeconds": X402_TIMEOUT,
        "asset": X402_ASSET,
    }
    if X402_ASSET:  # EIP-712 domain for ERC-3009 tokens (USDC etc.)
        entry["extra"] = {"name": X402_ASSET_NAME, "version": X402_ASSET_VERSION}
    return entry


def x402_402_body(resource: str, description: str, error: str) -> dict:
    """Spec-shaped 402 body: { x402Version, accepts[], error }."""
    return {"x402Version": 1, "accepts": [x402_requirements(resource, description)], "error": error}


def x402_settle_header(settlement: dict) -> str:
    """Value for the X-PAYMENT-RESPONSE header (base64url JSON of the settlement receipt)."""
    return _b64u(json.dumps(settlement, separators=(",", ":")).encode())


def verify_payment(x_payment: str, requirements: dict):
    """Verify + settle an X-PAYMENT header against `requirements`. Returns a settlement receipt
    dict on success, else None. SEAM: real settlement is delegated to an x402 facilitator
    (POST /verify then /settle); X402_DEV_ACCEPT short-circuits for local testing."""
    if not x_payment:
        return None
    try:
        payment = json.loads(_unb64u(x_payment))
    except Exception:
        return None

    if X402_DEV_ACCEPT:  # dev/testing: trust a well-formed payment, no chain call
        payer = ((payment.get("payload") or {}).get("authorization") or {}).get("from", "0xdev")
        return {"success": True, "network": X402_NETWORK, "payer": payer, "txHash": "dev", "dev": True}

    # Production: hand the payment + requirements to the facilitator to verify then settle.
    try:
        v = _facilitator("/verify", {"x402Version": 1, "paymentPayload": payment, "paymentRequirements": requirements})
        if not v or not v.get("isValid"):
            return None
        s = _facilitator("/settle", {"x402Version": 1, "paymentPayload": payment, "paymentRequirements": requirements})
        if not s or not s.get("success"):
            return None
        return {
            "success": True,
            "network": s.get("network", X402_NETWORK),
            "payer": s.get("payer") or v.get("payer", ""),
            "txHash": s.get("transaction") or s.get("txHash", ""),
        }
    except Exception:
        return None


def _facilitator(path: str, body: dict):
    """POST to the x402 facilitator (stdlib urllib; kept tiny and dependency-free)."""
    import urllib.request

    req = urllib.request.Request(
        X402_FACILITATOR.rstrip("/") + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=X402_TIMEOUT) as resp:
        return json.loads(resp.read().decode())
