"""
Markov (n-gram) model for the block coder — natural-flowing cover text, no GPU.

Same interface as model_gpt2.GPT2Model / model_mock.MockModel, so coder.py is unchanged
and reversibility is still proven by test_coder.py. Instead of random words (wordmap),
each word is chosen from the most likely successors of the previous word(s) per an
n-gram model trained on public-domain prose — so cover text reads like (rambling but)
locally-coherent English sentences.

topk() prefers higher-order (trigram) successors, backs off to bigram, then to the global
top words — always returning exactly 2^k distinct, deterministic candidates (required by
the block coder). Trained tables are cached to .cache/markov-*.pkl.
"""
from __future__ import annotations

import os
import pickle
import re

_HERE = os.path.dirname(__file__)
_CACHE = os.path.join(_HERE, ".cache")
# public-domain corpora (Project Gutenberg); fetched once, cached in .cache/
_CORPORA = {
    "pride.txt": "https://www.gutenberg.org/files/1342/1342-0.txt",
    "alice.txt": "https://www.gutenberg.org/files/11/11-0.txt",
    "frank.txt": "https://www.gutenberg.org/files/84/84-0.txt",
}
_VERSION = 3  # bump to rebuild cache


def _ensure_corpora() -> None:
    import urllib.request

    os.makedirs(_CACHE, exist_ok=True)
    for name, url in _CORPORA.items():
        p = os.path.join(_CACHE, name)
        if os.path.exists(p) and os.path.getsize(p) > 10000:
            continue
        with urllib.request.urlopen(url, timeout=30) as r:
            open(p, "wb").write(r.read())


def _strip_gutenberg(text: str) -> str:
    start = re.search(r"\*\*\* ?START OF .*?\*\*\*", text)
    end = re.search(r"\*\*\* ?END OF .*?\*\*\*", text)
    return text[(start.end() if start else 0) : (end.start() if end else len(text))]


class MarkovModel:
    # a natural opener so cover text doesn't start with "the of ..."
    PRIME = "i was just thinking about how"

    def __init__(self, order: int = 3):
        self.order = order
        self._load_or_build()
        self._prime = tuple(self.word2id[w] for w in self.PRIME.split() if w in self.word2id)

    # ---------- training ----------
    def _load_or_build(self) -> None:
        cache = os.path.join(_CACHE, f"markov-o{self.order}-v{_VERSION}.pkl")
        if os.path.exists(cache):
            with open(cache, "rb") as f:
                d = pickle.load(f)
            self.id2word, self.word2id, self.global_top, self.ngrams = d
            return

        _ensure_corpora()
        text = ""
        for name in _CORPORA:
            p = os.path.join(_CACHE, name)
            if os.path.exists(p):
                text += "\n" + _strip_gutenberg(open(p, encoding="utf-8", errors="ignore").read())
        tokens = re.findall(r"[a-z]+", text.lower())
        if len(tokens) < 5000:
            raise RuntimeError(f"corpus too small ({len(tokens)} tokens); fetch .cache/*.txt")

        # vocab: words seen >= 2, id ordered by frequency desc then alpha (deterministic)
        from collections import Counter

        counts = Counter(tokens)
        vocab = sorted((w for w, c in counts.items() if c >= 2), key=lambda w: (-counts[w], w))
        self.word2id = {w: i for i, w in enumerate(vocab)}
        self.id2word = vocab
        self.global_top = list(range(len(vocab)))  # already frequency-ordered

        ids = [self.word2id[t] for t in tokens if t in self.word2id]
        # ngram successor counts for orders 1..order
        succ: list[dict] = [dict() for _ in range(self.order + 1)]
        for o in range(1, self.order + 1):
            table = succ[o]
            for i in range(o, len(ids)):
                key = tuple(ids[i - o : i])
                nxt = ids[i]
                d = table.get(key)
                if d is None:
                    table[key] = {nxt: 1}
                else:
                    d[nxt] = d.get(nxt, 0) + 1
        # freeze: successor ids ordered by (count desc, id asc)
        self.ngrams = [
            {key: [w for w, _ in sorted(d.items(), key=lambda p: (-p[1], p[0]))] for key, d in table.items()}
            for table in succ
        ]

        os.makedirs(_CACHE, exist_ok=True)
        with open(cache, "wb") as f:
            pickle.dump((self.id2word, self.word2id, self.global_top, self.ngrams), f)

    # ---------- model interface ----------
    def start(self) -> tuple:
        return self._prime  # priming context (not emitted; just seeds the first words)

    def extend(self, ctx: tuple, tok: int) -> tuple:
        return ctx + (tok,)

    def topk(self, ctx: tuple, k: int) -> list[int]:
        n = 1 << k
        out: list[int] = []
        seen: set[int] = set()
        for o in range(min(self.order, len(ctx)), 0, -1):
            for s in self.ngrams[o].get(ctx[-o:], ()):  # higher-order first (more coherent)
                if s not in seen:
                    seen.add(s)
                    out.append(s)
                    if len(out) >= n:
                        return out[:n]
        for s in self.global_top:  # pad deterministically to exactly 2^k
            if s not in seen:
                seen.add(s)
                out.append(s)
                if len(out) >= n:
                    break
        return out[:n]

    def to_words(self, tokens: list[int]) -> str:
        return " ".join(self.id2word[t] for t in tokens)

    def from_words(self, cover: str) -> list[int]:
        return [self.word2id[w] for w in cover.split()]  # KeyError if not our word

    def digest(self) -> str:
        import hashlib

        return hashlib.sha256(("|".join(self.id2word[:64]) + str(self.order)).encode()).hexdigest()[:16]
