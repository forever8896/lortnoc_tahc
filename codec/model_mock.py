"""
Deterministic mock model — same interface as model_gpt2.GPT2Model, no GPU/torch.
Lets test_coder.py prove the block coder's exact reversibility model-independently.
Context is a rolling 64-bit int so each step is O(1) (not O(n)).

Model interface (shared with the GPT-2 backend):
    start()            -> opaque context
    extend(ctx, tok)   -> new context
    topk(ctx, k)       -> list of exactly 2^k DISTINCT token ids, deterministic order
    to_words(tokens)   -> cover string
    from_words(cover)  -> list of token ids
"""
_M = (1 << 64) - 1


class MockModel:
    def __init__(self, vocab: int = 6000):
        self.vocab = vocab

    def start(self) -> int:
        return 0xCBF29CE484222325  # FNV-1a offset basis

    def extend(self, ctx: int, tok: int) -> int:
        return ((ctx ^ (tok & _M)) * 0x100000001B3) & _M  # FNV-1a step

    def topk(self, ctx: int, k: int) -> list[int]:
        n = 1 << k
        out: list[int] = []
        i = 0
        while len(out) < n:
            h = ((ctx + i * 0x9E3779B97F4A7C15) * 0x2545F4914F6CDD1D) & _M
            v = h % self.vocab
            if v not in out:
                out.append(v)
            i += 1
        return out

    def to_words(self, tokens: list[int]) -> str:
        return " ".join(f"w{t}" for t in tokens)

    def from_words(self, cover: str) -> list[int]:
        return [int(w[1:]) for w in cover.split()]
