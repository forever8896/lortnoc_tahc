# app — Lortnoc DM (the native messenger)

The web app you convert to: **ENS handle = identity + inbox**, messages **encrypted to your key**.
Vite + React + TS, styled to match `site/index.html` (dark, Signal-green, Jost/Questrial). See
`docs/PRD-webapp.md`.

## Run

```bash
npm install
npm run dev        # http://localhost:5273
npm run build      # tsc + vite build
```

## Architecture

Everything goes through one `Backend` interface (`src/lib/backend.ts`), with two implementations:

- **`MockBackend`** (`src/lib/mock.ts`) — **default, fully working.** Real end-to-end crypto (X25519 ECDH
  + AES-SIV, the same `src/lib/crypto.ts` as the extension) over a **localStorage "network"**. Two tabs of
  the same browser share localStorage → they act as two real users chatting, genuinely encrypted. Only the
  *transport* is mocked (localStorage instead of Walrus/Sui).
- **`LiveBackend`** (to add, `src/lib/live.ts`) — real **ENS v2** (viem, pinned Sepolia addresses) for
  claim/resolve/delegate/verify, and **Sui/Walrus/Seal** for the message store. Swap in behind the same
  interface; the on-chain txs are validated in-browser with a wallet.

## Screens (`src/ui/`)

- **Auth** — connect (wallet-sign → MS → keys; mock generates a fresh keypair per tab).
- **Claim** — pick `<name>.lortnoc.eth`, live availability, publish your pubkey.
- **Messenger** — conversation list + **Thread** (bubbles, compose, tap a message to see "stored
  Seal-encrypted on Walrus") + **IdentityPanel** (the ENS creative demos: delegate-inbox, `verifyContract`).

## Try it (two-tab demo, no wallet)

1. Tab A → Connect → claim `alice` → leave it open.
2. Tab B (same browser) → Connect → claim `bob` → message `alice`.
3. Watch the message appear in Tab A, decrypted. Real ECDH + AES-SIV; localStorage is the "network".

## Status vs PRD

- **M0–M3 built & running in mock:** design system, Auth/Claim/Messenger/Thread/Identity, real crypto,
  end-to-end send/receive, poll refresh. `npm run build` clean.
- **Live path (M1 ENS, M2 Sui):** `LiveBackend` is the next brick — wire viem (ENS v2 Sepolia, wallet has
  0.9 test ETH) + `@mysten/sui|walrus|seal`, validated in-browser. Interface is ready; UI won't change.
