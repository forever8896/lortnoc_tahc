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

import re

# Fixed conversational priming so cover text reads like idle chatter. Not part of the
# payload — identical on both ends by construction.
PRIMING = "so anyway i was just thinking about how"


class GPT2Model:
    def __init__(self, model_name: str = "gpt2"):
        import torch
        from transformers import GPT2LMHeadModel, GPT2TokenizerFast

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

        self._priming_ids = self.tok.encode(PRIMING)
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

        basis = PRIMING + "|" + ",".join(map(str, self.safe_ids.tolist()[:64]))
        return hashlib.sha256(basis.encode()).hexdigest()[:16]
