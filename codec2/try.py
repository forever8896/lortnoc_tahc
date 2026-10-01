"""Bake-off: how many words, how natural, does it round-trip. usage: try.py <hf model> [nbytes...]"""
import os
import sys
import time

import torch

from stego import Model, best_of, opener

THREADS = [
    ("reddit", "r/AskEurope: What is something from your country that tourists always get wrong? Honestly the amount of people who think Copenhagen is the capital of Sweden still surprises me."),
    ("reddit", "r/cycling: Finally finished my first 100km ride this weekend. Legs are dead but it was worth it, the coastal road was beautiful."),
    ("news", "City council approves new bike lanes on the main boulevard after months of debate. Construction is expected to start in spring and last about six months."),
    ("x", "Hot take: the best coffee in town is from the tiny place next to the train station, not any of the fancy ones."),
]


def main():
    name = sys.argv[1]
    sizes = [int(a) for a in sys.argv[2:]] or [8]
    dtype = torch.bfloat16 if os.environ.get("BF16") else torch.float32
    t0 = time.time()
    m = Model(name, dtype=dtype, temperature=float(os.environ.get("TEMP", "0.9")), top_p=float(os.environ.get("TOPP", "0.92")))
    print(f"# {name}  load {time.time() - t0:.1f}s  temp {m.temperature} top_p {m.top_p}")
    for n in sizes:
        for platform, thread in THREADS:
            t1 = time.time()
            first = opener(m, platform, thread)
            payload, text = best_of(m, platform, first, n, tries=int(os.environ.get("TRIES", "4")))
            dt = time.time() - t1
            if not text:
                print(f"  [{n}B {platform}] no candidate ({dt:.1f}s)")
                continue
            print(f"  [{n}B {platform}] words={len(text.split())} total={dt:.1f}s for best-of-{os.environ.get('TRIES', '4')}")
            print(f"     > {text}")

if __name__ == "__main__":
    main()
