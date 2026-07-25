"""
GPT-2 model backend for the block coder (model_mock.MockModel's real counterpart).

Two properties make it safe for our pipeline:
  * Telegram byte-safety: candidate tokens are restricted to whole lowercase words with
    a leading space (BPE "Ġword") that re-encode to themselves. Cover text is therefore
    just lowercase words + single spaces — nothing Telegram normalizes, and word→token
    is unambiguous on the reveal side.
  * Determinism: greedy full-distribution inference (no sampling) on CPU; one warm
    process serves both ends, so hide and reveal see identical logits (CLAUDE.md §6.2).

Interface matches model_mock.MockModel exactly, so coder.py / test_coder.py are unchanged.
Stateful KV cache makes each generation step O(1) instead of O(n).

Requires: torch, transformers (see requirements.txt). Model: gpt2 (124M), CPU.
"""
from __future__ import annotations

import os
import re

# Priming context sets the TONE of the cover text (it's not emitted — identical on both
# ends). A warm, chatty opener makes GPT-2 continue as friendly small-talk instead of
# drifting into confessional rambling. Tune live via the CODEC_PRIME env (no rebuild).
DEFAULT_PRIME = (
    "hey!! oh my gosh it has honestly been way too long since we properly caught up, "
    "i have so much to tell you haha. ok so the other day i was just chatting with a "
    "friend about how"
)

DEFAULT_MODEL = "gpt2"  # base gpt2 with a friendly prime (fast KV path). Override w/ CODEC_MODEL.

# Keep cover text friendly: drop profanity / slurs / sexual / strongly-negative words
# from the candidate vocab so the coder can't grab them. (Demo hygiene, not exhaustive.)
BLOCKLIST = set(
    (
        # profanity / slurs
        "fuck fucking fucked fuckin shit shitty bullshit ass asshole bitch bastard dick "
        "cock pussy cunt slut whore damn goddamn crap piss prick douche fag faggot "
        "nigger nigga retard "
        # sexual / suggestive
        "sex sexy porn porno nude naked nsfw tits tit titties boobs boob breast breasts "
        "wet horny penis vagina vaginal orgasm cum cumming semen sperm erection boner "
        "masturbate blowjob handjob anal anus nipple nipples clit clitoris dildo kinky "
        "fetish thong panties lingerie seductive aroused moan moaning thrust penetrate "
        "hole holes butt booty twerk stripper strip laid banged humping "
        # violence / dark
        "rape raped raping kill killed killing murder murdered suicide die died dying "
        "death dead corpse blood bloody gore hate hatred hell"
    ).split()
)


class GPT2Model:
    def __init__(self, model_name: str | None = None):
        import torch
        from transformers import GPT2LMHeadModel, GPT2TokenizerFast

        model_name = model_name or os.environ.get("CODEC_MODEL", DEFAULT_MODEL)
        self.PRIMING = os.environ.get("CODEC_PRIME", DEFAULT_PRIME)

        self.torch = torch
        self.tok = GPT2TokenizerFast.from_pretrained(model_name)
        self.model = GPT2LMHeadModel.from_pretrained(model_name)
        self.model.eval()
        torch.manual_seed(0)

        # Build the safe token set: " word" (leading space + lowercase), idempotent.
        safe_ids: list[int] = []
        self.tok2word: dict[int, str] = {}
        self.word2tok: dict[str, int] = {}
        pat = re.compile(r" [a-z]+")
        for tid in range(self.tok.vocab_size):
            s = self.tok.decode([tid])
            if not pat.fullmatch(s):
                continue
            w = s[1:]
            if len(w) < 2:  # drop single-letter tokens → no "x o l m" degeneration
                continue
            if w in BLOCKLIST:  # keep the tone friendly
                continue
            if w in self.word2tok:
                continue
            if self.tok.encode(" " + w) != [tid]:  # must round-trip to itself
                continue
            safe_ids.append(tid)
            self.tok2word[tid] = w
            self.word2tok[w] = tid
        if len(safe_ids) < 64:
            raise RuntimeError(f"only {len(safe_ids)} safe word tokens; need >= 64")
        self.safe_ids = torch.tensor(sorted(safe_ids), dtype=torch.long)

        self._priming_ids = self.tok.encode(self.PRIMING)
        self._reset()

    # ---- internal KV-cached state ----
    def _reset(self) -> None:
        with self.torch.no_grad():
            ids = self.torch.tensor([self._priming_ids], dtype=self.torch.long)
            out = self.model(ids, use_cache=True)
        self._past = out.past_key_values
        self._logits = out.logits[0, -1]
        self._ctx: tuple[int, ...] = ()

    def _feed(self, tok: int) -> None:
        with self.torch.no_grad():
            ids = self.torch.tensor([[tok]], dtype=self.torch.long)
            out = self.model(ids, past_key_values=self._past, use_cache=True)
        self._past = out.past_key_values
        self._logits = out.logits[0, -1]

    def _rebuild(self, ctx: tuple[int, ...]) -> None:
        self._reset()
        for t in ctx:
            self._feed(t)
        self._ctx = ctx

    def _ensure(self, ctx: tuple[int, ...]) -> None:
        if ctx == self._ctx:
            return
        if len(ctx) == len(self._ctx) + 1 and ctx[:-1] == self._ctx:
            self._feed(ctx[-1])
            self._ctx = ctx
        else:
            self._rebuild(ctx)

    # ---- model interface (matches MockModel) ----
    def start(self) -> tuple:
        self._reset()
        return ()

    def extend(self, ctx: tuple, tok: int) -> tuple:
        return ctx + (tok,)

    def topk(self, ctx: tuple, k: int) -> list[int]:
        self._ensure(ctx)
        vals = self._logits[self.safe_ids]
        n = 1 << k
        top = self.torch.topk(vals, n)
        pairs = [(float(v), int(self.safe_ids[i])) for v, i in zip(top.values, top.indices)]
        pairs.sort(key=lambda p: (-p[0], p[1]))  # deterministic tie-break by token id
        return [tid for _, tid in pairs]

    def to_words(self, tokens: list[int]) -> str:
        return " ".join(self.tok2word[t] for t in tokens)

    def from_words(self, cover: str) -> list[int]:
        return [self.word2tok[w] for w in cover.split()]  # KeyError if not our word

    def digest(self) -> str:
        import hashlib

        basis = self.PRIMING + "|" + ",".join(map(str, self.safe_ids.tolist()[:64]))
        return hashlib.sha256(basis.encode()).hexdigest()[:16]
