# Build checklist — priority order

Strict priority, so if time runs out you stop at a natural cut line and still have a winning demo.
**Rule: the extension doing encrypt→cover→decode on Telegram Web is P0; everything else is negotiable.**

## P0 — Hero demo: the extension on Telegram Web ✅ DONE & LIVE

- [x] **Codec, deployed & warm** — `codec/` GPT-2 block-stego on **fly** (`lortnoc-codec.fly.dev`, `gpt2/k6`),
      byte-safe lowercase-word tokens, profanity/NSFW filter, random-nonce openings; markov + wordmap fallbacks;
      reversibility proven model-independently (`test_coder.py`).
- [x] **Extension loads & runs on `web.telegram.org/k/`** — CRXJS MV3, content script, SW codec broker, popup.
- [x] **🔑 Telegram byte-exactness — CONFIRMED LIVE** — real messages round-trip through Telegram (tested in-browser).
- [x] **Client-side AES-SIV** — `@noble/ciphers`; wrong-key detector works (`test/pipeline.test.mjs`).
- [x] **Outbound** — send-intercept → encrypt → `/encode` → replace → send. No plaintext leak, no double-send.
- [x] **Inbound** — observer, dedupe-by-`data-mid`, decode-cache, AES-SIV verify → inline render + hover card
      showing what Telegram stored.
- [x] **Demo polish** — shuffle/pulse busy cue, fail-closed everywhere, SW fetch timeout, selector-miss messaging.

**Done:** two people hold a real hidden conversation through Telegram; onlookers see only chatter. *The pitch works, live.*

## P0.5 — Shipped beyond the original P0 ✅

- [x] **Passphrase-free Tier-1 handshake** *(was cut — we built it)* — X25519 ECDH keys smuggled as cover text,
      one-tap Accept, no shared secret. Frames skip best-of-N (fast ~2-3s). `content/handshake.ts` + `session.ts`.
- [x] **0G best-of-N cover selection — LIVE** — real 0G Compute **testnet** inference judges which of 3 covers reads
      most natural, in the live send path. Broker sidecar on fly (`lortnoc-zerog.fly.dev`), funded testnet wallet.
      *(This is genuine 0G Compute usage — see P1.)*

## P1 — Prize coverage

- [~] **0G — partially done.** ✅ Compute inference is LIVE (best-of-N above). **Still needed:** deploy the Semaphore
      membership/verifier contract on **Galileo (16602)** for the required "contract address" + a `<3-min` demo video.
      Fine-tune path prepped (`codec/finetune/`, verified exportable) as a second, deeper 0G integration if wanted.
- [ ] **Sui** — Walrus `writeBlob`/`readBlob` of a `Seal.encrypt`ed blob + a real `seal_approve` policy
      (session-key fallback, not nullifier-in-policy). **Not started.**
- [ ] **ENS** — one handle on a real **Permissioned Resolver** + one per-record role delegation
      (`inbox`→gateway; `pubkey` write reverts; revoke) + `verifyContract`. **Not started.**

## P2 — Differentiators & reliability *(only if P1 is moving)*

- [ ] **Wallet-signature identity** — swap the handshake's random keypair for a wallet-signature-derived one
      (the handshake/ECDH piping is already built; this is the small next brick).
- [ ] **Arithmetic-coding codec** — built + proven in a worktree (`CODEC_CODER=arith`, default off). More *natural*
      cover text (not shorter — measured). Merge/deploy decision pending.
- [ ] **Native-mode 1:1 DM** — reliable full-stack fallback demo (poll, single-writer head).
- [ ] **Knock** (challenge-gated contact) — the creative headline.
- [ ] **Discoverability gateway** — conditional resolution / findability ladder.
- [ ] **Storage benchmark** artifact (Walrus+Seal vs 0G Storage).
- [ ] **Unified inbox + conversion CTA.**

## ❌ OUT — do not build (scope guards)

- Realtime relay / libp2p → **poll instead**
- PWA as a full app
- nullifier-inside-`seal_approve` → **session-key fallback**
- ERC-5564 stealth payment layer *(roadmap; beyond the messaging core)*
- Multi-writer `ConversationHead`

---

**Where we stand:** P0 hero demo is **done and live**, plus the passphrase-free handshake and a real **0G Compute**
integration. **The winning-submission gap is now Sui + ENS + the 0G contract/video** (P1). P2 is all upside.
