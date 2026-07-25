#!/usr/bin/env python3
"""
Build a casual-texting fine-tune dataset for the cover model (JSONL).

Goal: nudge Qwen2.5-0.5B-Instruct toward friendly, mundane small-talk so the codec's
cover text reads like real texting. We fine-tune on *completion-style* casual messages
(the codec uses the model as a next-token predictor, not an instruction follower), but
emit the 0G "instruction/input/output" JSONL shape the fine-tuning CLI expects, using a
fixed casual-continuation instruction.

This is a STARTER corpus (templated, a few hundred lines). Expand `SEEDS` for better
results before a real run. Output: finetune/casual.jsonl
"""
import json
import os

# Casual, mundane, friendly message fragments — the register we want cover text to have.
SEEDS = [
    "hey so i was just thinking about grabbing coffee later if you're around",
    "omg you will not believe what happened at work today it was so funny",
    "did you end up watching that show everyone keeps talking about lol",
    "i'm so tired today i literally could not get out of bed this morning",
    "we should totally plan something for the weekend maybe hit the park",
    "my sister just got a new puppy and it's honestly the cutest thing ever",
    "traffic was insane on the way home i was stuck for like an hour",
    "thinking of trying that new pizza place downtown wanna come with",
    "haha yeah i totally forgot to reply sorry my day has been all over the place",
    "the weather has been so nice lately i just wanna be outside all day",
    "i finally finished that book i was reading it was actually really good",
    "can you believe it's already almost the end of the month time flies",
    "just made way too much pasta for dinner come over and help me eat it",
    "my phone battery keeps dying so fast lately it's driving me crazy",
    "we went for a long walk by the river this morning it was so peaceful",
    "honestly i just want a quiet weekend to relax and do nothing for once",
    "did you hear that our old teacher is retiring this year kinda wild",
    "i keep meaning to start going to the gym but never quite make it there",
    "the kids were so excited about the trip they could barely sleep last night",
    "let me know when you're free this week and we'll figure out a plan",
    "i tried making bread from scratch and it actually turned out okay somehow",
    "work has been super busy but things should calm down after this week",
    "we watched the sunset from the hill last night and it was gorgeous",
    "my neighbor keeps playing music really loud but honestly the songs slap",
    "i think i left my umbrella at the cafe again i always do that",
    "so glad it's almost the weekend i really need a break to be honest",
    "the garden is finally starting to bloom and it looks really lovely now",
    "we're thinking of driving up to the lake this summer if the timing works",
    "i had the weirdest dream last night and now i can't stop thinking about it",
    "just wanted to check in and see how you've been doing lately",
]

INSTRUCTION = "Continue this casual text message to a friend in a natural, friendly tone."


def main() -> None:
    here = os.path.dirname(__file__)
    out = os.path.join(here, "casual.jsonl")
    rows = []
    for s in SEEDS:
        words = s.split()
        # split each seed into (prompt, continuation) at a few points for variety
        for cut in (3, 5, 7):
            if cut < len(words) - 1:
                rows.append(
                    {
                        "instruction": INSTRUCTION,
                        "input": " ".join(words[:cut]),
                        "output": " " + " ".join(words[cut:]),
                    }
                )
    with open(out, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"wrote {len(rows)} examples -> {out}")
    print("expand SEEDS for a stronger model before a real fine-tune run.")


if __name__ == "__main__":
    main()
