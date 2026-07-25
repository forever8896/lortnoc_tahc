# codec service

Deterministic, reversible cover-text coder for the Telegram overlay (PRD §7, CLAUDE.md §6.2).
Sees **ciphertext only** — never plaintext, never a key.

## Contract

```
POST /encode  { "ciphertext": <base64>, "handle"?: <str>, "membership"?: <token>, "fast"?: <bool> }
                                          -> 200 { "coverText": <string>, "remaining": <int>, "member": <bool> }
                                          -> 402 { "error", "upgrade", "remaining": 0 }   # free limit reached
POST /decode  { "coverText": <string> }   -> { "ciphertext": <base64> }                   # always free (§7)
GET  /health                              -> { "model", "digest", "ready", "auth": {...} }
```

`decode(encode(x)) == x` for all byte strings, deterministically. One warm process serves **both**
ends of a conversation, so the coder is identical on encode and decode.

## Capability gate (`auth.py`, §7/§8/§9)

`/encode` — the actual paid resource — is gated so the freemium limit is **enforced server-side**, not
by a client-side counter a modified extension can reset. Off by default; flip on with a fly secret.

- **Free tier** — metered server-side by the client-asserted `handle` (§9, non-anonymous). The count lives
  here, so clearing browser storage no longer resets it; farming free quota costs a fresh Telegram account.
  Over `FREE_LIMIT` → **402** with the `upgrade` URL.
- **Paid tier** — a signed `membership` token (carries the Semaphore **nullifier**, never the handle or
  payment wallet, so payment↔usage stays unlinkable, §8) bypasses metering → unlimited. The token is sold
  over **x402** (below).
- **Handshake frames** (`fast: true`, pubkey-only) and **`/decode`** are never gated — key exchange and
  reading are always free.

Honest limits: the handle is client-asserted (spoofable, but raises cheating cost from "clear storage" to
"make TG accounts"); counts are in-memory (reset on redeploy); the membership token is a bearer capability
(the clean version verifies a fresh nullifier proof on 0G per session — see `verify_nullifier_onchain`).

| env | default | meaning |
|---|---|---|
| `CODEC_ENFORCE` | off | `"1"` turns the gate on |
| `CODEC_SECRET` | — | HMAC secret for minting/verifying membership tokens (paid path) |
| `FREE_LIMIT` | `10` | free sends per handle before 402 |
| `UPGRADE_URL` | app `/upgrade` | where the 402 points the client |
| `MEMBERSHIP_TTL` | `3600` | membership-token lifetime (s) |

## x402 — the paywall is a real payment resource

The `402` isn't a bare error: it's a spec-shaped **x402** response, and membership is sold as an x402
resource at **`POST/GET /membership`**.

```
GET /membership                         -> 402 { x402Version, accepts:[{scheme:"exact", network,
                                                  maxAmountRequired, payTo, asset, ...}], error }
GET /membership  (header X-PAYMENT: …)  -> 200 { token, member, expiresIn }   + X-PAYMENT-RESPONSE header
```

An x402-aware client reads `accepts`, constructs a payment, and retries with `X-PAYMENT`; the codec
delegates verify+settle to an x402 **facilitator**, then mints the bearer `membership` token. `/encode`'s
402 also embeds the same `accepts` (pay inline) alongside a plain `upgrade` URL (non-x402 clients).

**§8 stays intact:** membership is bought **once** (reusable token), by a wallet ≠ identity, and the token
carries a nullifier — so the public payment tx never links to the handle or per-message usage. The clean
version binds a Semaphore nullifier at mint (`sign_token`) instead of the payer address, and funds a
`join()` — see the `verify_nullifier_onchain` seam.

| env | default | meaning |
|---|---|---|
| `X402_NETWORK` | `base-sepolia` | x402 network slug (chain is an open decision) |
| `X402_PAY_TO` | — | `0x` treasury recipient (must be ≠ identity wallet, §4) |
| `X402_ASSET` | — | `0x` token address (e.g. USDC); empty = native |
| `X402_PRICE` | `10000` | membership price, atomic units |
| `X402_FACILITATOR` | `x402.org/facilitator` | verify+settle endpoint |
| `X402_DEV_ACCEPT` | off | `"1"` accepts any well-formed payment (LOCAL TESTING ONLY) |

## Backends (`CODEC_BACKEND`, default `auto`)

| value | what | needs |
|---|---|---|
| `gpt2` | **Best quality** — block coder over GPT-2; natural sentences | `torch`, `transformers` |
| `markov` | **Good quality, no GPU** — block coder over a trigram model trained on public-domain prose; flowing, locally-coherent sentences | internet (fetches corpora once) |
| `wordmap` | Byte→word placeholder; word-like salad, but zero deps | nothing (stdlib) |
| `auto` | Try `gpt2` → `markov` → `wordmap`, each with a round-trip **self-test**; use the first that verifies | — |

`CODEC_ORDER` (default 3) = markov n-gram order. Lower `CODEC_K` (e.g. 2) = more natural / longer cover text.
All three backends share the identical `/encode`·`/decode` contract, so the extension never changes.

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

## Deploy on fly.io (persistent GPT-2 codec, stable HTTPS URL)

Hosts the deterministic GPT-2 backend externally so both extensions share one model — and gives a
stable `https://<app>.fly.dev` URL (no cloudflared tunnel). The extension is unchanged; just point its
Codec URL at the fly URL.

```bash
cd codec
fly launch --no-deploy      # pick a unique app name + region (keeps this fly.toml)
fly deploy                  # builds the image (CPU torch + gpt2 baked in) — a few minutes
fly status                  # → https://<app>.fly.dev
curl https://<app>.fly.dev/health     # {"model":"gpt2/k3","ready":true}
```

Then set **Codec URL = `https://<app>.fly.dev`** in each extension popup. Notes:
- Boot loads torch + gpt2 + a round-trip self-test (~30–60s); the health-check `grace_period` covers it.
- `min_machines_running = 1` keeps it warm (cold start reloads the model). ~2 GB VM, CPU only.
- Tune quality/length live via `fly.toml` `[env]` (`CODEC_K`, `CODEC_BACKEND`) then `fly deploy`.
- The crypto stays in the extension — fly only ever sees ciphertext (invariant §4).

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
