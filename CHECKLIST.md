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
      identity — proven by dry-run: member approved, stranger refused, cross-conversation identity refused.
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
      *Open:* nullifier-gating (`gate` hook present, unset) and the discoverability/knock gateway.

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

**Where we stand:** P0 hero demo live; ENS v2, Sui/Walrus/Seal and 0G membership all **on-chain and asserted**.
Remaining: the **<3-min demo video**, the browser click-through of `?live`, and P2 polish.
