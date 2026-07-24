# codec service

Deterministic, reversible cover-text coder for the Telegram overlay (PRD §7, CLAUDE.md §6.2).
Dependency-free (Python stdlib). Sees **ciphertext only** — never plaintext, never a key.

## Contract

```
POST /encode  { "ciphertext": <base64> }  -> { "coverText": <string> }   # plain lowercase ASCII words
POST /decode  { "coverText": <string> }    -> { "ciphertext": <base64> }
GET  /health                               -> { "model", "digest", "ready" }
```

`decode(encode(x)) == x` for all byte strings, deterministically. One warm process serves **both**
ends of a conversation, so encode-time and decode-time coders are identical by construction.

## Run

```bash
python3 server.py                 # 127.0.0.1:8080
PORT=8080 HOST=0.0.0.0 python3 server.py
python3 test_codec.py             # 100 random round-trips + determinism
```

For the two-laptop demo, expose the one instance over HTTPS so both extensions can reach it:

```bash
cloudflared tunnel --url http://localhost:8080     # -> put the printed URL in each extension's popup
```

## Status

`codec.py` is the **locked-contract placeholder** (`wordmap-256/v1`): each ciphertext byte → one word
from a fixed 256-word table. Byte-exact and plain-ASCII, but word-like rather than grammatical.

The real steganographic coder (GPT-2 arithmetic coding) **replaces `codec.py` behind the same
`encode`/`decode` signatures** — the HTTP contract and the extension are unchanged. It needs
`transformers` + a pinned model run on CPU, greedy/`temp=0` for byte-determinism (CLAUDE.md §6.2, CF-1).
