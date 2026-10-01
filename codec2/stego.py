"""
codec2: short, natural cover text. Prototype, separate from the live `codec/` on purpose: every
post already published was written by codec/ (block coder, gpt2) and must keep decoding.

What is different from codec/:
  * ARITHMETIC coding over the model's real (temperature + top-p truncated) distribution, so each
    word carries only as many bits as the model is actually unsure about. No forced 6 bits/word.
  * EXACT arithmetic: the interval is kept as Python integers that grow as needed, so there is no
    precision to drift (the 32-bit range coder in codec/arith.py needs renormalisation care).
  * The payload is a FIXED, short bit string: a locator into the drop store (drops.py). Encoding stops being
    "information-carrying" as soon as the interval pins the payload's bits, then the reply simply
    continues naturally to the end of the sentence. The reader ignores those trailing words: they
    narrow the interval further but never move it out of the payload's bucket.
  * Context: a reply is an OPENER written from the thread (no bits) and a CARRIER whose context is
    only the platform template plus that opener (see "Two-part replies" below), so the reader needs
    nothing from the page but its platform.
  * Normal text: letters, digits, punctuation, capitals. One paragraph, ASCII only.

Determinism contract (same as codec/): both ends run the same model weights in the same process
type, and logits are turned into an INTEGER frequency table before the coder sees them, so the
coder never touches floats.
"""
from __future__ import annotations

import math
import os
import re

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

QUANT = 1 << 16  # integer resolution of each step's distribution

# Characters a cover reply may contain. ASCII, no newlines, no @ # (mentions/hashtags), no markup.
SAFE = re.compile(r"[A-Za-z0-9 .,!?'\-:;()/%$&]*")


class Model:
    def __init__(self, name: str, dtype=torch.float32, temperature=0.9, top_p=0.92):
        torch.manual_seed(0)
        torch.set_num_threads(int(os.environ.get("THREADS", "6")))
        self.name = name
        self.tok = AutoTokenizer.from_pretrained(name)
        self.lm = AutoModelForCausalLM.from_pretrained(name, dtype=dtype)
        self.lm.eval()
        self.temperature, self.top_p = temperature, top_p
        # which vocabulary entries may appear in a reply
        self.allowed = torch.zeros(self.lm.config.vocab_size, dtype=torch.bool)
        for tid in range(len(self.tok)):
            s = self.tok.decode([tid])
            if s and s.strip() and SAFE.fullmatch(s) and "  " not in s:
                self.allowed[tid] = True
        self.ends = {tid for tid in range(len(self.tok)) if self.allowed[tid] and self.tok.decode([tid]).rstrip().endswith((".", "!", "?"))}

    @torch.no_grad()
    def step(self, ids, past):
        out = self.lm(input_ids=torch.tensor([ids]), past_key_values=past, use_cache=True)
        return out.logits[0, -1].double(), out.past_key_values

    def table(self, logits, hist=()):
        """logits -> [(token, integer weight)] in a fixed order: the coder's whole view of the model.

        `hist` is the reply so far. No 3-gram may repeat (stops "11min 12min 13min..." loops); a pure
        function of the tokens, so the reader computes the identical table."""
        logits = logits.clone()
        logits[~self.allowed[: logits.shape[0]]] = -math.inf
        if len(hist) >= 2:
            a, b = hist[-2], hist[-1]
            for i in range(len(hist) - 2):
                if hist[i] == a and hist[i + 1] == b:
                    logits[hist[i + 2]] = -math.inf
        p = torch.softmax(logits / self.temperature, dim=-1)
        order = torch.argsort(p, descending=True, stable=True)
        ps = p[order]
        keep = int((torch.cumsum(ps, 0) < self.top_p).sum().item()) + 1
        w = torch.floor(ps[:keep] * QUANT).to(torch.int64)
        nz = w > 0
        tids, w = order[:keep][nz], w[nz]
        if tids.numel() == 0:
            tids, w = order[:1], torch.ones(1, dtype=torch.int64)
        # integer cumulative table: token i owns [cum[i] - w[i], cum[i])
        return tids, torch.cumsum(w, 0)


