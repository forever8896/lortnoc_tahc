"""
Which words can a candidate model ACTUALLY emit as cover text?

Run this BEFORE any fine-tuning run. It answers the question that gates the whole idea, in
seconds, instead of after a multi-day 0G training job.

WHY IT IS THE GATE. The codec emits one whole lowercase word per token and needs a strict
word<->token bijection to stay reversible (see model_gpt2.py's safe-token construction: a word
qualifies only if `tok.encode(" " + w) == [tid]`). So the emittable vocabulary is fixed by the
TOKENIZER, and fine-tuning cannot change it — training shifts probabilities over tokens that
already exist. If "mogging" is three tokens in the base model, no amount of training on
mogging-heavy text will ever make the codec say it.

That is why the choice of BASE MODEL, not the training data, decides whether modern slang is
reachable at all. GPT-2's BPE is frozen at 2019 WebText; Qwen2.5's is far newer and much larger.

    python3 check_vocab.py                          # default: gpt2
    python3 check_vocab.py Qwen/Qwen2.5-0.5B-Instruct
    python3 check_vocab.py gpt2 --words rizz mogging based
"""

import argparse
import re
import sys

# The register the X surface wants (PRD §1.1: optimise cover for curiosity, not plausibility).
DEFAULT_WORDS = [
    # neologisms — the ones most likely to be multi-token
    "maxxing", "looksmaxxing", "mogging", "mogged", "rizz", "gyatt", "bussin", "goated",
    "ngmi", "wagmi", "cooked", "yapping", "delulu", "skibidi",
    # slang senses of ordinary words — likely single tokens already, but in their literal sense
    "based", "cope", "sus", "mid", "fire", "ratio", "vibe", "cringe", "lit", "fam",
    "bruh", "simp", "chad", "sigma", "npc", "doomer", "zoomer", "normie", "yeet", "slaps",
]

SAFE = re.compile(r" [a-z]+")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("model", nargs="?", default="gpt2")
    ap.add_argument("--words", nargs="*", default=None)
    args = ap.parse_args()

    try:
        from transformers import AutoTokenizer
    except ImportError:
        print("transformers not installed — pip install transformers", file=sys.stderr)
        return 2

    tok = AutoTokenizer.from_pretrained(args.model)
    words = args.words or DEFAULT_WORDS

    emittable, blocked = [], []
    for w in words:
        ids = tok.encode(" " + w)
        # Both conditions the codec applies: exactly one token, and it decodes back to " word"
        # with nothing else attached. A token that round-trips to something different would
        # break `from_words` and take the whole cover text down with it.
        ok = len(ids) == 1 and SAFE.fullmatch(tok.decode(ids)) is not None
        (emittable if ok else blocked).append((w, len(ids)))

    print(f"model: {args.model}   vocab: {tok.vocab_size}\n")
    print(f"EMITTABLE ({len(emittable)}/{len(words)}) — single token, survives the safe-token filter")
    print("  " + (", ".join(w for w, _ in emittable) or "(none)"))
    print(f"\nBLOCKED ({len(blocked)}/{len(words)}) — multi-token, can NEVER appear in cover text")
    print("  " + (", ".join(f"{w}({n})" for w, n in blocked) or "(none)"))

    if blocked:
        print(
            "\nThe blocked column is not a training problem — it is a tokenizer problem. "
            "Fine-tuning cannot fix it; a different base model might."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
