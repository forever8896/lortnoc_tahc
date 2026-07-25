# Lortnoc DM — going live (ENS Sepolia + Sui testnet)

The app runs fully in **mock mode** with no setup. To switch the real chains on, open the app
with `?live` and do the one-time setup below. The identity wallet `0x61eE…1Bb8` already holds
**0.9 Sepolia ETH** and **10 testnet 0G**; you'll also need testnet SUI + WAL for the store.

The code is written against the real SDKs but **has not been run on-chain from the build
sandbox** — validate each step in the browser. Copy `.env.example` → `.env.local` and fill in
the addresses as you go.

## A. ENS identity (Sepolia)

1. **Own `lortnoc.eth`** in the v2 `ETHRegistry` (commit→wait→reveal, priced in MockUSDC).
   Acquire MockUSDC + a small Sepolia ETH balance (have 0.9). One-time, day-0.
2. **Deploy a resolver** for handles. Two options:
   - **Simple (fastest to demo):** deploy ONE `PermissionedResolver` proxy via
     `VerifiableFactory.deployProxy(PermissionedResolverImpl, salt, initData)`, set it as
     `lortnoc.eth`'s resolver, and issue subnames under it. Put its address in
     `VITE_LORTNOC_RESOLVER`.
   - **Full creative (ENS prize):** clone `UserRegistryImpl` → `LortnocRegistry` under
     `lortnoc.eth`; each handle gets its own resolver proxy. Heavier; see CLAUDE.md §6.5.
3. **`eth_getCode`** the pinned addresses in `src/lib/live/config.ts` first (they rotate).
4. Set `VITE_LORTNOC_RESOLVER` → `claim`/`resolve`/`delegate`/`verify` go live.

Gotchas: use `authorize*Roles` (NOT `grantRoles` — reverts on the resolver); `.eth`
registration is MockUSDC + commit-reveal.

## B. Sui + Walrus store (testnet)

1. **Publish the Move package:**
   ```bash
   cd app/contracts/move
   sui client publish --gas-budget 100000000
   ```
   Put the package id in `VITE_SUI_PACKAGE`.
2. **Fund the store signer.** The app derives a Sui Ed25519 keypair from your MS (no separate
   Sui wallet). On first `?live` connect, log `suiSigner().kp.toSuiAddress()` and send it
   testnet **SUI** (faucet.sui.io) + **WAL** (swap SUI→WAL at stake.walrus.site).
3. Walrus uses Mysten's public testnet upload relay — nothing to host.

## C. Run live

```bash
cp .env.example .env.local   # fill VITE_LORTNOC_RESOLVER + VITE_SUI_PACKAGE
npm run dev
# open http://localhost:5273/?live  → MetaMask on Sepolia
```

Claim writes `eth.lortnoc.pubkey` on-chain; sending writes a Walrus blob + bumps the Sui
`ConversationHead`. Two handles (two wallets) then hold a real on-chain-backed conversation.

## What's proven vs pending

- **Proven (mock):** the whole UX + real E2E crypto (ECDH + AES-SIV). The live path reuses the
  identical crypto and UI.
- **Pending your validation:** the on-chain txs (ENS claim/resolve, Walrus write/read, Sui
  object) and Seal's `seal_approve` policy (currently AES-SIV; Seal is the marked next layer in
  `src/lib/live/sui.ts` + the Move `seal_approve` stub).
