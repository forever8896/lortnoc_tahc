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
- [x] **0G best-of-N cover selection — LIVE** — real 0G Compute **testnet** inference judges which of 2 covers reads
      most natural, in the live send path. Broker sidecar on fly (`lortnoc-zerog.fly.dev`), funded testnet wallet.
      *(This is genuine 0G Compute usage — see P1.)*

## P1 — Prize coverage

- [x] **0G — DONE.** Compute inference LIVE (best-of-N cover selection). **Contract requirement closed:**
      anonymous membership settled on **Galileo (16602)** — canonical `SemaphoreVerifier` + `Semaphore`
      (Poseidon-linked) deployed by us, plus `LortnocMembership` (`0x219f68fdbfeda4576939de3f75c4e362ed00e11e`):
      `join()` is payable and inserts your identity commitment; `spendTicket()` burns a nullifier against a
      Groth16 proof. bn254 precompiles verified present first. Exercised live: 2 members, tickets burned.
- [x] **Sui — DONE.** Move package published on testnet
      (`0xb214da015f1f8f59fb9804f42185782f6f2ce34e398175b060fee266c8074faf`): `ConversationHead` shared object
      + a **real `seal_approve` policy** gating key shares on conversation membership AND object-namespaced
      identity. **Seal is now in the message path for real** (2026-07-26): messages are Seal-encrypted to a
      head-namespaced identity and opened only after the key servers dry-run the policy — `scripts/seal-live.mjs`
      shows a member recovering plaintext and a stranger getting `NoAccessError` from the servers themselves.
      Quilt measured and deliberately skipped (a 3-message quilt is 445 KB; see CLAUDE.md §6.4).
      Walrus write/read live via Mysten's upload relay (direct-to-node writes fail; relay tips 105 MIST).
      Round-trip asserted 9/9: encrypt → blob → head → read → decrypt, wrong key fails closed, append bumps
      seq, heads discoverable from `ConversationCreated` events.
- [x] **ENS — DONE, on-chain.** `lortnoctahc.eth` (+ `lortnoc.eth` reserved) in the v2 `ETHRegistry`;
      `LortnocRegistry` (UserRegistry proxy) slotted under it; `LortnocRegistrar` holding `ROLE_REGISTRAR` so
      **any wallet claims permissionlessly**. `claim()` = ONE tx: per-handle `PermissionedResolver` proxy from the
      canonical `VerifiableFactory` → writes `eth.lortnoc.pubkey` → grants the user every role → revokes its own →
      registers the subname. Per-record delegation (`inbox`→gateway; `pubkey` write reverts; revoke in one tx) +
      `verifyContract` handle proof, asserted by `scripts/ens/demo.mjs` and surfaced in the app as a permission
      table read live off the resolver. Runbook: `app/docs/LIVE-SETUP.md`.
      **Paid-tier gating is live — via the relayer, not the on-chain hook.** `POST /claim` checks the
      `ticketMessage` binding, simulates, burns the nullifier on 0G, then calls `claimFor` on Sepolia.
      The registrar's `gate` hook is the *alternative* path and is deliberately unset (free tier).

## P2 — Differentiators & reliability

- [x] **Knock** (challenge-gated contact) — **DONE, the creative headline.** `app/src/lib/live/knock.ts`
      (Argon2id `deriveKnockKey` → `sealKnock`/`openKnock`, no answer ever published) + relayer transport
      (`POST /knock`, `GET /knocks/:handle`, 429 rate limiting, TTL, oldest-out eviction so a flood cannot
      bury real knocks) + UI in `app/src/ui/IdentityPanel.tsx`. The rate limiting is the security property,
      not a nicety: it is what makes guessing online-only (§6.8).
- [x] **Native-mode 1:1 DM** — **DONE.** `app/src/ui/Messenger.tsx` + `Thread.tsx` over
      `sendMessage`/`readMessages` (`live/sui.ts`); polled, single-writer head, as scoped.
