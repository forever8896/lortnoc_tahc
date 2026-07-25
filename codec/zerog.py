"""
Best-of-N cover selection via 0G Compute (an honest "proof of 0G inference").

The codec generates several valid covers (different nonces — all decode to the same
message) and asks a 0G-hosted LLM which reads most like a natural human message. 0G only
*judges* the cover text (which is public — it's what goes to Telegram); it never sees the
plaintext or the ciphertext, so reversibility and the §4 invariant are untouched.

Config (fly secrets / env):
    ZEROG_API_KEY   wallet-created key from pc.0g.ai   (required to enable 0G)
    ZEROG_MODEL     a chat model id served by 0G       (required to enable 0G)
    ZEROG_BASE      default https://router-api.0g.ai/v1
    CODEC_VARIANTS  how many covers to generate & rank (default 1 = off)

Falls back to the first variant on any failure, so the codec never breaks if 0G is down.
"""
import json
import os
import re
import urllib.request

BASE = os.environ.get("ZEROG_BASE", "https://router-api.0g.ai/v1").rstrip("/")
KEY = os.environ.get("ZEROG_API_KEY", "")
MODEL = os.environ.get("ZEROG_MODEL", "")
VARIANTS = max(1, int(os.environ.get("CODEC_VARIANTS", "1")))


def enabled() -> bool:
    return bool(KEY and MODEL and VARIANTS > 1)


def _ask_0g(covers: list[str]) -> int | None:
    """Index of the most natural cover per 0G, or None on any failure."""
    numbered = "\n".join(f"{i + 1}. {c}" for i, c in enumerate(covers))
    prompt = (
        "Below are casual text messages someone might send a friend. Choose the ONE that "
        "reads most like a natural, coherent human message (best flow, least awkward or "
        "random). Reply with ONLY its number, nothing else.\n\n" + numbered
    )
    body = json.dumps(
        {
            "model": MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            "max_tokens": 4,
        }
    ).encode()
    req = urllib.request.Request(
        f"{BASE}/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.load(r)
        txt = data["choices"][0]["message"]["content"]
        m = re.search(r"\d+", txt)
        if not m:
            return None
        idx = int(m.group()) - 1
        return idx if 0 <= idx < len(covers) else None
    except Exception:
        return None


def select_best(covers: list[str]) -> tuple[str, str]:
    """(chosen cover, method: '0g' | 'fallback' | 'single')."""
    if len(covers) <= 1:
        return covers[0], "single"
    idx = _ask_0g(covers)
    if idx is not None:
        return covers[idx], "0g"
    return covers[0], "fallback"
