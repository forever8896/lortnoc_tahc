# Build checklist — priority order

Strict priority, so if time runs out you stop at a natural cut line and still have a winning demo.
**Rule: the extension doing encrypt→cover→decode on Telegram Web is P0; everything else is negotiable.**

## P0 — Hero demo: the extension on Telegram Web
*Ship this first. If only this works, you win the room. Items build on each other in order.*

- [ ] **Codec round-trips deterministically** — `/encode`, `/decode`; `decode(encode(x)) == x` for 100 random payloads, identical across process restarts *(foundation — nothing works without it)*
- [ ] **Extension loads on `web.telegram.org`** — MV3 content script + per-chat "stego on/off" toggle
- [ ] **🔑 Telegram byte-exactness test** — replace compose with a known string, send, read the inbound bubble back from the DOM, assert **byte-identical** *(the real blocker — prove it before building the flow)*
- [ ] **Client-side AES-SIV** — encrypt/decrypt in the page with a **pre-shared key** (passphrase → `K_conv`)
- [ ] **Outbound** — intercept send (Enter + button) → encrypt → `/encode` → swap compose text → let Telegram send the cover text
- [ ] **Inbound** — `MutationObserver` on new bubbles → `/decode` → AES-SIV verify → **valid tag = render decoded inline; invalid = leave as normal chatter**
- [ ] **Demo polish** — shuffle animation over codec latency, fail-closed on bad decode, short demo threads

**Done when:** two accounts (or two browser profiles) hold a real hidden conversation through Telegram; onlookers see only chatter. *This is the whole pitch.*

## P1 — Prize coverage
*Each a minimal, standalone, parallelizable integration.*

- [ ] **Sui** — Walrus `writeBlob`/`readBlob` of a `Seal.encrypt`ed blob + a real `seal_approve` policy (**session-key fallback**, not nullifier-in-policy)
- [ ] **ENS** — one handle on a real **Permissioned Resolver** + **one per-record role delegation** (`inbox`→gateway; show `pubkey` write reverts, then revoke) + `verifyContract`
- [ ] **0G** — Semaphore membership/verifier deployed on **Galileo (16602)** (the contract address) + **one non-codec** sealed-inference call + `<3-min` video

## P2 — Differentiators & reliability
*Only if P0 + P1 are solid.*

- [ ] **Native-mode 1:1 DM** — reliable full-stack fallback demo (poll, single-writer head)
- [ ] **Knock** (challenge-gated contact) — the creative headline
- [ ] **Discoverability gateway** — conditional resolution / findability ladder
- [ ] **Storage benchmark** artifact (Walrus+Seal vs 0G Storage)
- [ ] **Unified inbox + conversion CTA**

## ❌ OUT — do not build (scope guards)

- Realtime relay / libp2p → **poll instead**
- PWA as a full app
- In-band Tier-1 handshake on the demo path → **pre-shared key**
- nullifier-inside-`seal_approve` → **session-key fallback**
- ERC-5564 stealth payment layer *(roadmap; beyond the messaging core)*
- Multi-writer `ConversationHead`

---

**Cut lines:** finish **P0** → hero demo. Add **P1** → prizes. **P2** is gravy.
If behind, drop from the bottom up — never let P1/P2 steal hours from an unfinished P0.