- [~] **Discoverability** — records **done**, gateway **not**. `eth.lortnoc.discoverable` and
      `eth.lortnoc.findhash` are in `RECORD_SPECS` and user-writable through the permission table. What does
      not exist is the conditional-resolution gateway — nothing read-gates records per caller, so the
      five-rung ladder is currently *declared* by the record rather than *enforced* at resolve time.
      Say it that way in the pitch; the enforcement is the creative claim and it is the part still open.
- [ ] **Wallet-signature identity in the extension** — `content/session.ts` still calls `genKeyPair()` (random
      per conversation). The app already derives `K_msg` from `MS`; the app→extension bridge
      (`content/appbridge.ts`) currently carries only the membership token. Small brick, real payoff: it is
      what upgrades a throwaway handshake key to a portable identity.
- [ ] **Arithmetic-coding codec** — built + proven in a worktree (`CODEC_CODER=arith`), **not merged into
      `codec/`**. More *natural* cover text (not shorter — measured). Merge/deploy decision pending.
- [ ] **Storage benchmark** artifact (Walrus+Seal vs 0G Storage) — no `bench/`. The cost half is already
      done and stronger than a testnet bench (CLAUDE.md §6.4); only latency/durability columns are missing.
- [ ] **Unified inbox + conversion CTA** — the three-lane inbox (§6.7) is not built.

## P3 — Test coverage & repo hygiene ✅ *(added 2026-07-29)*

`npm test` from the root — six tiers, 277 tests, gated in CI by `.github/workflows/test.yml`.

- [x] **unit (88)** — crypto, framing, session state machine, metering, ticket binding. Imports the real
      product source; no re-implementation.
- [x] **invariants (16)** — CLAUDE.md §4 as executable checks (no MTProto/bot token, no World ID, plaintext
      never reaches the codec, key material never in `storage.local`, the coder never samples).
- [x] **codec (77)** — coder reversibility, the x402 paywall (previously **zero** tests), HTTP status contract.
- [x] **contracts (55)** — `LortnocMembership` + `LortnocRegistrar` under Foundry. Asserts locally what only a
      live deploy script had checked: after `claim()` the registrar holds no roles and cannot write.
- [x] **browser (29)** — the DOM layer in real Chromium against a Telegram Web K fixture.
- [x] **integration (12)** — the full extension data path against a live codec.

**Findings fixed in the same pass** (full write-up: `docs/AUDIT.md`) — a one-sided reconnect that hung
forever, a free-send race that let 40 concurrent sends through a limit of 3, `422` overloading that could
silently swallow a real message, the UI claiming GPT-2 whichever backend ran, and the §5.1 key-derivation
table hand-inlined across **seven** sites (now `shared/keys.mjs`, verified byte-identical).

- [ ] **The relayer has no tests** — 479 lines, a funded key, five cross-chain steps with hand-rolled
      idempotency (in-flight lock, resume-if-already-spent, skip-if-already-taken, confirm-by-state because
      0G propagates receipts slowly). The resume branches only trigger by crashing mid-claim, which is
      exactly what cannot be rehearsed live. **Largest remaining gap in the repo.**

## ❌ OUT — do not build (scope guards)

- Realtime relay / libp2p → **poll instead**
- PWA as a full app
- nullifier-inside-`seal_approve` → **session-key fallback**
- ERC-5564 stealth payment layer *(roadmap; beyond the messaging core)*
- Multi-writer `ConversationHead`

---

## P1.8 — IDENTITY WALLET ≠ PAYMENT WALLET, IMPLEMENTED ✅

The §4 invariant was previously only *stated*. The app used one wallet for both, which threw away
the unlinkability the ZK machinery buys — an observer just saw wallet X pay and wallet X own a
handle.

Now `MS` derives a **third** key, `K_own` (`lortnoc/evm/secp256k1/v1`), and that address owns the
handle. One MetaMask signature still produces everything; the two addresses are connected only
inside `MS`, which never leaves the device. The relayer sends the owner a **0.002 Sepolia ETH
stipend** on claim so it can manage its own records (delegate/revoke) without ever being funded
by the payer.

