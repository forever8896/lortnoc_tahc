# codec service

Deterministic, reversible cover-text coder for the Telegram overlay (PRD §7, CLAUDE.md §6.2).
Sees **ciphertext only** — never plaintext, never a key.

## Contract

```
POST /encode  { "ciphertext": <base64> }  -> { "coverText": <string> }   # lowercase words + spaces
POST /decode  { "coverText": <string> }    -> { "ciphertext": <base64> }
GET  /health                               -> { "model", "digest", "ready" }
```

`decode(encode(x)) == x` for all byte strings, deterministically. One warm process serves **both**
ends of a conversation, so the coder is identical on encode and decode.

## Backends (`CODEC_BACKEND`, default `auto`)

| value | what | needs |
|---|---|---|
| `gpt2` | **Real LLM stego** — block coder over GPT-2; cover text = natural-ish lowercase words | `torch`, `transformers` |
| `wordmap` | Byte→word placeholder; word-like but not grammatical | nothing (stdlib) |
| `auto` | Try `gpt2`, run a round-trip **self-test**; on any failure fall back to `wordmap` (loud log) | — |

The GPT-2 backend restricts candidates to whole lowercase words that re-encode to themselves, so cover
text stays byte-safe through Telegram (no markdown/emoji/case Telegram would normalize) and word→token
is unambiguous on decode. It's deterministic (greedy, CPU) and reversibility is **model-independent** —
proven by `test_coder.py` with a mock, so it holds for GPT-2 given deterministic inference.

`CODEC_K` (default 3) = bits hidden per token in `gpt2` (higher = shorter cover text, less natural).

## Run

```bash
# real GPT-2 backend:
pip install -r requirements.txt
CODEC_BACKEND=gpt2 python3 server.py      # self-tests on startup, then serves
# or just:  python3 server.py             # auto: gpt2 if available, else wordmap

# expose the ONE instance for the two-laptop demo:
cloudflared tunnel --url http://localhost:8080
```

## Test

```bash
python3 test_coder.py     # block coder exactly reversible (mock model, no GPU) — the core proof
python3 test_codec.py     # wordmap round-trip + active-backend round-trip
```

## Files

```
server.py        stdlib HTTP server (/encode /decode /health), threaded, CORS + LNA hedge
codec.py         dispatcher: picks backend, self-tests gpt2, serializes stateful calls
coder.py         model-agnostic block (bin) coder — EXACTLY reversible
model_gpt2.py    GPT-2 backend: safe lowercase-word tokens + KV-cached greedy inference
model_mock.py    deterministic mock model (for test_coder, no GPU)
wordmap.py       byte→word fallback coder
```

The real steganographic quality lives in `model_gpt2.py`; the reversibility guarantee lives in
`coder.py` (proven) — they compose so swapping the model never touches the HTTP contract or the extension.
