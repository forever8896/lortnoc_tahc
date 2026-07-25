# PRD — Lortnoc DM (app.lortnoctahc.com): the native messenger

## Context

The Telegram extension is the **on-ramp**; **Lortnoc DM** is the **destination** — our own private
protocol where "there is nothing to scan, nothing to subpoena, and nobody to ask" (the landing page's own
words). This is where **ENS and Sui both live**, because they're the two halves of the same product:

> **ENS = who you are** (a handle you hold: identity + inbox + how you get paid).
> **Sui/Walrus/Seal = where your messages live** (an encrypted vault you own and can walk away with).

This PRD covers the whole native-messenger process: onboarding → claim an ENS handle → send/receive
encrypted messages stored on Walrus → the chat UI. It is **P1** (prize coverage for ENS + Sui) and doubles
as the "conversion endgame" (CLAUDE.md §6.6). It reuses the extension's crypto; it does **not** use the
stego codec (Native mode is direct encrypted DM, no cover text needed).

**Funded & ready:** identity wallet `0x61eE…1Bb8` holds **0.9 Sepolia ETH** (ENS v2) + **10 testnet 0G**.
ENS v2 is deployed on Sepolia (pinned addresses in CLAUDE.md §6.5).

---

## 1. Design system (match the landing page exactly)

Extracted from `site/index.html` — the app must feel like the same product: a piece of resistance tech,
not a chirpy chat app. Dark, cinematic, precise.

```
--bg      #08080A   near-black ground
--ink     #EDEAE4   warm off-white text
--signal  #4ADE80   Signal-green — the ONE accent (safe/resolve/action)
--muted   rgba(237,234,228,0.5)
--rule    rgba(237,234,228,0.12)   hairline dividers
--mono    ui-monospace, SFMono, Menlo   (eyebrows/labels: UPPERCASE, letter-spacing .24em)
```
- **Type:** **Jost** 300/400/500 (body/UI), **Questrial** (wordmark), mono for labels/addresses/handles.
- **Buttons:** sharp corners (NO border-radius), Signal-green fill + black text, hover → ink fill.
  `padding: 20px 38px; min-height: 44px`. Ghost variant = outline.
- **Tone:** privacy-first, terse, confident. `::selection` is Signal-green. Generous negative space.
- **Handles/addresses/keys** always in mono. Encrypted/verified states use Signal-green.

## 2. Goals / non-goals

**Goals**
- G1 — **Claim a real ENS handle**: `<name>.lortnoc.eth` on ENS v2 (Sepolia), with the user's messaging
  pubkey published to it. This is the account.
- G2 — **Send & receive encrypted DMs** between two handles, stored on **Walrus** (Seal-encrypted),
  pointer on a **Sui** object. Read your own history back on any device from your keys.
- G3 — **The chat UI** — conversation list + thread + compose, on-brand, mobile-first.
- G4 — **The ENS creative headline** demoed live: per-record write delegation + `verifyContract`.

**Non-goals (this PRD)**
- Realtime relay/libp2p → **poll** the Sui head (CLAUDE.md cut). No presence, no typing indicators.
- Groups, calls, media/attachments, message editing/deletion.
- Multi-writer conversation heads → single-writer-per-conversation for the demo.
- The stego codec (that's the extension's job; Native mode is direct encrypted DM).
- Payments (ERC-5564) → roadmap; the handle *can* receive but we don't build the pay flow here.
- Full mobile PWA packaging → responsive web is enough for the demo.

## 3. Architecture — identity + storage + keys, composed

```
  ┌─ ONBOARD ──────────────────────────────────────────────────────────────┐
  │ connect wallet → sign "lortnoc.eth identity v1" → MS = HKDF(signature)   │
  │ MS → HKDF → K_msg (X25519 keypair) · id_seal (Seal identity)             │  (§5.1)
  └───────────────┬─────────────────────────────────────────────────────────┘
                  ▼
  ┌─ IDENTITY (ENS v2, Sepolia) ────────────────────────────────────────────┐
  │ claim <name>.lortnoc.eth → per-user Permissioned Resolver proxy          │
  │ publish eth.lortnoc.pubkey = K_msg.pub   (this IS the account)           │
  │ [creative demo] authorizeTextRoles(inbox→gateway); pubkey write reverts  │
  └───────────────┬─────────────────────────────────────────────────────────┘
                  ▼
  ┌─ MESSAGING (Sui + Walrus + Seal) ───────────────────────────────────────┐
  │ send(toHandle, body):                                                    │
  │   resolve toHandle → their eth.lortnoc.pubkey                            │
  │   K_conv = HKDF(ECDH(my K_msg priv, their pub))   ← same math as §5.3    │
  │   blob = Seal.encrypt(Quilt.batch([Message]))  → Walrus.writeBlob        │
  │   ConversationHead (Sui object).headBlobId = blobId ; seq++              │
  │ read: poll head → Walrus.readBlob → Seal.decrypt(id_seal) → render       │
  └─────────────────────────────────────────────────────────────────────────┘
```