def prompt(platform: str, context: str) -> str:
    """The shared context. MUST be built identically by writer and reader."""
    context = " ".join(context.split())[:600]
    if platform == "reddit":
        return f"{context}\n\nReply:"
    if platform == "x":
        return f"Tweet: {context}\nReply:"
    return f"{context}\n\nComment:"


def _bits(data: bytes):
    return int.from_bytes(data, "big"), len(data) * 8


def hide(model: Model, payload: bytes, ctx: str, max_tokens=90, finish=True, pad_seed=0, tail=25) -> str | None:
    """payload bits -> reply text. Arithmetic DECODING of the payload, driven by the model."""
    x, n = _bits(payload)
    # the payload as a binary fraction, followed by padding bits that only steer the free tail
    PAD = 64
    import random
    rnd = random.Random(pad_seed)
    X = (x << PAD) | rnd.getrandbits(PAD)
    W = 1 << (n + PAD)  # X / W in [0, 1)
    lo_n, lo_d = 0, 1   # interval [lo, hi) as fractions with common denominator den
    lo, hi, den = 0, 1, 1
    ids = model.tok(ctx, add_special_tokens=False).input_ids
    logits, past = model.step(ids, None)
    out = []
    pinned = False
    ended = False
    extra = 0
    for _ in range(max_tokens):
        tids, cum = model.table(logits, out)
        total = int(cum[-1])
        # where X falls inside [lo, hi): scale everything to denominator den*total
        span = hi - lo
        # find token j with lo + span*cum_j/total <= X/W < lo + span*cum_{j+1}/total
        # i.e. cum_j <= (X*den/W - lo)*total/span < cum_{j+1}
        pos = ((X * den - lo * W) * total) // (span * W)
        j = int(torch.searchsorted(cum, torch.tensor(pos, dtype=torch.int64), right=True))
        tid = int(tids[j])
        c1 = int(cum[j]); c0 = int(cum[j - 1]) if j else 0
        lo, hi, den = lo * total + span * c0, lo * total + span * c1, den * total
        out.append(tid)
        # pinned once the whole interval sits inside one n-bit bucket
        if not pinned and (lo << n) // den == ((hi << n) - 1) // den:
            pinned = True
        if pinned and (not finish or tid in model.ends):
            ended = True
            break
        if pinned:
            extra += 1
            if extra > tail:
                return None  # no clean sentence end in reach: let the caller try another locator
        logits, past = model.step([tid], past)
    if not pinned or not ended:
        return None  # ran into the length cap: never post a reply that stops mid-sentence
    return model.tok.decode(out)