**Verified on-chain, `sovereign.lortnoctahc.eth`:**

| | |
|---|---|
| owner | `0x2e7720B37935fceEDc27482a4c00A0E46F692c6a` (derived) |
| payer | `0x61eE2fBcf2841d9094e2D42406Dd4f83a7981Bb8` (MetaMask) |
| owner nonce on Sepolia | **0** — has never sent a transaction |
| owner balance | 0.002 ETH — the relayer's gas stipend, nothing from the payer |
| link between them | none on any chain |

**R2 verified cryptographically, not by inspection.** The `message` burned into the ticket equals
`ticketMessage('sovereign', owner, suiAddr, <the pubkey actually published on-chain>)` exactly:
`1025639938305333059604001686173824532763315114125971700602088378496080816`. The relayer therefore
could not have published a key it controlled — the proof pins it.

**Idempotency proven the hard way:** a session died mid-flow, leaving a burned ticket. The claim
still completed, because `/claim` treats the on-chain ticket as the receipt and resumes from it.

## P1.7 — THE LOOP IS CLOSED ✅ (paid → proof → relayer → ENS)

Paying now *cryptographically* buys the handle. The link is a Groth16 proof, not a boolean.

- **`shared/ticket.mjs`** — ONE implementation of the ticket binding, imported by the app, the CLI
  and the relayer. Binds `(label, evmAddr, suiAddr, **pubkey**)`.
  ⚠️ The pubkey was **not** bound before this change: a relayer could have published a key it
  controlled and read every message sent to that handle. Hole closed, and the app re-verifies the
  published key after claiming.
- **`relayer/`** — live at **`https://lortnoc-relayer.fly.dev`** (`/health` → `ok: true`).
  Burns the ticket on 0G, issues the handle on Sepolia, pays the Sui stipend. Idempotent: a retry
  after a partial failure resumes instead of double-spending.
- **`app/src/lib/live/proof.ts`** — Groth16 proving in the browser, its own 83 kB chunk.
- **`claimHandlePaid`** — verifies the relayer's member set against the on-chain root *before*
  proving, and verifies the published pubkey *after* claiming.

**The claimant never burns their own ticket.** Semaphore hides *which* commitment a proof came
from, not *who submitted it* — if the paying wallet burned it, "X paid" + "X burned nullifier N"
would collapse the anonymity set to one. The relayer submits; the user's whole on-chain footprint
is the bridge and the payment.

**Proven end to end across three chains, one HTTP request:**
```
{ "handle": "founder.lortnoctahc.eth",
  "spendTx":   "0x92e3d929…",   <- 0G: ticket burned
  "claimTx":   "0x011e0a7f…",   <- Sepolia: handle issued
  "stipendTx": "3h7Vqzfo…" }    <- Sui: storage funded
```
`founder.lortnoctahc.eth` is owned by `0xECcc891ccf7C009C2e07b31f659F844ccf6e2e36` — **nonce 0 on
Sepolia, 0 ETH, 0 0G.** It has never sent a transaction anywhere. Its `eth.lortnoc.pubkey` is
exactly the key that was bound into the proof.

**Attacks tested and rejected:** replaying the burned ticket for a different label -> rejected;
redirecting the handle to another address -> rejected. Both caught by the binding check, before gas.

## P1.6 — REAL MONEY, 0G MAINNET ✅

Membership is deployed on **0G mainnet (16661)** and collecting actual value.

| | Address |
|---|---|
| `LortnocMembership` | `0xe9031484b6fd4f55bf94dc5b768f7031b04be3d6` |
| `Semaphore` | `0xd21f911570aad19d39e750fe0aa4e2ad161cbdd5` |
| `SemaphoreVerifier` | `0x87997f3ca40693fb1e0c3c6f39f0f3fe287b8c67` |
| `PoseidonT3` | `0x114e261b9d901aaea199544539c9873dc93565ef` |