**The elegant reuse:** peer-key discovery is the *same ECDH* as the extension's Tier-1/Tier-2 (§5.3) — the
only difference is the peer's pubkey comes from their **ENS record** (authenticated, MITM-closed) instead
of an in-band handshake. `deriveConvKey` from the extension's `crypto.ts` is reused verbatim. Extract the
extension's crypto into a shared `packages/crypto` both surfaces import.

## 4. Screens & flows (the actual UI)

**A. Landing/auth (`/`)** — dark hero, wordmark, one line ("Your identity. Your inbox. Yours."), a single
Signal-green **Connect wallet** button. On connect → sign → derive keys → route to claim or inbox.

**B. Claim handle (`/claim`)** — shown if no handle yet. Mono input `____.lortnoc.eth`, live availability,
one **Claim** button. On claim: deploy/assign the Permissioned Resolver, write `eth.lortnoc.pubkey`.
Progress states in Signal-green ("resolver deployed → pubkey published → you're live").

**C. Inbox (`/app`)** — the messenger. Two-pane on desktop, stacked on mobile:
- **Left:** conversation list — peer handle (mono), last-message preview (decrypted), timestamp. A
  **New message** button (enter a `*.lortnoc.eth` handle).
- **Right:** thread — decrypted bubbles (yours right/Signal-tinted, theirs left), compose bar with a
  Signal-green **Send**. A small **🔒 lock + "stored encrypted on Walrus"** affordance; clicking a message
  reveals its Walrus blob id + "Seal-encrypted" (the "your data, portable" proof).
- **Header:** your handle + a **verify** chip → runs `verifyContract(resolver)` and shows "resolver is
  genuinely factory-deployed" (the trustless-identity headline).

**D. Identity settings (`/me`)** — your records (pubkey, walrus pointer), and the **ENS creative demo**:
a "Gateway can rotate my inbox pointer — and nothing else" panel that (1) delegates `eth.lortnoc.inbox`
via `authorizeTextRoles`, (2) shows a `pubkey` write **reverting**, (3) **revokes** in one click.

## 5. ENS v2 integration (Sepolia — funded, pinned)

Per CLAUDE.md §6.5. **Pin the `2026-06-29` deployment; `eth_getCode` before building.** Use **viem**.
- **Day-0 (once):** own `lortnoc.eth` in the v2 `ETHRegistry` (commit→reveal, MockUSDC). Slot our subname
  registry under it, or issue subnames via the registrar path.
- **Per handle:** `VerifiableFactory.deployProxy(PermissionedResolverImpl, salt, init)` → the user is admin
  → `setResolver` → `setText("eth.lortnoc.pubkey", <K_msg.pub hex>)`.
- **Resolve a peer:** `UniversalResolverV2.resolve(name, …)` → their `eth.lortnoc.pubkey`.
- **Creative demo (the ENS prize):** `authorizeTextRoles(name, "eth.lortnoc.inbox", gateway, true)` →
  gateway can write ONLY inbox; a `pubkey` write reverts; user revokes (`grant=false`). Plus
  `verifyContract(proxy)` → returns the impl (compare off-chain) = trustless handle proof.
- **⚠️ gotchas:** use `authorize*Roles`, NOT `grantRoles` (reverts on resolver); role constants are concrete
  in `PermissionedResolverLib.sol`. Wallet `0x61eE…1Bb8` has 0.9 Sepolia ETH — enough for the demo txs.

## 6. Sui + Walrus + Seal integration (message store)

Per CLAUDE.md §6.4. **testnet.** SDKs: `@mysten/sui`, `@mysten/walrus`, `@mysten/seal`.
- **Move module:** `ConversationHead { id, participants:[handle], headBlobId, seq, updatedAt }` — a shared
  object per conversation (single-writer for the demo). Publish once.
- **`seal_approve` policy (LEAD WITH THE FALLBACK):** gateway issues a short-lived **Seal session key** on
  a valid check → decryption. The nullifier-in-`seal_approve` version is the stretch (verify at
  registration, cheap set-membership in `seal_approve`) — do NOT verify a ZK proof inside `seal_approve`.
- **Write:** `Message` (§5.4) → `Quilt.batch` → `Seal.encrypt` → `Walrus.writeBlob` (Mysten's public
  testnet upload relay — no need to host) → set `ConversationHead.headBlobId`, `seq++`.
- **Read:** poll the peer's/your `ConversationHead` → `Walrus.readBlob(headBlobId)` → `Seal.decrypt`
  (`id_seal`) → render. Get WAL by swapping testnet SUI→WAL at `stake.walrus.site`.
- **Manifest:** a Walrus blob listing your conversations, pointer stored in `eth.lortnoc.walrus` — enables
  "log in on any device → resolve your handle → find all your threads."

## 7. Sign-in & key derivation (no server account — §5.5)

1. Connect wallet → sign the fixed domain string → `MS = HKDF(signature)` (deterministic, RFC 6979).
   *(Passphrase fallback for non-deterministic signers.)*