@torch.no_grad()
def reveal(model: Model, text: str, ctx: str, nbits: int) -> bytes | None:
    """reply text -> payload bits, or None if the text cannot be ours.

    Step by step with the KV cache, EXACTLY like hide(). A single full-sequence pass would be
    faster but computes slightly different float logits (measured: every round trip failed), and
    after quantisation a different table means different bits. Same computation on both ends."""
    ids = model.tok(ctx, add_special_tokens=False).input_ids
    rid = model.tok(text, add_special_tokens=False).input_ids
    if not rid:
        return None
    logits, past = model.step(ids, None)
    lo, hi, den = 0, 1, 1
    for k, tid in enumerate(rid):
        tids, cum = model.table(logits, rid[:k])
        total = int(cum[-1])
        hit = (tids == tid).nonzero()
        if hit.numel() == 0:
            return None  # a word the coder could never have chosen: not ours
        j = int(hit[0, 0])
        c1 = int(cum[j]); c0 = int(cum[j - 1]) if j else 0
        span = hi - lo
        lo, hi, den = lo * total + span * c0, lo * total + span * c1, den * total
        if (lo << nbits) // den == ((hi << nbits) - 1) // den:
            return ((lo << nbits) // den).to_bytes(nbits // 8, "big")
        if k + 1 < len(rid):
            logits, past = model.step([tid], past)
    return None

def best_of(model: Model, platform: str, opener: str, nbytes: int, tries=4, max_words=45, payloads=None):
    """The writer chooses the locator, so it can try several and keep the best reply.
    `payloads` are the candidates (random if not given). Returns (payload, reply) where reply =
    opener + carrier. The winner is verified by running the READER on the whole reply first."""
    ctx = carrier_prompt(platform, opener)
    cands = []
    limit = 90
    payloads = payloads or [os.urandom(nbytes) for _ in range(tries)]
    for i, payload in enumerate(payloads):
        text = hide(model, payload, ctx, pad_seed=i, max_tokens=limit)
        if not text:
            continue
        carrier = text.strip()
        posted = f"{opener} {carrier}" if opener else carrier
        n = len(carrier.split())
        if n <= max_words and looks_like_reply(posted) and SAFE.fullmatch(posted):
            cands.append((n, posted, payload))
            limit = min(limit, len(model.tok(text, add_special_tokens=False).input_ids))
    for n, posted, payload in sorted(cands, key=lambda c: c[0]):
        if payload in reveal_reply(model, posted, platform, nbytes * 8):
            return payload, posted
    return None, None


# ---------------------------------------------------------------------------
# Two-part replies: a free OPENER, then the CARRIER that holds the locator.
#
# The opener answers the conversation (parent comment, thread title) and carries no bits, so it may
# be written from any context, or typed by the user. The carrier's context is only the platform's
# template plus the opener, both inside the reply itself. So the reader needs nothing from the
# page: a parent edited or deleted, a re-sorted thread, a changed title, or the reply seen in a feed
# all leave decoding untouched. The reader does not know where the opener ends, so it tries every
# sentence boundary (reveal_reply). Wrong splits almost always leave the coder's table within a few
# words; any that do decode only yield a locator whose frame is a decoy.
# ---------------------------------------------------------------------------
BASE = {"reddit": "Reply:", "x": "Reply:", "news": "Comment:"}
MAX_SPLITS = 4


def carrier_prompt(platform: str, opener: str) -> str:
    """The carrier's context. MUST be built identically by writer and reader."""
    base = BASE.get(platform, BASE["news"])
    return f"{base} {opener}" if opener else base


def sentences(text: str) -> list[str]:
    """Deterministic split, used by the reader (and so by the writer's verify step)."""
    return re.split(r"(?<=[.!?]) ", " ".join(text.split()))


def reveal_reply(model: Model, text: str, platform: str, nbits: int) -> list[bytes]:
    """reply -> every locator some split decodes to (usually exactly one, often none)."""
    parts = sentences(text)
    found = []
    for k in range(min(len(parts), MAX_SPLITS)):  # k = sentences in the opener; the carrier keeps >= 1
        got = reveal(model, " " + " ".join(parts[k:]), carrier_prompt(platform, " ".join(parts[:k])), nbits)
        if got and got not in found:
            found.append(got)
    return found


@torch.no_grad()
def opener(model: Model, platform: str, thread: str, tries=4, max_tokens=40) -> str:
    """One sentence answering the thread. Sampled freely: it carries no bits, so nothing about it has
    to be reproducible. '' if no clean sentence comes out (the carrier then stands alone)."""
    import random
    rnd = random.Random(os.urandom(8))
    ids = model.tok(prompt(platform, thread), add_special_tokens=False).input_ids
    for _ in range(tries):
        logits, past = model.step(ids, None)
        out = []
        for _ in range(max_tokens):
            tids, cum = model.table(logits, out)
            pick = torch.tensor(rnd.randrange(int(cum[-1])), dtype=torch.int64)
            tid = int(tids[int(torch.searchsorted(cum, pick, right=True))])
            out.append(tid)
            if tid in model.ends:
                break
            logits, past = model.step([tid], past)
        s = " ".join(model.tok.decode(out).split())
        if out[-1] in model.ends and 3 <= len(s.split()) <= 25 and SAFE.fullmatch(s) and valid_opener(s):
            return s
    return ""


def valid_opener(s: str) -> bool:
    """A user-typed or sampled opener: plain characters, ends a sentence, nothing the filter rejects."""
    s = " ".join(s.split())
    return bool(s) and len(s) <= 300 and bool(SAFE.fullmatch(s)) and s[-1] in ".!?" and not re.search(r"[()]|\d{1,2}:\d{2}", s)


def looks_like_reply(t: str) -> bool:
    """Reject candidates that read like scraped metadata rather than a person talking."""
    letters = sum(c.isalpha() for c in t)
    return (
        len(t.split()) >= 5
        and letters >= 0.7 * len(t.replace(" ", ""))
        and not re.search(r"\d{4}-\d{2}|\d{1,2}:\d{2}|[()]", t)
    )