Price **5.666942 0G = $1.00** (set from the live rate at deploy; `setPrice` repegs it).
Whole deploy cost **$0.020**. A real membership has been paid: `memberCount` = 1.
The contract holds **0 balance** — `join()` forwards every payment to the treasury immediately,
so fees never sit in the contract.

**Onboarding is two transactions, and both are proven on mainnet:**
1. **Bridge** — LI.FI (`gasZipBridge`), any of Ethereum/Base/Arbitrum/Optimism → native 0G.
   Measured live: **0.0035 ETH → 35.78 0G in 20 seconds, $0.13 gas.**
2. **Pay** — `join()` on 0G inserts your Semaphore commitment.

UI: `app/src/ui/Membership.tsx` — priced in dollars, polls until the bridge actually credits
(the source tx confirming is not the finish line), adds the 0G network to the wallet if missing.
The paywall only renders in live mode with the contract deployed; demo and free tier bypass it.

⚠️ **Treasury is currently the deploy key** (`0x61eE…1Bb8`), whose private key lives in a fly
container env. Move it with `setTreasury` + `transferOwnership` before collecting at any scale.

## P1.5 — The freemium model, wired end to end ✅

**Payment = membership = handle = storage allowance**, across three chains, demonstrated live:

1. **Pay** on 0G — `join()` inserts your Semaphore commitment. The chain sees *a wallet paid* and *the tree grew*.
2. **Prove** — a Groth16 proof burns a nullifier. Its public message binds `(label, evm addr, sui addr)`, so
   nobody — including the relayer — can redirect the claim.
3. **Claim** — the relayer sees the burned ticket and calls `claimFor` on Sepolia. Payer ≠ claimer (§8 Layer 1).
4. **Stipend** — SUI + WAL land in the claimant's storage account. That is what the membership actually buys.

**Proof it works:** `paidmember.lortnoctahc.eth` is owned by `0x7315aF7728e9de93772864d3CB263910789776AA`, a wallet
with **nonce 0 on Sepolia, 0 ETH, 0 0G** — it has never sent a transaction on any chain, and it owns a paid handle
with its own factory-verified resolver. The payment and the handle exist on-chain with no link between them.

**Honest limits:** the relayer is a trust assumption — it cannot forge or redirect a claim (the nullifier is burned
on 0G, the message is bound), but it can censor or stall; anyone can run one. Testnet "revenue" is symbolic.

---

**Where we stand:** P0 hero demo live. ENS v2, Sui/Walrus/Seal and 0G membership all on-chain and asserted.
The paid loop is closed across three chains. Knock and native-mode DM are built. The suite (P3) now gates
all of it in CI.

**Remaining, in the order it matters:**

1. **The <3-min demo video** — a hard 0G prize requirement, and nothing else unblocks it.
2. **Relayer tests** — the one component holding a funded key with zero coverage.
3. **Discoverability enforcement** — the records exist; the conditional-resolution gateway that makes the
   ladder real does not. This is the ENS "Most Creative Use" claim, so the gap is worth either closing or
   stating plainly on the booth.
4. **§12 Q1 — continuity eligibility.** Still unanswered, worth ~$8.5k, and it is a question for the
   organisers rather than a build task. Ask before it stops mattering.

---

## How to keep this file honest

This checklist and CLAUDE.md §2 both drifted badly enough to be actively misleading — CLAUDE.md said
"Pre-code" beside three live deployments, and this file listed Knock and native DM as unbuilt after they
shipped. Reviewing against a stale doc produces confidently wrong conclusions, which is how a completed
feature gets re-planned.

**Rule: a status claim cites the file that backs it.** "Knock — done" is unfalsifiable; "Knock — done,
`app/src/lib/live/knock.ts` + relayer `POST /knock` + `IdentityPanel.tsx`" can be checked in ten seconds and
goes red the moment someone deletes it. Prefer `[~]` with an explicit split over a binary tick when only
half a thing exists — the discoverability entry above is the model.