2. `MS` → HKDF → `K_msg` (X25519), `id_seal`. Raw keys never leave the device.
3. Resolve your handle (cached or ENS reverse) → `eth.lortnoc.walrus` → manifest → heads → blobs →
   `Seal.decrypt` → render. Same secret on any device ⇒ same account.
4. **Invariant:** the identity wallet (signs `MS`) ≠ the payment wallet (§4). Enforce in the connect UX.

## 8. Stack

```
app/                      # Vite + React + TypeScript (mobile-first, matches site tokens)
  src/lib/ens.ts          # viem: claim, resolve, authorizeTextRoles, verifyContract (pinned addrs)
  src/lib/store.ts        # @mysten/sui + walrus + seal: write/read/head, seal_approve session key
  src/lib/identity.ts     # connect+sign → MS → HKDF keys (reuses packages/crypto)
  src/ui/…                # Auth · Claim · Inbox · Thread · Identity (design tokens from the site)
packages/crypto/          # extracted from extension: HKDF, AES-SIV, X25519 deriveConvKey (shared)
contracts/move/           # ConversationHead + seal_approve module
```
- **Reuse:** lift the extension's `content/crypto.ts` into `packages/crypto` and import in both.
- **Wallet:** wagmi/viem connectors for the EVM (ENS) side; `@mysten/dapp-kit` for Sui signing.

## 9. Milestones (sliced so each demos something; de-risk first)

- **M0 — Preflight (½ day).** `eth_getCode` the pinned ENS v2 addresses; publish the `ConversationHead`
  Move module on Sui testnet; get WAL. Extract `packages/crypto`. Scaffold the Vite app with the design
  tokens (dark shell + Signal-green button) so it *looks* right from commit one.
- **M1 — Identity (ENS).** Connect wallet → sign → claim `<name>.lortnoc.eth` → publish `pubkey`. Resolve
  another handle → its pubkey. **Demoable ENS submission on its own.**
- **M2 — Store round-trip (Sui).** `send()`: encrypt → Walrus → head bump. `read()`: poll → decrypt →
  render, in a bare list. **Demoable Sui submission on its own.**
- **M3 — The messenger UI.** Wire M1+M2 into the Inbox/Thread screens; resolve peer by handle; poll for new.
  Two handles hold a real encrypted conversation.
- **M4 — Creative flourishes.** `verifyContract` chip; the per-record role delegate/revoke panel (`/me`);
  the "stored on Walrus" blob-id reveal. **These are the ENS-prize + Sui-prize money shots.**
- **M5 — Conversion loop.** From the extension's CTA, land on `/claim` prefilled with the Telegram username
  → one-tap handle. Closes the vampire-attack story.

**Cut order if behind:** M5 → M4 flourishes → the polling niceness. Never cut M1/M2 (they *are* the two
prizes). M1 alone = ENS submission; M2 alone = Sui submission; M3 makes it a product.

## 10. Verification

- **ENS:** claim writes a real `pubkey` record resolvable via `UniversalResolverV2`; `authorizeTextRoles`
  lets the gateway set `inbox` but a `pubkey` write **reverts**; revoke removes it; `verifyContract(proxy)`
  returns `PermissionedResolverImpl`. All on Sepolia with the funded wallet.
- **Sui:** integration test — `Seal.encrypt`→`writeBlob`→`readBlob`→`Seal.decrypt` returns the original;
  a failing `seal_approve` denies; `ConversationHead.seq` increments on send.
- **End-to-end:** two handles (two browser profiles / two wallets) exchange messages; each reads its own
  history fresh after a reload purely from wallet-sign → keys → resolve → decrypt (no server state).
- **Design:** side-by-side with `site/index.html` — same bg/ink/signal, Jost/Questrial, sharp Signal-green
  buttons. It should read as the same product.

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| ENS v2 contracts unfrozen / addresses rotate | Pin `2026-06-29`; `eth_getCode` preflight; don't `git pull main` of the ENS repo mid-hack |
| `grantRoles` reverts on the resolver | Use `authorize*Roles` wrappers (CLAUDE.md §6.5) |
| Seal used as a plain encrypt-lib (buys nothing) | Ship a real `seal_approve` **policy** (session-key fallback at minimum) |
| Move/Sui learning curve eats time | M2 is the smallest possible round-trip; keep the head single-writer |
| No realtime → feels static | Poll every few sec; frame as "durable log, not a bus"; short demo threads |
| Two chains (ENS on Sepolia, store on Sui) in one flow | They're decoupled — identity resolves independently of storage; wire via the pubkey/manifest pointers only |
| Scope creep vs the live extension demo | This is P1; never let it steal hours from the working P0 hero demo |

---

**Bottom line:** M1 (ENS identity) and M2 (Sui store) are each a standalone prize submission; M3 fuses them
into **Lortnoc DM** — the messenger the landing page promises. Build identity and storage as independent
slices, then wire them through the pubkey + manifest pointers, dressed in the site's design system.
