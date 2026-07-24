# Build checklist — priority order

Strict priority, so if time runs out you stop at a natural cut line and still have a winning demo.
**Rule: the extension doing encrypt→cover→decode on Telegram Web is P0; everything else is negotiable.**

## P0 — Hero demo: the extension on Telegram Web
*Ship this first. If only this works, you win the room. Items build on each other in order.*

- [x] **Codec round-trips deterministically** — `codec/` `wordmap-256`; `decode(encode(x))==x` + determinism tests green *(GPT-2 arithmetic coder swaps in later behind the same HTTP contract)*
- [x] **Extension scaffold + loads on `web.telegram.org`** — CRXJS MV3, content script on `/k/`, SW, popup toggle; `npm run build` clean *(load-unpacked confirmation pending)*
- [ ] **🔑 Telegram byte-exactness test** — **PENDING (needs live browser)**: load unpacked, confirm `execCommand('insertText')` + `.btn-send.click()` sends byte-identical cover text on the current Web K build. Code is in `content/compose.ts`; this is the one live gate.
- [x] **Client-side AES-SIV** — `@noble/ciphers` in `content/crypto.ts`; `test/pipeline.test.mjs` proves round-trip + wrong-key detector
- [x] **Outbound** — send-intercept → encrypt → `/encode` → replace → send *(logic verified end-to-end minus DOM)*
- [x] **Inbound** — observer + dedupe-by-`data-mid` → `/decode` → AES-SIV verify → inline render *(logic verified minus DOM)*
- [~] **Demo polish** — shuffle animation + fail-closed done; selector-miss messaging + transform-then-send fallback still to add

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
