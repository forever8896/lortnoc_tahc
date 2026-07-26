# CLAUDE.md — the authoritative build spec for lortnoc_tahc

This file is the **single source of truth** for what we build and how the pieces fit — the complete plan,
architecture, and per-integration spec. There is no separate design doc; read this fully before touching code, and
update it in the same change as any code that alters an interface, schema, or flow below.

**Product surfaces & domains**

| Surface | Where | What it is |
|---|---|---|
| **Landing** | `lortnoctahc.com` | Marketing + the pitch; funnels installs. |
| **App (PWA)** | `app.lortnoctahc.com` | The real product: Sui/Seal P2P messenger, Mirror + Native modes. Mobile-native PWA. |
| **Extension** | "Lortnoc tahc" (Chrome) | The Telegram Web overlay + the funnel into the app. |

---

## 1. What this is

**lortnoc_tahc** ("chat control" backwards) is a privacy / stealth-messaging system for **ETHGlobal Lisbon 2026**.
You type a real message in Telegram; before it sends, our overlay swaps it for innocuous **cover text**
(conversation steganography). That cover text is all Telegram stores. Your correspondent — same overlay, same
shared key — sees it **decode back inline**. Everyone else sees harmless chatter. The endgame migrates users onto
a decentralized, encrypted messenger we own. **Telegram is the on-ramp; the decentralized stack is the destination.**

**Positioning — enforce in all copy, UI, and demos:** a *privacy / stealth-comms* product. The language model that
generates cover text is invisible plumbing — **never the pitch. We are not "an AI project."**

## 2. Status

Pre-code. Repo holds this spec + `site-font.zip` (brand assets). No build system, scaffold, or git history yet.
When you scaffold, record the toolchain in §11.

---

## 3. Architecture — four layers, one identity

```
┌──────────────────────────────────────────────────────────────────────┐
│  Telegram Web + browser-extension overlay          ← THE HERO DEMO     │
│  intercept send: real→cover · MutationObserver inbound: cover→real     │
│  AES-SIV encrypt/decrypt client-side · holds only the derived key      │
└───────────────┬───────────────────────────────────▲───────────────────┘
   ciphertext   │                                     │  ciphertext
                ▼ (never plaintext, never the key)     │
┌──────────────────────────────────────────────────────────────────────┐
│  CODEC SERVICE — stego LLM inference on 0G Private Computer (sealed)   │
│  encode: ciphertext→cover text (arithmetic coding+LLM) · decode: rev.  │
└──────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────┐
│  DECENTRALIZED STORE — Sui + Walrus + Seal      ← "your data, portable" │
│  Seal-encrypted, Quilt-batched blobs · Sui object = conversation head  │
└──────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────┐
│  IDENTITY / ACCESS — ENS v2  <name>.lortnoctahc.eth ← handles + stealth │
│  custom subname registry gated on a zk nullifier · per-record roles    │
│  text records: pubkey + Walrus/inbox ptrs · stealth meta-addr (5564)   │
└──────────────────────────────────────────────────────────────────────┘
```

**Three surfaces, one key set** — not three products:

| Surface | Role | Codec? |
|---|---|---|
| **Telegram Web overlay** | Hook / hero demo — messages hidden in real Telegram chats | **Yes** (encode+decode) |
| **Web app — Mirror mode** | Telegram-carried threads, decoded & synced from Walrus | **Yes** (decode) |
| **Web app — Native mode** | Own P2P messenger; the conversion endgame | **No** — direct ENS-resolved DM |

The "conversion moment" is a toggle between Mirror and Native — the vampire attack made literal.

---

## 4. Non-negotiable invariants

Break any and the product stops being what it claims. Hard constraints in review.

- **Never host or transmit plaintext.** Everything is encrypted at rest under the user's key (Seal / AES-SIV),
  decrypted client-side only. The codec and Walrus see only ciphertext.
- **No userbot, no MTProto, no held Telegram session credential.** The user is a human typing in their own Telegram;
  the overlay only reads/writes the DOM. This removes ToS/ban risk — never reintroduce a bot.
- **Payment stays unlinkable to handle/usage.** Access is a bearer capability (zk nullifier), never an on-chain
  "this wallet has access" ACL entry. §8 states the exact guarantee and its limits.
- **Identity wallet ≠ payment wallet.** The wallet that signs to derive `MS` (§5.1) must never be the wallet that
  pays for membership — same wallet doing both re-links payment→identity (§8 fee-payer leak). Enforce in UX.
- **Cover text stays plain.** No markdown, emoji, smart quotes, or edge whitespace — Telegram must not normalize it,
  or byte-exact decoding breaks.
- **Codec determinism.** Reversibility requires a byte-identical model + deterministic inference on both ends;
  centralizing on one shared **local, deterministic** model behind the service (batch=1, pinned kernels,
  greedy/`temp=0`) guarantees it. Never split the model across ends. **Never route codec inference through
  non-deterministic hosted GPU inference (incl. 0G) — it breaks reversibility even at `temp=0` (§6.3).**
- **Honesty in the pitch.** Claim unlinkability, not invisibility (§8).

---

## 5. Cross-cutting primitives (shared by every integration)

### 5.1 Key derivation

One **master secret** `MS` (**wallet-signature-derived by default**, passphrase-derived as fallback) is the only
thing a user backs up. Everything else is derived deterministically with **HKDF-SHA256**; raw sub-keys never leave
the device.

| Derived key | HKDF `info` label | Type | Used by |
|---|---|---|---|
| `K_msg` | `lortnoc/msg/x25519/v1` | X25519 keypair | messaging pubkey (→ ENS text record); native DM; conv-key ECDH |
| `K_own` | `lortnoc/evm/secp256k1/v1` | secp256k1 keypair | **owns the handle.** Derived, so it is never the wallet that paid (§4) — the payment on 0G and the handle on Sepolia have no on-chain link, because the only connection lives inside `MS` |
| `K_sui` | `lortnoc/sui/ed25519/v1` | Ed25519 keypair | Sui storage account (pays WAL for Walrus blobs) |
| `K_conv(c)` | `lortnoc/conv/aes-siv/v1` + conv-id | AES-SIV (RFC 5297) key | Telegram stego payload encrypt/decrypt |
| `id_sem` | `lortnoc/semaphore/v1` | Semaphore identity secret | anonymous "I paid" proof + nullifier |
| `id_seal` | `lortnoc/seal/v1` | Seal decryption identity | Walrus-blob decryption |

**Default — wallet signature.** Connect a wallet, sign one fixed domain-separated message (e.g.
`"lortnoc.eth identity v1"`) → `MS = HKDF(signature)`. Standard ECDSA signing is deterministic (RFC 6979), so the
same wallet + message reproduces the same `MS` on any device — nothing to memorize, nothing weak to brute-force. The
signature never leaves the device; the wallet is a local secret source only, and *which* wallet signed is never
revealed.

**Fallback — passphrase.** For signers that can't derive deterministically — **some smart-contract / MPC wallets and
all passkeys/WebAuthn do NOT produce a stable, reproducible signature** — fall back to a passphrase run through a
memory-hard KDF (Argon2id) before HKDF. Fallback, not the normie default.

**Invariant — identity wallet ≠ payment wallet (§4). IMPLEMENTED, not just stated.** The connected wallet pays;
`K_own` (derived from `MS`) owns the handle. One signature, two addresses, no on-chain link — and no second wallet
for the user to manage, because the same signature reproduces `K_own` on any device. The relayer sends it a small
Sepolia gas stipend on claim so it can manage its own records without ever being funded from the payer.
The wallet you *sign identity with* must not be the wallet
you *pay membership with*, or you hand observers the §8 fee-payer re-linking leak. The identity signature stays local
and reveals nothing; the payment tx is public. Keep them separate in the UX. Losing the identity wallet = losing the
identity → this is exactly where custody-free social recovery (§6.5) earns its place.

### 5.2 Identity & handles

- Handle = `<name>.lortnoctahc.eth`, issued by our `LortnocRegistry` under `lortnoctahc.eth` (§6.5).
  `lortnoc.eth` is registered to the same owner and deliberately left unused: it is what makes the
  `eth.lortnoc.*` record namespace below a name we control rather than a borrowed prefix.
