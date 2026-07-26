# Lortnoc DM — going live (ENS Sepolia + Sui testnet)

**Live is the default** — the deployed app connects a real wallet, takes a real membership payment
on 0G mainnet, and claims a real handle on Sepolia. `?mock` opts down to the offline demo (real
crypto, localStorage transport, no chain, nothing spent), which is what to use for UI work.

The ENS day-0 work is scripted end to end; the resulting addresses live in
`src/lib/live/ens-deployment.json`, which is what arms the app's live mode. This document is the
runbook — for the first run, and for reproducing it on a rotated deployment or a second
environment.

## A. ENS identity (Sepolia) — one command

```bash
cd contracts && forge build && cd ..
PRIVATE_KEY=0x… node scripts/ens/deploy.mjs --yes     # or put PRIVATE_KEY in .env.local
```

Idempotent — safe to re-run after a failure, it skips whatever is already on-chain. It:

1. **preflights** the pinned ENS v2 addresses (`eth_getCode` on all eight) against tag
   `sepolia-deployment-2026-06-29`, and refuses to continue if any rotated;
2. **mints MockUSDC** — `.eth` registration is priced in an ERC-20, not ETH, and that mock has an
   open `mint()`, so there is no faucet to chase;
3. deploys **LortnocRegistry**, a `UserRegistry` proxy from the canonical `VerifiableFactory`;
4. registers **`lortnoctahc.eth`** (commit → wait 60s → reveal) with that registry as its
   subregistry, so `*.lortnoctahc.eth` resolves through us;
5. registers **`lortnoc.eth`** as well — that is what makes the `eth.lortnoc.*` text-record
   namespace (§5.4) a name we actually own rather than a borrowed prefix;
6. deploys **LortnocRegistrar** and grants it `ROLE_REGISTRAR` — and nothing else — so any wallet
   can claim a handle without us in the loop.

Rebuild afterwards and live mode is armed.

### Check and demo

```bash
node scripts/ens/status.mjs                          # read-only health check, no key needed
node scripts/ens/status.mjs alice                    # ...plus one handle's records
PRIVATE_KEY=0x… node scripts/ens/claim.mjs alice     # claim from the CLI (same path the app uses)
PRIVATE_KEY=0x… node scripts/ens/demo.mjs alice      # the delegation walkthrough, asserted
```

`demo.mjs` is the one to run before showing anyone anything: it delegates `eth.lortnoc.inbox` to a
gateway, proves on-chain that the gateway can write that record and **not** `pubkey` or `walrus`,
revokes in one transaction, and proves the write dies with it. It exits non-zero if any leg fails.

### Dry-running against a fork

The whole sequence was validated against real ENS v2 code on a fork before touching Sepolia:

```bash
anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com &
PRIVATE_KEY=0x… RPC_URL=http://127.0.0.1:8545 node scripts/ens/deploy.mjs --yes --fork
```

`--fork` warps past the 60-second commitment wait instead of sleeping. **Use a fresh random key**,
not anvil's default account — `0xf39F…2266` has contract code deployed on real Sepolia that isn't
an ERC-1155 receiver, so registering a name to it reverts on a fork.

### Gotchas that cost time

- Use `authorize*Roles`, **not** `grantRoles` — the latter is `pure` on the resolver and always
  reverts (`EACCannotGrantRoles`).
- Roles gate **writes only**. Records are world-readable; read-gating is the offchain gateway's
  job (§6.5 discoverability), a separate mechanism.
- EAC forbids removing the last assignee of a role, so `LortnocRegistrar.claim` grants the user
  their roles *before* revoking its own.
- `deployProxy` salts with `keccak256(msg.sender, salt)`, so a handle's resolver address is
  predictable from its label — but only for the same deployer.

## B. Sui + Walrus store (testnet) — still pending

1. **Publish the Move package:**
   ```bash
   cd app/contracts/move
   sui client publish --gas-budget 100000000
   ```
   Put the package id in `VITE_SUI_PACKAGE`.
2. **Fund the store signer.** The app derives a Sui Ed25519 keypair from your MS (no separate Sui
   wallet). On first live connect, log `suiSigner().kp.toSuiAddress()` and send it testnet
   **SUI** (faucet.sui.io) + **WAL** (swap SUI→WAL at stake.walrus.site).
3. Walrus uses Mysten's public testnet upload relay — nothing to host.

## C. Run live

```bash
cp .env.example .env.local    # optional — only for a custom RPC or gateway address
npm run dev
# open http://localhost:5273/  → live by default; MetaMask on Sepolia
# open http://localhost:5273/?mock → offline demo, no chain, nothing spent
```

Claiming sends one transaction that deploys your own resolver proxy, publishes
`eth.lortnoc.pubkey`, hands you every role on it, and registers the subname. The identity panel
then reads your permission table straight off that resolver.

## What's proven vs pending

- **ENS:** registry + registrar deployed, both names registered, one-tx claim, per-record
  delegation and revocation, `verifyContract` handle proof, and resolution through
  `UniversalResolverV2` (RootRegistry → eth → lortnoctahc → LortnocRegistry → handle → resolver).
- **Crypto:** the whole UX and real E2E crypto (ECDH + AES-SIV), identical in mock and live — only
  the transport differs.
- **Pending:** the Sui/Walrus half — Move package publish, blob write/read, and Seal's
  `seal_approve` policy (storage currently uses our own AES-SIV; Seal is the marked next layer in
  `src/lib/live/sui.ts` and the Move `seal_approve` stub).