- **Discoverability is a dial, not a switch** — a five-rung ladder (Ghost → Unlisted → Findable-if-you-know-me →
  Searchable → Public), enforced at resolve-time per-record and per-caller. Full model in §6.5 "Discoverability
  model." The reverse-resolution axis (set = linkable / unset = stealth) is just the top vs. middle of that ladder.
  At every rung payment is unlinkable and content encrypted.
- "Login" to any surface = present `MS`, re-derive keys, resolve your own handle → find + decrypt your data.

### 5.3 Key exchange — how two people share the AES-SIV key

**Core principle: the symmetric key is never transmitted — it is *derived*.** Nobody sends a secret anywhere. Each
party publishes an X25519 **public** key; the shared key falls out of ECDH (`shared = ECDH(my priv, their pub)`,
identical on both ends by symmetry) → `K_conv(c) = HKDF(shared, "lortnoc/conv/aes-siv/v1" + convId)`. So the only
question is *where the public key lives and how the peer discovers it.* Three tiers, in order of strength:

- **Tier 1 — Bootstrap (free, no handle yet): in-band handshake *through Telegram itself*.** The extension controls
  both DOM paths, so the first exchange in a stego-enabled chat is automatic: Alice's extension encodes her
  ephemeral pubkey **as cover text** and sends it; Bob's extension recognizes the handshake frame (payload header
  byte: `0x01` offer / `0x02` ack / `0x10` message) and replies with his pubkey as cover text; both derive
  `K_conv`. To Telegram and non-users it's plain chatter. No server, no wallet, no gas. **TOFU** — no active-MITM
  protection on that first exchange; acceptable for the free tier, closed by Tier 2.
- **Tier 2 — Persistent (paid, has a handle): the ENS v2 text record *is* the key directory.** Once Bob claims
  `bob.lortnoctahc.eth`, his `eth.lortnoc.pubkey` record (resolved gaslessly offchain, §6.5) gives Alice an
  **authenticated** key tied to a name he provably controls → ECDH. Durable, cross-device, offline-friendly, and
  **MITM-closed**. This is the same discovery path native mode uses (§6.6) — one mechanism for both surfaces.
- **Tier 3 — temporary on-chain key drop: considered and rejected for the core loop.** Dropping an ephemeral pubkey
  in a Sui object / Walrus blob still needs a shared rendezvous ID (the Telegram chat already is one), writes
  "these two are connecting" metadata on-chain (privacy regression), and needs gas (kills the frictionless free
  tier). The in-band handshake beats it on every axis. Do **not** build a separate temporary on-chain key store.

Forward secrecy: a static per-conversation ECDH key is fine for Lisbon; Signal-style ratcheting is a
real-product stretch, not a hackathon item.

### 5.4 Canonical schemas

```
Message (plaintext form — exists ONLY client-side, never stored/transmitted in the clear)
  { v:1, from:<handle>, to:<handle>, ts:<unixMs>, body:<string> }

Stored form (in Walrus): Seal.encrypt(Quilt.batch([Message, …]))  → blob

ConversationHead (Sui object — the mutable pointer)
  { id, participants:[handle], headBlobId:<walrusId>, seq:<u64>, updatedAt:<u64> }

Manifest (Walrus blob; indexed by the eth.lortnoc.walrus text record)
  { v:1, conversations:[{ convId, headObjectId:<suiId>, peer:<handle> }] }

ENS text records (per §6.5)
  eth.lortnoc.pubkey       = <hex X25519 pub>      // messaging identity; resolves for everyone
  eth.lortnoc.walrus       = <walrus manifest blobId>
  eth.lortnoc.inbox        = <relay topic / inbox pointer>
  eth.lortnoc.stealth      = <ERC-5564 stealth meta-address>   // receive-money-at-a-fresh-address
  eth.lortnoc.discoverable = <ghost|unlisted|known|searchable|public>  // findability rung (§6.5); write-delegable to indexer
  eth.lortnoc.findhash     = <salted hash(identifier)>  // "findable-if-you-know-me"; gateway-gated read
  eth.lortnoc.knock        = <{prompt, salt, kdf}>   // challenge-gate for contact (§6.8); answer NEVER published
  eth.lortnoc.inbox        // write-delegable to sync gateway via authorizeTextRoles (per-record role, §6.5)
```

### 5.5 Sign-in & access (there is no server-side account)

"Signing in" never authenticates you against a server — it re-derives the keys that unlock data only you can
unlock. Same secret on any device ⇒ same account; someone else opening the same URL sees only ciphertext.

1. Open the app/extension → **connect wallet & sign** (default) or **enter passphrase** (fallback) → device unlock
   of the local encrypted keystore.
2. Wallet signature (or Argon2id over the passphrase) → `MS` → HKDF → all keys (§5.1), including the messaging keypair.
3. Find your handle: locally cached, or via ENS reverse resolution for a discoverable handle.
4. Resolve your handle → `eth.lortnoc.walrus` → your conversation `Manifest` → the list of `ConversationHead`s.
5. Pull each Walrus blob → `Seal.decrypt` with `id_seal` → render.

**Three independent gates — keep them distinct:**
- **Discovery** — `handle → pubkey + Walrus pointer` is **public** (that's how people reach you). It exposes a
  *messaging* public key and *where* your encrypted vault sits — never a private key, never plaintext.
- **Entitlement** — *using* the service (codec, relay, storage) is gated by the anonymous zk-membership proof (§7),
  not by the handle. Resolving a handle lets someone *send* to you; it never lets them *read* you.
- **Decryption** — reading your own history is answered entirely by keys you hold, and is **always free** (§7).

---

## 6. Integration specifications

Each spec: **Purpose · Interface · Data · Flow · Scope/failure.** IN = required for the Lisbon submission.

### 6.1 Telegram Web overlay — **IN (hero)**

- **Purpose.** Turn real messages into cover text on send and back on receive, inside the user's own Telegram Web
  session. The demo that wins the room.
- **Interface.** MV3 Chrome extension, content script on `https://web.telegram.org/*`. No background account access,
  no bot token. Per-chat toggle: "stego on/off." Compose interception hooks the send path (Enter keydown + send
  button). Inbound uses a `MutationObserver` on the message-list container.
- **Data.** Reads raw compose text and raw inbound bubble text (pre-render, to dodge autocorrect/emoji mangling).
  Cover payload = `AES-SIV.encrypt(K_conv(c), realText)` → `POST /encode` → cover text.
  **⚠️ Crypto reconciliation (CF-5).** `nethical6` already does AES-SIV + PBKDF2 **internally** with its own key
  model. Wrapping the CLI as-is uses *its* crypto, not our HKDF-derived `K_conv` (§5.1). Resolve by either (a)
  stripping `nethical6` to the bare arithmetic coder and doing our own AES-SIV over `K_conv`, or (b) feeding
  `K_conv` into its crypto path. This is integration work, not a thin wrap.
- **Flow.**
  - *Outbound:* read compose → `AES-SIV.encrypt` → `/encode` → replace compose contents with cover text →
    play the "shuffle" animation → let Telegram send. Plaintext never leaves the page.
  - *Inbound (stego-enabled chats):* each new bubble → `/decode` → `AES-SIV.decrypt`; **the AES-SIV auth tag is the
    stego detector** — valid tag ⇒ render decoded text inline; invalid ⇒ leave the bubble as normal chatter.
    **⚠️ Inbound cost.** Detection-by-full-decode runs a full arithmetic-decode + AES-SIV verify on *every* bubble,
    each a local model call — real latency the outbound "shuffle" animation does NOT cover. Gate hard by the per-chat
    toggle; accept a few seconds/message in the demo (keep demo threads short).
- **Scope/failure.** Constrain cover text to plain words (invariant §4). If Telegram normalizes it, decoding fails
  closed (shows cover text, never a crash). Decode is LLM-cost-gated by the per-chat toggle, not attempted globally.

### 6.2 Codec service — **IN**

- **Purpose.** Deterministic, reversible steganographic codec. The only component that turns bytes into natural
  language and back. Sees ciphertext only — never plaintext, never a key.
- **Interface.** Stateless HTTP; one pinned model; deterministic inference.
  ```
  POST /encode  { ciphertext: base64 }            → { coverText: string }
  POST /decode  { coverText: string }             → { ciphertext: base64 }
  GET  /health                                    → { model, digest, ready }
  ```
- **Data.** Arithmetic coding over the model's per-token distribution. Encode and decode MUST use byte-identical
  model weights + deterministic sampling, or reversibility breaks.
- **Flow — LOCKED: local HuggingFace GPT-2 service.** Run **GPT-2-small via `transformers` (PyTorch, CPU)** as the
  pinned model behind this HTTP service. Running our *own* model locally is precisely what gives us the two things
  reversible stego needs and 0G cannot provide: **full-vocabulary token logprobs** (it's our model — we read the
  logits directly) and **byte-deterministic inference** (CPU, greedy/`temp=0`). Keep the model **warm as a persistent
  process**; **host ONE instance both ends call** so encode and decode hit the same process (determinism automatic,
  no cross-machine matching). The extension does AES-SIV client-side; the service sees **ciphertext only** (§4).
- **Build path.** Either (a) a minimal arithmetic-coding coder over GPT-2 `transformers` logits (most control,
  full logprobs for free), or (b) wrap `nethical6/conversation-steganography` (does AES-SIV + arithmetic coding
  already, but a PoC — see CF-4/CF-5). Start with (a) if the coder is quick; keep (b) as fallback. **First milestone:
  `decode(encode(x)) == x` for 100 random payloads, deterministic across process restarts.**
- **0G note (settled).** We asked the 0G team about deploying our *own* model/container into their compute/TEE (to
  run the codec on 0G with our own logprobs+determinism) — **they confirmed it is not supported / too complex on
  their end.** So the codec is **definitively local**; 0G's role is §6.3 (membership + optional non-codec assist).
- **Scope/failure.** Codec is on the hero-demo critical path — build a scripted/pre-recorded fallback round-trip.
  Latency ~1–3s/message, covered by the shuffle animation (outbound only; see §6.1 for inbound cost).
  `/health.digest` pins the model so both ends can assert they agree.

### 6.3 0G — **IN** (reframed: membership + sealed-inference assist, NOT the codec)

- **⚠️ Correction (CF-1) — SETTLED, three ways.** The codec's inference **cannot** run on 0G. (1) 0G's
  OpenAI-compatible API does **not** expose full-vocab token distributions (docs omit `logprobs`; even passed through,
  OpenAI caps at top-20 — verified in the `0g-compute-ts-sdk` source, which only reads `usage` back); (2) hosted GPU
  inference is **non-deterministic** (shared batched MoE fleet, no `seed`), so encode/decode distributions won't match
  even at `temp=0` — the TEE signs the response *text*, not reproducibility; (3) **deploying our OWN model/container
  into 0G's compute/TEE — which WOULD give us logprobs+determinism — was raised with the 0G team, who confirmed it is
  not supported / too complex on their side.** All three paths are closed. **The codec is definitively local (§6.2).**
- **Purpose (reframed).** Satisfy the 0G prize with the two things it actually requires — a deployed contract + proof
  of sealed inference — via genuinely useful, *non-codec* work. Frame: *anonymous membership settled on 0G + sealed
  inference assist.*
- **Interface.** (a) **0G Chain (Galileo testnet, chain 16602, EVM):** deploy the Semaphore membership/verifier
  contract (§7) — the required "contract address." (b) **Sealed inference** via `router-api.0g.ai/v1`
  (OpenAI-compatible) or the `@0gfoundation/0g-compute-ts-sdk` for a real non-codec task: e.g. generate the
  conversation "priming"/cover-topic seed, a "does this cover text read naturally?" classifier, or the native-mode
  agent.
- **Flow.** **Hour-1 probe (informational only):** hit `router-api.0g.ai/v1` with `logprobs:true` and send the same
  request twice to confirm CF-1 empirically — but do **not** architect on a yes. Deploy membership/verifier on
  Galileo; capture one attested sealed-inference response for the video.
- **Scope/failure.** Prize needs: contract address(es) + **proof of 0G Compute/Private Computer inference** + public
  repo + a **<3-min** demo video. Faucet is **0.1 0G/day** — redeem early. Use **Galileo (16602)**, not deprecated
  Newton (16600).

### 6.4 Sui + Walrus + Seal — **IN** (core store; 0G Storage evaluated & deferred)

- **Purpose.** The encrypted vault the user owns and can walk away with. Storage/access-control is central to the
  demo, not a bolt-on.
- **Decision — kept Walrus+Seal over 0G Storage (2026-07).** 0G Storage was evaluated as an EVM-native alternative
  (would collapse storage onto our ENS/0G/Semaphore EVM spine). **Deferred** because: (1) 0G has **no Seal
  equivalent** — no threshold encryption / on-chain access policy, which is our differentiator (`seal_approve`, the
  anonymity bridge below); (2) Walrus has the stronger, more battle-tested durability story (RedStuff, self-healing)
  for the "your data, portable & durable" pitch; (3) 0G has no Quilt-style small-object batching. **Condition of
  keeping Seal:** ship a real `seal_approve` *policy* (session-key fallback, or nullifier-in-policy) — do NOT use
  Seal as a plain encrypt-lib, or the Sui/Move/WAL overhead buys nothing our derived keys don't already give.
  0G Storage lives on only as a **benchmark/justification artifact** (§11), not a second backend.
- **Interface.** Walrus TS SDK + Upload Relay (no public mainnet publisher; testnet faucet via Sui Discord). Seal
  for threshold encryption + on-chain access policy. A Move module for the `ConversationHead` object.
- **Data.** Messages → `Quilt.batch` (≈100–420× cheaper for chat-sized blobs) → `Seal.encrypt` → Walrus blob
  (immutable). `ConversationHead` Sui object (mutable) points at the current head blob. `Manifest` blob indexes a
  user's conversations, referenced by their `eth.lortnoc.walrus` text record (§5.4).
- **Flow.** Write: append message → re-batch/encrypt → new Walrus blob → update `ConversationHead.headBlobId` +
  `seq`. Read: resolve handle → manifest → heads → blobs → `Seal.decrypt` with `id_seal`. **Walrus is the durable
  log, not a per-message bus.** *(Realtime "hot path (relay/libp2p)" is unbuilt roadmap — poll for the demo, §6.6.)*
  **SDKs:** `@mysten/walrus` (`writeBlob`/`readBlob`; Mysten runs public testnet upload relays — no need to host),
  `@mysten/seal`. Get WAL by swapping testnet SUI→WAL at `stake.walrus.site`.
- **⚠️ Mainnet cost model — VALIDATED 2026-07-25 (Quilt is not an optimization, it is the design).** Numbers below
  are from live mainnet state, not docs prose: prices read off the Walrus system object
  `0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2` (storage `71042` FROST/MiB/epoch, write
  `129165` FROST/MiB), encoded size computed with a port of `redstuff::encoded_blob_length`, Sui gas measured from
  real mainnet `register_blob`/`certify_blob` txs. **Do not hardcode these — they are node-voted and dynamic.**
  - **The floor.** Walrus bills the *encoded* size: `n_shards × (slivers + metadata)`, metadata = `1000×32×2+32` =
    64,032 B **per shard, independent of blob size**. So **every blob ≤ ~217 KB bills identically at 63 storage
    units** (66,034,000 B encoded). A 300 B message expands **220,113×**. A 1 MB blob is only 67 units.
  - **Therefore one-blob-per-message is a pricing catastrophe**, and Quilt (≤660 items/blob) is load-bearing:

    | 1-year retention | 10 msg/day | 50 msg/day | 200 msg/day |
    |---|---|---|---|
    | blob-per-message | $15.82 | $79.09 | $316.35 |
    | Quilt (660/blob) | **$0.03** | **$0.12** | **$0.48** |
    | blob-per-message @ advertised peg | $71.98 | $359.92 | $1,439.66 |

    ~650×. Assumes WAL $0.033 / SUI $0.76 / 300 B message — both tokens volatile (WAL ATL $0.02842 on 2026-07-20).
  - **⚠️ Spec-vs-code gap.** The "Data" bullet above specifies `Quilt.batch`; `app/src/lib/live/sui.ts` does **one
    `writeBlob` per message**. That is the unbatched row. Fixing it is the single highest-leverage cost change.
  - **Sui gas is not a rounding error at this granularity.** Per unbatched message: $0.000225 computation +
    **$0.0038 refundable** Sui storage deposit, vs only $0.000712 of WAL. The deposit returns 99% **only if blob
    objects are burned**; otherwise it is working capital locked (~$3,800 per million messages). Quilt collapses
    the tx count too, so it fixes gas and WAL together.
  - **⚠️ `epochs: 3` means SIX WEEKS on mainnet, then the data is gone.** Mainnet epoch = 2 weeks; testnet = 1 day,
    so the current setting reads as 3 days in testing and the expiry is invisible. Max purchasable = 53 epochs
    (~2 years). "The vault you can walk away with" requires **renewal**, so storage cost is **recurring**, not
    one-time — price it per-year (§12 Q9).
  - **⚠️ Storage is USD-pegged by node vote, and the vote currently sits 4.7× BELOW the advertised $0.023/GB/month**
    (implied WAL ≈ $0.156 vs market ≈ $0.033). **Budget the peg, not today's chain price** — that is the third row.
  - **⚠️ Seal has no free tier on mainnet — an unpriced dependency.** Every mainnet key server is commercial
    ("contact the provider": Ruby Nodes, NodeInfra, Overclock, Studio Mirai, H2O, Triton, Natsai), and the
    decentralized 5-of-8 committee (`0x686098f1…a7595`) **requires an Enoki API key** (`X-API-Key`). No operator
    publishes prices. Open-mode servers are **testnet-only** and carry no availability or key-persistence guarantee.
    Billing is **per key request**, so it scales with the same per-message count Quilt exists to collapse — get a
    real quote before promising a price.
  - **⚠️ `ConversationHead.blobs` is an unbounded `vector<String>`** — at Sui's 256,000 B object cap and ~45 B per
    blobId, `append` starts reverting at **~5,700 messages/conversation**, and every read pulls every blob. Quilt
    plus a rolling/segmented head fixes both.
- **Scope/failure.** **Seal-vs-anonymity bridge — VERIFIED SUPPORTED.** `seal_approve` runs arbitrary Move via
  `dry_run` (owner/time-lock/allowlist/token-gate patterns exist), so a non-address / nullifier policy is real, not a
  fantasy. **For the weekend, LEAD WITH THE FALLBACK** — gateway issues a short-lived Seal session key on a valid
  zk-proof (easy). The clean version (nullifier checked *inside* `seal_approve`) is the hard bit: **verify the proof
  at nullifier-registration time and have `seal_approve` do a cheap set-membership check** against a shared
  nullifier-registry object — never verify a ZK proof inside `seal_approve` itself.

### 6.5 ENS v2 — **IN** (the creative core; full spec)

**Why v2.** The features below are impossible in ENS v1, and that impossibility *is* the "Most Creative Use" story.
**Decision: full on-chain v2 identity layer** — per-user Permissioned Resolver + per-record EAC roles are the
load-bearing creative use. This **supersedes the earlier "v2 = narrative only, demo on v1" framing** (audit CF-2,
now reversed).

> **Deployment reality (verified 2026-07 against source).** ENS v2 is **deployed, permissionless, and callable on
> Sepolia today** — repo **`ensdomains/contracts-v2`**, deployment snapshot tag **`sepolia-deployment-2026-06-29`**
> (chainId 11155111). Namechain L2 was cancelled (2026-02-06); v2 targets Ethereum L1, Sepolia is the testnet.
> **PIN the addresses + tag; do NOT `git pull main` mid-hack** (repo changes daily, addresses rotate ~monthly);
> `eth_getCode`-check each before building. See the [[ens-v2-mainnet-no-namechain]] memory.
>
> **Live Sepolia addresses** (verify before use): `PermissionedResolverImpl`
> `0x7e4b2d59938930168024201752ee5503df402303` · `VerifiableFactory`
> `0x118bc31a50d559f7015a8da26d54b3b030cdb70f` · `ETHRegistry` `0x67b728a792e789a8978b30cf1b3b641f19354b43` ·
> `ETHRegistrar` `0xa4449a0dd2b83007553d9b1d28b583a46a805a30` · `UniversalResolverV2`
> `0x85edf8b6b7d4211e2b07aa687506b746357b92cf` · `UserRegistryImpl` `0x840fa461059862ea466a711e8c98c8de732061c0`.
>
> **Two gotchas:** (1) on the resolver, `grantRoles`/`revokeRoles` **revert** (`grantRoles` is literally `pure`) —
> use the `authorize*Roles` wrappers. (2) `.eth` registration is priced in an **ERC-20 (MockUSDC/DAI), not ETH**,
> behind a **commit→wait→reveal** delay (60s min / 24h max) — applies to registering our own names (day-0, once),
> not to our subname issuance. MockUSDC (`0xd3322b29a7bdee707d1684676f149bf41aa3422f`) has an **open `mint()`**, so
> there is no faucet to chase; a 1-year name costs ~8.000021 USDC.
>
> Source of truth = `github.com/ensdomains/contracts-v2` (`.../resolver/`,
> `.../access-control/EnhancedAccessControl.sol`, `.../registry/`, `contracts/deployments/sepolia/`) +
> `github.com/ensdomains/verifiable-factory`.

> **WHAT WE DEPLOYED — LIVE ON SEPOLIA (2026-07-25).** Addresses live in
> `app/src/lib/live/ens-deployment.json`, the single source of truth shared by the app and the CLI
> (`scripts/ens/`); nothing is hardcoded twice. Runbook: `app/docs/LIVE-SETUP.md`.
>
> | Ours | Sepolia address |
> |---|---|
> | `LortnocRegistry` (UserRegistry proxy) | `0x2D95c86bd9a850d95897c604c8EB00131a9C62a5` |
> | `LortnocRegistrar` | `0x794ec3b1fb8ad0d23f3f654c20993ba4ff762c19` |
> | owner / deployer | `0x61eE2fBcf2841d9094e2D42406Dd4f83a7981Bb8` |
>
> First handle: **`lortnoc.lortnoctahc.eth`**, resolver `0x764FeD7390354FBf2Ec27a7471ef20f9c1a9CF83`
> (factory-verified). Both names expire 2027-07-25. The whole setup cost 0.0029 Sepolia ETH.
>
> - **`lortnoctahc.eth`** — our name in the v2 `ETHRegistry`; handles are `<label>.lortnoctahc.eth`.
> - **`lortnoc.eth`** — registered to the same owner, deliberately unused: it makes the `eth.lortnoc.*` record
>   namespace (§5.4) a name we control rather than a borrowed prefix.
> - **`LortnocRegistry`** — a `UserRegistry` proxy from the canonical `VerifiableFactory`, slotted under
>   `lortnoctahc.eth` via `setSubregistry`. Full ENS resolution traverses it: RootRegistry → `eth` → `lortnoctahc`
>   → LortnocRegistry → handle → that handle's own resolver.
> - **`LortnocRegistrar`** (`contracts/src/LortnocRegistrar.sol`) — holds `ROLE_REGISTRAR` and nothing else, so
>   **any wallet can claim permissionlessly**. `claim()` is ONE transaction that: deploys the caller's own
>   `PermissionedResolver` proxy via the factory → writes `eth.lortnoc.pubkey` → grants the caller every root role
>   on it → **revokes its own** → registers the subname pointing at it. The registrar is admin for exactly one
>   transaction and holds no authority over the handle afterwards. `claimFor` keeps the relayed-claim path
>   (payer ≠ claimer, §8 Layer 1); an optional `gate` swaps the free tier for nullifier-gated issuance (§7).

> **0G MEMBERSHIP — LIVE ON MAINNET (16661), 2026-07-25.** `LortnocMembership`
> `0xe9031484b6fd4f55bf94dc5b768f7031b04be3d6` · `Semaphore` `0xd21f911570aad19d39e750fe0aa4e2ad161cbdd5` ·
> `SemaphoreVerifier` `0x87997f3ca40693fb1e0c3c6f39f0f3fe287b8c67` · `PoseidonT3`
> `0x114e261b9d901aaea199544539c9873dc93565ef`. Price 5.666942 0G = **$1.00**, repeggable via `setPrice`.
> Onboarding = **bridge (LI.FI `gasZipBridge`, ~20s, $0.13 gas) → pay**, both measured on mainnet.
> Fees forward to the treasury on every `join()`; the contract never holds a balance.
> **Treasury is still the hot deploy key — move it before collecting at scale.**
>
> **0G MEMBERSHIP — ALSO ON GALILEO (16602) for testing.** Addresses in
> `app/src/lib/live/zerog-deployment.json`. bn254 precompiles (0x06/0x07/0x08) verified present before building.
>
> | Contract | Galileo address |
> |---|---|
> | `PoseidonT3` (library Semaphore links against) | `0xb4022aa3f39504985d3bfe07b625e0d230afa1e3` |
> | `SemaphoreVerifier` (canonical, verbatim) | `0xafaca9c12b67909ba87e4f073601361f30a9d628` |
> | `Semaphore` (canonical, Poseidon-linked) | `0x794ec3b1fb8ad0d23f3f654c20993ba4ff762c19` |
> | `LortnocMembership` (ours) | `0x219f68fdbfeda4576939de3f75c4e362ed00e11e` (group 0) |
>
> **Gotchas that cost time:** Semaphore's bytecode ships an *unlinked* `__$…$__` PoseidonT3 placeholder —
> deploy the library and link before deploying. 0G's `eth_estimateGas` rejects viem's 1559 fields + nonce, so
> price legacy and pass explicit gas. Poseidon needs ~9.6M gas (16.5 KB of code deposit). Receipt propagation
> lags — wait patiently or you will think a landed tx failed.

**v2 primitives we rely on** *(real, deployed on Sepolia — role constants below are concrete in source, not guesses)*
- **Hierarchical registries** — `IRegistry`: `getSubregistry(label)` / `getResolver(label)` / `getParent()`. A
  custom registry may implement `IRegistry` with an **entirely different ownership/access model** — the hook below.
- **Enhanced Access Control (EAC)** — 32 regular + 32 admin roles, ≤15 holders/role; `ROOT_RESOURCE = 0` OR'd into
  every check. Concrete role constants (`PermissionedResolverLib.sol`): `ROLE_SET_TEXT=1<<4`, `ROLE_SET_ADDR=1<<0`,
  `ROLE_SET_PUBKEY=1<<12`, `ROLE_SET_ALIAS=1<<28` (root-only), `ROLE_CLEAR=1<<32`; **admin(role)=role<<128**.
  Per-record resource = `keccak256(abi.encode(node, part))`, `part = keccak256(key)`.
- **Permissioned Resolver** — each account gets its own **VerifiableFactory UUPS proxy** of `PermissionedResolverImpl`
  with **per-record write roles** + **record aliasing**. Delegate with `authorizeTextRoles(bytes toName, string key,
  address account, bool grant)` (scope to ONE text key), `authorizeAddrRoles(bytes toName, uint256 coinType, address,
  bool grant)`, `setAlias(bytes fromName, bytes toName)` (DNS-encoded; root-only), `clearRecords(bytes32 node)`.
  **⚠️ Use `authorize*Roles`, NOT `grantRoles` (which reverts on the resolver).** Roles gate **writes only** — reads
  are world-readable (read-gating stays offchain).
- **Verifiable Factory** — `deployProxy(address impl, uint256 salt, bytes data)` (CREATE2; `outerSalt =
  keccak256(msg.sender, salt)`), `verifyContract(address proxy) → address implementation` (**one arg** — returns the
  impl; compare to `PermissionedResolverImpl` off-chain). Proves a proxy is genuinely factory-deployed.
- **Universal Resolver V2** — `resolve(name, data)`, `resolveWithGateways(name, data, gateways)` (CCIP-Read /
  gasless offchain), `reverse(addr, coinType)` (ENSIP-19). Aliasing is applied during `resolve()`.
- **Mutable Token IDs** — `tokenVersionId`/`eacVersionId`; role changes emit `TokenRegenerated(old,new)` and
  invalidate stale approvals. Store labelhashes, not token IDs.

**The creative uses we ship (ranked)**
1. **Per-record write delegation — the flagship, load-bearing.** Each handle gets its own **Permissioned Resolver
   proxy** (user = admin). `authorizeTextRoles(name, "eth.lortnoc.inbox", gateway, true)` lets the sync gateway
   rotate ONLY the inbox pointer — never `pubkey`, `walrus`, or `stealth` — and the user **revokes in one tx**
   (`grant=false`). Least-privilege self-sovereignty as a *live, on-chain* property. This is the ENS-booth headline:
   *"the gateway can rotate my inbox and nothing else, revocable instantly."*
2. **Configurable discoverability + challenge-gated contact ("knock").** Two axes the user configures: *findability*
   (ghost→public ladder) and *reachability* (open / knows-identifier / **answers-your-trivia/password** / mutual).
   The knock (§6.8) is the coolest: nobody can even notify you without clearing a gate you set. `knock`/`discoverable`
   are text records ⇒ governed by the Permissioned Resolver; verification is client-side/offchain (a read concern).
3. **`lortnoctahc.eth` gated on a zk nullifier — "subname = bearer capability."** On-chain `LortnocRegistry`
   (a `UserRegistryImpl` proxy) under `lortnoctahc.eth`; issuance checks *"valid, unspent
   Semaphore nullifier?"* not *"did this wallet pay?"*. Claim tx **relayed** (payer ≠ claimer) ⇒ payment↔handle stays
   ZK-unlinkable. Trades §8 Layer 0 (zero footprint) for real on-chain v2; unlinkability retained (§8 Layers 1/2/4).
4. **`verifyContract(proxy)` = trustless handle proof.** A counterparty proves a resolver proxy came from the
   canonical `VerifiableFactory` (returns the impl; compare to `PermissionedResolverImpl` off-chain), no trust in our
   backend. Deterministic CREATE2 ⇒ predict a handle's resolver address before deployment.
4. **Record aliasing = one-tap conversion + trial→permanent.** `setAlias(fromName, toName)`: alias a trial handle
   onto the claimed permanent one at "claim it forever"; migrate a discoverable handle onto a stealth one without
   republishing keys. **Guard against circular alias chains (A→B→C→A) — they OOG-revert.**
5. **Two-axis identity via ENSIP-19.** `setNameForAddrWithSignature` with a `chainIds[]` array sets a discoverable
   handle's primary name across Base/OP/Arbitrum in one gasless signature; a **stealth** handle deliberately sets no
   reverse record (no address→handle link). Store an **ERC-5564** stealth meta-address in a text record so
   routing/tips derive a fresh one-time address each time.

**Roadmap (mention, don't demo):** revoke-a-role bumps `tokenVersionId` → `TokenRegenerated` bricks outstanding
approvals = a native identity kill switch; `clearRecords(node)` = one-tx duress wipe of all published routing.

**Discoverability model — a dial, not a switch (the creative headline for search)**

Discoverability is a **five-rung ladder**, not the old binary. The key idea judges won't have seen: because every
handle resolves through our **CCIP-Read offchain resolver** (the same one that issues names gaslessly), the gateway
runs **real code on every lookup** — so it can return records **conditionally, per-record and per-caller**. ENS
records are normally "public read"; ours are "read *if you qualify*." ENS itself cannot enumerate/search — an
off-chain index does that — but **the resolution policy decides what the index is even allowed to see.** That gate,
not the index, is the creative use.

| Rung (`eth.lortnoc.discoverable`) | Meaning | Enforcement |
|---|---|---|
| `ghost` | Not findable at all; only someone you handed your handle to reaches you | Random handle · no reverse record · not indexed |
| `unlisted` | Forward-resolvable but not searchable, not reverse-linkable | Forward records on · reverse off · gateway serves no directory record |
| `known` | Findable only by someone who already knows an identifier (Telegram/phone/email) | Publish salted `eth.lortnoc.findhash`; friend recomputes the hash — world can't enumerate |
| `searchable` | Appears in the app's people-search | Opt-in directory record the indexer is allowed to read |
| `public` | Fully linkable; on-chain footprint maps back to you | Reverse record set (ENSIP-19, use #5) |

**Four v2-native mechanisms that make each rung real (and revocable):**
1. **Conditional resolution at the gateway (headline).** `pubkey` resolves for everyone (people must be able to
   pay/message you); the searchable-profile record resolves **only to callers who prove something** — a mutual, a
   friend token, a paid member. "Discoverable to some, invisible to others," enforced at resolve-time.
2. **Public face vs private core, independently revocable.** `setAlias` points a searchable name
   (`alice.find.lortnoctahc.eth`) at your real records **without republishing keys**, while your identity stays a
   random `<x>.lortnoctahc.eth`. Drop the alias ⇒ vanish from search instantly; existing conversations (on the private core)
   keep working. (Impossible in v1.)
3. **Findable-if-you-know-me without a public directory.** Salted `eth.lortnoc.findhash` — a friend who already
   knows your Telegram/phone hashes it and finds you; strangers cannot enumerate backwards.
4. **Least-privilege directory access.** `authorizeTextRoles(name, "eth.lortnoc.discoverable", indexer, true)` grants
   the indexer rights to **exactly** the discoverable flag — never `pubkey`, never address. Discoverability as a
   scoped, revocable capability, not app politeness.

**Bonus (demo-friendly): event mode** — a time-boxed `known`/`searchable` rung ("anyone at Lisbon can find me
today") the gateway auto-expires. Temporary discoverability nobody has to remember to switch off.

**Build order** *(on-chain v2 identity layer; pinned to the `2026-06-29` Sepolia deployment)*
0. ✅ **Preflight:** `eth_getCode` on all eight pinned addresses + tag. Automated — `scripts/ens/deploy.mjs`
   refuses to run if any rotated, and `scripts/ens/status.mjs` re-checks on demand.
1. ✅ **Own `lortnoctahc.eth`** (and `lortnoc.eth`) in the v2 `ETHRegistry` — commit→wait→reveal, MockUSDC.
2. ✅ **Per-user resolver happy path (the core demo):** collapsed into `LortnocRegistrar.claim()` — one tx deploys
   the handle's own `PermissionedResolver` proxy, writes `pubkey`, hands the user every role, drops its own, and
   registers the subname. `authorizeTextRoles` then delegates `eth.lortnoc.inbox` to the gateway, the gateway's
   `pubkey` write **reverts**, and the user **revokes** in one tx. `verifyContract(proxy)` = trustless handle proof.
   Asserted end-to-end by `scripts/ens/demo.mjs`; surfaced in the app as a live permission table read off-chain.
3. Deploy Semaphore membership + verifier on **0G Galileo (chain 16602)**; wire pay → insert identity commitment
   (confirm bn254 precompiles `0x06/0x07/0x08` on 0G first).
4. ✅ **`LortnocRegistry`** (a `UserRegistry` proxy, slotted under `lortnoctahc` via `setSubregistry`) + a custom
   `LortnocRegistrar` holding `ROLE_REGISTRAR`. **Still open:** nullifier-gating (the `gate` hook is in the
   contract, unset = free tier) and relaying (`claimFor` exists; no relayer service yet).
5. **Discoverability + knock (§6.8):** gateway serves the §5.4 records and does **conditional read-gating** +
   knock-verification (a read/offchain concern, orthogonal to the on-chain write-roles). `setAlias` conversion flow
   if time remains.
6. **No hard-coded ENS *values*** in app logic beyond the pinned deployment addresses (prize req). Prepare the
   in-person ENS-booth demo (Sunday AM): lead with the per-record role revoke.

### 6.6 Native 1:1 DM — **IN (minimal)**

- **Purpose.** The sovereign messenger we convert users onto. Reuses the whole Sui/Walrus/Seal/ENS stack; a more
  reliable demo of the decentralized stack than the fragile Telegram round-trip.
- **Interface.** `send(toHandle, body)` / conversation reader. No groups, calls, or presence.
- **Data.** Resolve `toHandle` → `eth.lortnoc.pubkey`. Encrypt the `Message` to that X25519 pubkey (sealed box) for
  transit; **Seal-encrypt** for storage. Persist via §6.4 (`Quilt` → Walrus → `ConversationHead`).
- **Flow.** Compose → resolve peer key → encrypt → durably append to Walrus + bump the Sui head. Recipient: **poll**
  head/inbox → pull blob → `Seal.decrypt` → render. Same key-discovery, encryption, storage, and unlock model as
  Mirror mode — just pointed at another lortnoc user instead of a Telegram bubble.
  **⚠️ Realtime relay is ROADMAP, cut for the weekend.** The "hot-path relay/libp2p" that makes chat feel live is
  **unspecified and unbuilt** (§6.4, §12 Q11) — a whole extra backend. For the demo, **poll** Walrus/the Sui head;
  don't promise realtime P2P.
  **⚠️ Single-writer `ConversationHead` for the demo.** The mutable Sui head has no concurrency model; two writers
  bumping `seq`/`headBlobId` contend and lose updates. Demo constraint: one writer per conversation (or per-sender
  heads merged on read). Multi-writer ordering is post-hackathon.
- **Scope/failure.** If the overlay hiccups on stage, native mode still shows the full stack end-to-end.

### 6.7 Unified inbox & conversion CTA — **IN (minimal)**

- **Purpose.** Where "a stego toy" becomes "the messenger you switch to." Turns *reading* into *converting*.
- **Interface.** Three lanes in one inbox, over **currently-loaded** Telegram chats only (no history backfill):
  🔒 **Native lortnoc** · **Stego threads** (hidden in Telegram) · **Mirrored Telegram** (read-only, from the DOM).
- **Flow.** *Verified-handle claim:* the extension knows the logged-in Telegram username → attests this browser
  controls `@kilian` → one-tap gasless claim of `kilian.lortnoctahc.eth`. *Conversion CTA:* on any normal Telegram
  thread, a quiet banner — *"This chat lives on Telegram's servers. Claim your handle and invite [Contact] → chat
  with nothing stored on Telegram."*
- **Scope/failure.** **Mirror is local-first, encrypted under the user's key, opt-in per chat** — never host the
  counterparty's plaintext (invariant §4). Frame as "a private encrypted copy of your own Telegram," not harvesting.
  Full scroll-harvest is OUT (post-hackathon).

### 6.8 Challenge-gated contact — "knock" — **IN (creative differentiator)**

- **Purpose.** Consent-first, spam-proof connection: **nobody can even notify you of intent-to-connect unless they
  clear a gate you configure** — a shared password or a trivia answer (*"what bar did we meet at?"*). Turns "anyone
  can DM you" into "only people who can answer get through." The second axis of discoverability (§6.5 use #2):
  *findability* × *reachability*.
- **Mechanism (symmetric; no secret published; no gateway trust).**
  1. You publish `eth.lortnoc.knock = { prompt, salt, kdfParams }` — a text record holding the **question, never the
     answer**.
  2. Requester derives `k = Argon2id(answer, salt)` → sends `knock = AEAD.encrypt(k, { reqPubkey, intro, nonce })`
     via the relay/inbox.
  3. You derive `k` from the answer *you* know → `AEAD.open` each incoming knock. **Valid auth tag ⇒ surface "X wants
     to connect" + their pubkey** (bootstraps `K_conv` in the same step, §5.3 Tier-1). Invalid ⇒ silently dropped.
- **Properties.** No public commitment ⇒ **no offline brute-force** — guessing is online-only, **rate-limited by the
  relay**. The knock *is* the key exchange. **Multiple/rotating answers ⇒ segmented contact circles** (a "work"
  answer vs a "friends" answer route to different inboxes).
- **v2 fit.** `knock` is a text record ⇒ governed by the Permissioned Resolver; you may delegate ONLY the knock
  record to a helper via `authorizeTextRoles` while keys stay untouchable. Verification is client-side/offchain (a
  read concern) — consistent with "EAC roles gate writes, not reads."
- **Scope/failure — honesty.** Trivia is low-entropy: this is **spam-resistance + intentional contact, NOT
  cryptographic access control.** Argon2id + relay rate-limiting slow guessing; a **high-entropy shared password** is
  the mode for real secrecy. Fail-closed: a malformed/failed knock never notifies the user.

---

## 7. Paid access & the anonymous membership contract

**Payment = registration = membership**, unlocking either mode (codec inference in Telegram mode; storage/relay in
native mode). **Reading your own already-stored history is always free** — it's ciphertext encrypted to your key.

**Flow (Semaphore).**
1. **Identity, local.** `id_sem` (§5.1) → **identity commitment**. Secret never leaves the device.
2. **Join = pay.** Paying inserts the commitment into an on-chain Merkle "paid members" set. Observers see only
   *"a wallet paid + the tree grew."*
3. **Claim/use = prove.** Client proves *"I know the secret behind **some** commitment"* + emits a **nullifier**
   `= hash(id_sem, scope)` (prevents reuse without revealing which member). Public signal carries the fresh handle
   pubkey. `wallet X → commitment C` is public; `C → nullifier → handle` is hidden — the chain is severed.
4. **Gateway issues the subname** against the proof and *cannot* learn which payment it maps to.

**Contract surface** (host: 0G Chain or Sui — see §12 Q4):
```
join(commitment)              // payable; inserts commitment, grows Merkle root
verifyAndSpend(proof, root, nullifier, signal) → bool   // reverts if nullifier already spent
```
`LortnocRegistry.register()` (§6.5) calls `verifyAndSpend` before issuing the subname.

---

## 8. The ZK privacy guarantee (say this exactly)

**Unlinkability, not invisibility.** ZK set-membership hides *which handle/usage a payment unlocks*; it does **not**
hide *that a payment happened*. Privacy = the size of the paid crowd. Pitch: *we hide who-uses-what, not
that-you-bought.*

**Three real leaks — all around the ZK, not in it:**
- **The payment tx** — `wallet X paid lortnoc` is public. Base design accepts this; only Layer 3 hides it.
- **Timing correlation (the practical killer)** — pay-then-immediately-claim links the two regardless of the proof;
  a low payment rate collapses the anonymity set.
- **Fee-payer re-linking** — same wallet paying *and* funding the claim/proof tx re-links everything.

**⚠️ Layer-0 tradeoff (decision, §6.5).** We chose the **on-chain v2 identity layer**, so paid-tier issuance is an
on-chain tx — **we forfeit Layer 0** (zero footprint) in exchange for real ENS v2 permission sets + on-chain
verifiability. **Unlinkability is retained** via Layers 1/2/4 (relayed claim, payer ≠ claimer, timing/gateway
hygiene). Free-tier handles are sponsored and **intentionally non-anonymous** (§9); free *messaging* needs no handle
at all (§5.3 Tier-1). Layer 0 remains the mainnet scaling fallback for free handles, not the demo path.

**Layered defenses (build priority):**
- **Layer 0 (fallback only now): offchain subnames emit no on-chain event.** Claiming via CCIP-Read has **zero
  on-chain footprint**. Superseded on the demo path by on-chain v2 (above); kept as the mainnet free-tier option.
- **Layer 1: decouple wallets + relay.** The paying identity never touches the claim; the claim is sponsored/relayed.
- **Layer 2: break timing.** Let users pay now, claim later; batch commitment insertions; grow the set before issuing.
- **Layer 3 (STRETCH): hide the payment.** Fresh wallet funded via fiat on-ramp or a privacy pool (Railgun /
  Privacy Pools). Its own project — roadmap, not demo.
- **Layer 4: gateway hygiene.** Don't log IPs; stateless gateway + on-chain/0G proof verification ⇒ no join↔claim
  log. Structural: the gateway *can't* link; policy: it *doesn't* retain.

**Two-tier honesty (state plainly, or judges will catch it):** anonymity applies to the **paid** tier only. The
freemium **trial is deliberately metered by Telegram handle** (§9) — *intentionally identified, not anonymous.*
Trial = handle-metered / non-anonymous; paid = zk-unlinkable. These don't conflict.

---

## 9. Do NOT use World ID

**This project must not use World ID** (even though World runs a Lisbon prize). Meter the freemium trial (first few
messages free, locked as tightly as paid) **by Telegram handle** — the extension already knows the logged-in handle.
No signup, no ID scan. See the `no-world-id` memory.

**⚠️ Honesty: for the hackathon the trial is honor-system.** There is no server account (§5.5), so client-side
handle-metering is trivially bypassable — the extension enforces it, nothing else can. That's fine for the demo;
just don't claim the trial is cryptographically enforced. A real enforcement point (attested handle → server-side
counter, or on-chain rate-limit) is post-hackathon. Only the **paid** tier gets the zk-unlinkability guarantee (§8).

## 10. Prize targets (Lisbon 2026)

- **0G — Best AI Product** ($15k / $6k top): codec inference on 0G Private Computer (sealed) + a 0G-Chain contract.
  Frame as *sealed inference = privacy*. Needs addresses + proof of 0G inference + <3-min video.
- **Sui — Best app built on Sui** ($6k): Walrus + Seal store, Sui-object head, testnet deploy. Storage central.
- **ENS — Most Creative Use** ($1.5k + sister track): the §6.5 design. No hard-coded values; **ENS-booth demo Sun AM.**
- **Continuity tracks** (+~$8.5k): OFF-LIMITS unless a dated pre-Lisbon prototype exists — **confirm (Q1).**

## 11. Build order (risk-first) & toolchain

**Phase 0 — de-risk (first ~3h, parallel; any red = pivot):** (a) **Telegram byte-exactness test** — send constrained
plain cover text, read back from DOM, assert byte-identical — **blocker if it fails**; (b) **0G logprobs/determinism
probe** — `router-api.0g.ai/v1` with `logprobs:true`, same request twice, diff (confirms CF-1, informational only);
(c) **local codec round-trip** — `nethical6` `decode(encode(x))==x` deterministic, model kept warm; (d) Sui faucet +
WAL early (rate-limited), confirm bn254 precompiles on 0G Galileo. **Phase 1 — hero demo:** the §6.1 overlay, local
deterministic codec, own AES-SIV (CF-5), pre-shared key for the stage pair. **Phase 2 — sponsor coverage
(parallel):** §6.4 (Walrus+Seal round-trip, session-key fallback) · §6.5 (**DONE** — own `lortnoctahc.eth` →
LortnocRegistry + LortnocRegistrar → per-user resolvers; discoverability gateway still open) · §6.3 (Semaphore on Galileo + one sealed-inference call + <3-min video).
**Phase 3 — polish:** minimal native-mode DM (reliable fallback demo); pitch, diagram, videos, ENS-booth prep.
Hero demo + Sui + ENS are the winning submission on their own; 0G adds the top prize.
**Cut for the weekend:** realtime relay/libp2p (poll instead); PWA as a full app; Tier-1 in-band handshake on the
demo path; nullifier-inside-`seal_approve`; ERC-5564 payment layer (roadmap).

**Toolchain (ENS/app/contracts confirmed in use; rest proposed):** **pnpm** monorepo (workspaces: `extension/`, `codec/`, `gateway/`,
`contracts/`, `app/`) · **Vite + CRXJS** for the MV3 extension · **Foundry** for Solidity (Semaphore on 0G Galileo;
`LortnocRegistry` cloned from ENS v2 `UserRegistryImpl` on Sepolia) · **viem** for ENS v2 contract calls
(`deployProxy`, `authorizeTextRoles`, `verifyContract`, `UniversalResolverV2.resolve`) pinned to the `2026-06-29`
addresses · **Sui CLI + Move** for the `ConversationHead` + `seal_approve` module · **Python + HuggingFace `transformers`
(GPT-2, CPU)** for the codec HTTP service (own arithmetic coder over local logits; `nethical6` as fallback; model
warm as a persistent process, one hosted instance both ends call) · **Cloudflare Worker + D1** for the
offchain gateway (discoverability read-gating, knock relay/verification, claim relayer) · SDKs: `@mysten/walrus`,
`@mysten/seal`, `@mysten/sui`, `@semaphore-protocol/*`, `@0gfoundation/0g-compute-ts-sdk`,
`@scopelift/stealth-address-sdk`.

**Storage benchmark (justification artifact — keep, don't skip).** A small `bench/` TS harness runs identical
encrypted payloads through a `BlobStore` interface against **Walrus+Seal** and **0G Storage** on their testnets, over
our real workload (batched-blob write, cold read-by-id, head update+read, N-blob device-sync, cost/1k msgs). Output =
a markdown table + JSON. **Purpose is not to pick a backend (decided: Walrus+Seal) but to *justify* it with data** —
a rigor artifact that also flips the script (we measured the sponsor's product). Honesty guards: testnet ≠ mainnet;
0G's `$11/TB` & `30 MB/s` are self-reported; "batch, never per-message" applies to both.
**The cost half is already done and is stronger than a testnet bench:** §6.4's mainnet cost model prices our real
workload off live on-chain values and the actual encoding math, so `bench/` only needs to add the *latency/durability*
columns. It also supplies the bench's headline finding — the 63-storage-unit floor makes "batch, never per-message"
a 650× effect, not a tuning note.

**Locked decisions (§12):** Q2 → **Semaphore** · Q3 → **wrap `nethical6`** (local, deterministic) · Q4 →
**membership on 0G + on-chain ENS v2 naming on Sepolia** (full v2 identity layer, pinned `2026-06-29`; §6.5) · Q6 →
**wallet-signature default** · Q7 → **assume NO usable logprobs; codec stays local** (CF-1) · Storage → **Walrus+Seal
core; 0G Storage evaluated & deferred** (§6.4, kept for Seal's access-control + durability). Still open: Q1
(continuity eligibility), Q5 (Electron — default no).

## 12. Open decisions (resolve before building the affected layer)

**Technical**
1. **Continuity eligibility** — dated pre-Lisbon prototype? (Unlocks ~$8.5k.)
2. **Paid-access mechanism** — Semaphore (lean; flashy, on-theme) vs. blind vouchers (lighter fallback).
3. **Codec sourcing** — wrap the GPL Go CLI (lean, speed) vs. reimplement minimal stego.
4. **Membership/registry host** — **RESOLVED (§6.5):** **membership (Semaphore) on 0G Galileo** (doubles as 0G's
   required address); **naming = on-chain ENS v2 on Sepolia** (`LortnocRegistry implements IRegistry` under
   `lortnoctahc.eth`, pinned to the `2026-06-29` deployment). Two chains, distinct jobs; relayed claim bridges them.
5. **Desktop feel** — Electron wrap or browser extension only.
6. **Identity model** — ~~passphrase-default vs. wallet-optional~~ **RESOLVED: wallet-signature default, passphrase
   fallback** (§5.1). Fallback exists because some smart-contract/MPC wallets and all passkeys can't derive
   deterministically. Invariant: identity wallet ≠ payment wallet (§4).
7. **0G logprobs** — ~~does `pc.0g.ai` expose per-token distributions?~~ **RESOLVED: assume NO** (CF-1) — even if it
   did, hosted GPU inference is non-deterministic and breaks reversibility. **Codec stays local**; 0G hosts the
   membership contract + a non-codec sealed-inference assist (§6.3). Probe the endpoint in Phase 0 for the record only.

**Product / business** (don't block the build, but decide before launch)
8. **Cost to run** — **STORAGE LINE ITEM RESOLVED (2026-07-25, validated against Walrus mainnet — full model +
   caveats in §6.4 "Mainnet cost model").** Quilted Walrus+Seal storage is **$0.03–$0.48/user/year** at 10–200
   msg/day and comfortably clears any sane subscription. **Unbatched it is $16–$316/user/year (~650× worse), and
   unbatched is what the code does today** — so the pricing verdict is conditional on shipping Quilt. Storage is
   **recurring** (blobs expire; mainnet epoch = 2 weeks, max 53). **Still unpriced:** Seal mainnet key servers (all
   commercial, per-request, quote required) and 0G sealed-inference per message — get both before setting a price.
9. **Pricing** — freemium meters by Telegram handle (§9); the paid tier covers "Walrus rent + codec inference."
   Flat sub vs. usage-based? Price must clear the §8 marginal cost. **Storage is no longer the binding
   constraint (Q8); codec inference + Seal key requests are.** Price per-year, not one-time — blobs need renewal.
10. **Homepage messaging** — how much "propaganda"/manifesto vs. product clarity on `lortnoctahc.com`. Keep the
    privacy pitch first; codec/LLM stays invisible plumbing (§1).
11. **P2P reliability** — Walrus is a durable log, not a realtime bus; realtime feel depends on the relay/libp2p
    hot path (§6.4/§6.6). Validate latency + delivery under real conditions before over-promising "P2P."

## 13. References — per bounty partner (what we use + docs)

> Links verified 2026-07-24. Prize sponsors we target: **0G, Sui/Mysten, ENS.** Semaphore, nethical6, ScopeLift are
> *tools* we use, not bounty partners. World is OFF (§9).

### 0G — *Best AI Product / Infrastructure / Continuity* (§6.3)
- **Sealed inference (non-codec assist, §6.3)** — Private Computer `https://pc.0g.ai/` · OpenAI-compatible endpoint
  `https://router-api.0g.ai/v1` · Compute docs `https://docs.0g.ai/developer-hub/building-on-0g/compute-network/inference`
  · SDK `@0gfoundation/0g-compute-ts-sdk` (`https://github.com/0gfoundation/0g-compute-ts-sdk`).
- **0G Chain (EVM) — deploy Semaphore membership/verifier (§7)** — deploy docs
  `https://docs.0g.ai/developer-hub/building-on-0g/contracts-on-0g/deploy-contracts` · testnet (**Galileo, chain
  16602**, RPC `https://evmrpc-testnet.0g.ai`) `https://docs.0g.ai/developer-hub/testnet/testnet-overview` · faucet
  `https://faucet.0g.ai` (0.1 0G/day) · explorer `https://chainscan-galileo.0g.ai`.
- **0G Storage — EVALUATED & DEFERRED; benchmark only (§6.4, §11)** — concepts `https://docs.0g.ai/concepts/storage`
  · SDK docs `https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk` · `@0gfoundation/0g-ts-sdk`
  (`https://github.com/0glabs/0g-ts-sdk`) · starter `https://github.com/0glabs/0g-storage-ts-starter-kit`.
- **Prize** — `https://ethglobal.com/events/lisbon2026/prizes/0g`.

### Sui / Mysten Labs — *Best app on Sui* (§6.4)
- **Walrus (durable blob store)** — SDK `@mysten/walrus` `https://sdk.mystenlabs.com/walrus` · docs
  `https://docs.wal.app/docs/getting-started` · Upload Relay (Mysten runs public testnet relays)
  `https://docs.wal.app/operator-guide/upload-relay.html` · **Quilt** small-object batching
  `https://www.walrus.xyz/blog/introducing-quilt` · network ref `https://docs.wal.app/docs/network-reference`.
- **Seal (threshold encryption + on-chain `seal_approve` policy)** — SDK `@mysten/seal`
  `https://github.com/MystenLabs/seal` · access-control docs `https://docs.sui.io/sui-stack/seal/sui-stack-seal` ·
  `https://seal-docs.wal.app/`.
- **Sui Move (`ConversationHead` object + `seal_approve` module)** — publish
  `https://docs.sui.io/guides/developer/first-app/publish` · get coins
  `https://docs.sui.io/getting-started/onboarding/get-coins` · faucet `https://faucet.sui.io/` · test WAL (swap
  SUI→WAL) `https://stake.walrus.site/`.
- **Prize** — `https://ethglobal.com/events/lisbon/prizes` (verify Sui/Walrus/Seal track on-site).

### ENS — *Most Creative Use* (§6.5) — **on-chain v2 identity layer**
- **ENS v2 contracts (real, deployed on Sepolia; pin tag `sepolia-deployment-2026-06-29`)** — repo
  `https://github.com/ensdomains/contracts-v2` · Permissioned Resolver + EAC role constants
  `contracts/src/resolver/PermissionedResolver.sol`, `.../libraries/PermissionedResolverLib.sol`,
  `.../access-control/EnhancedAccessControl.sol` · registry `.../registry/interfaces/IRegistry.sol` · Sepolia
  addresses `contracts/deployments/sepolia/` · docs `https://docs.ens.domains/contracts/ensv2/overview/`.
- **Verifiable Factory (`deployProxy`/`verifyContract`)** — `https://github.com/ensdomains/verifiable-factory`.
- **CCIP-Read (offchain gateway read-gating / discoverability, §6.5)** — `https://docs.ens.domains/resolvers/ccip-read/`
  · subnames `https://docs.ens.domains/web/subdomains/`.
- **ENSIP-19 (reverse / primary names — the discoverable↔stealth axis)** — `https://docs.ens.domains/ensip/19/`.
- **ERC-5564 stealth (pay-as-you-chat, §6.8 payments)** — `https://eips.ethereum.org/EIPS/eip-5564` · ERC-6538
  registry `https://eips.ethereum.org/EIPS/eip-6538` · ScopeLift SDK `@scopelift/stealth-address-sdk`
  (`https://github.com/ScopeLift/stealth-address-sdk`).
- **Prize** — `https://ethglobal.com/events/lisbon2026/prizes` (ENS track); ENS-booth demo Sun AM.

### Supporting tools (not bounty partners)
- **Semaphore v4 (zk set-membership + nullifier, §7)** — `https://docs.semaphore.pse.dev/` · contracts
  (`Semaphore.sol` + `SemaphoreVerifier.sol`) `https://docs.semaphore.pse.dev/technical-reference/contracts` ·
  `https://github.com/semaphore-protocol`.
- **`nethical6/conversation-steganography` (codec, Go CLI, GPL-3.0; local + deterministic, §6.2)** —
  `https://github.com/nethical6/conversation-steganography`.
- **Crypto primitives** — AES-SIV (RFC 5297) · HKDF-SHA256 (RFC 5869) · Argon2id (RFC 9106) · X25519 (RFC 7748).
