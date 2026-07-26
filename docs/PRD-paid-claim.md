# PRD — Paid, unlinkable handle claim (the closing loop)

**Status:** ready to build · **Estimate:** 2.5–3.5h · **Depends on:** nothing unbuilt — every contract
this needs is already deployed and exercised.

---

## 1. What this is

Today the app takes real money on 0G mainnet and then issues an ENS v2 handle on Sepolia. Those two
facts are connected by **a boolean in React state** (`paid` in `app/src/app.tsx`), not by a proof.

This PRD closes that: **paying produces a zero-knowledge ticket, and only a burned ticket can mint a
handle.** When it lands, the demo line becomes:

> "I paid a dollar. My handle was issued to a wallet that has never sent a transaction. Nothing
> on-chain connects the two — and here is the contract that enforces it."

That claim is currently true of `paidmember.lortnoctahc.eth` (issued via CLI). This makes it true of
the product.

### Why it's the winning moment

- **0G** stops being "we deployed a contract" and becomes the settlement layer of a real payment flow.
- **ENS** stops being "we issue subnames" and becomes "subname = bearer capability, unlinkable to
  payment" — the §6.5 use #3 story, live.
- The privacy pitch stops needing an asterisk.

---

## 2. Current state (precise)

### Deployed and working

| Thing | Where | Address |
|---|---|---|
| `LortnocMembership` | 0G mainnet 16661 | `0xe9031484b6fd4f55bf94dc5b768f7031b04be3d6` |
| `Semaphore` | 0G mainnet | `0xd21f911570aad19d39e750fe0aa4e2ad161cbdd5` |
| `LortnocRegistrar` | Sepolia | `0x794ec3b1fb8ad0d23f3f654c20993ba4ff762c19` |
| `LortnocRegistry` | Sepolia | `0x2D95c86bd9a850d95897c604c8EB00131a9C62a5` |
| `conversation` (Move) | Sui testnet | `0xb214da015f1f8f59fb9804f42185782f6f2ce34e398175b060fee266c8074faf` |

Contract surface we need already exists — **no Solidity changes, no redeploys**:

- `LortnocMembership.join(uint256 commitment) payable` — done, exercised with real money.
- `LortnocMembership.spendTicket(SemaphoreProof)` — **permissionless by design**; anyone may submit.
- `LortnocMembership.spent(uint256) view` — idempotency check.
- `LortnocRegistrar.claimFor(string label, string pubkey, address claimant)` — relayer-gated.
- `LortnocRegistrar.isRelayer(address) / setRelayer(address,bool)` — the relayer is already
  authorised (`0x61eE…1Bb8`, set during the CLI run).

### Working, but CLI-only

- `scripts/ens/membership.mjs` — derives `id_sem`, rebuilds the group from `Joined` events, generates
  the Groth16 proof, submits `spendTicket`.
- `scripts/ens/relayer.mjs` — finds the burned ticket on 0G, calls `claimFor` on Sepolia, pays the
  SUI + WAL stipend.
- `scripts/ens/lib/ens.mjs` → `ticketMessage(label, evmAddr, suiAddr)` — the public-signal binding.

### The gap

1. `app/src/ui/Claim.tsx` → `backend.claimHandle(name)` → `LiveBackend.claimHandle` →
   `ens.claimHandle` → `LortnocRegistrar.claim()` — **the free path**, from the user's own wallet.
2. Nothing in the app generates a proof.
3. No relayer is reachable from a browser.

---

## 3. Security model (read before writing code)

Three properties, and each maps to a specific implementation rule. Break a rule and the feature
becomes theatre.

### R1 — The user must NEVER submit `spendTicket` themselves

Semaphore hides *which* commitment a proof came from. It does **not** hide the submitting address.
If the wallet that paid also submits the ticket, an observer sees `X paid` and `X burned nullifier N`,
and `N`'s message contains the handle — the anonymity set collapses to one regardless of crowd size.

**Rule:** the relayer submits `spendTicket`. The user's on-chain footprint is exactly two txs: the
LI.FI bridge and `join()`.

### R2 — The proof must bind the pubkey

`ticketMessage` currently binds `(label, evmAddr, suiAddr)`. It does **not** bind the X25519 messaging
pubkey. A malicious relayer could therefore call `claimFor(label, itsOwnPubkey, claimant)` — the user
gets the handle, but its `eth.lortnoc.pubkey` is a key the relayer controls, and the relayer can read
every message sent to that handle. **This is a live MITM hole and must be closed in this change.**

**Rule:** `ticketMessage(label, evmAddr, suiAddr, pubkeyHex)`. The app must verify after claim that the
on-chain `eth.lortnoc.pubkey` equals its own key, and scream if not.

### R3 — Anonymity is a crowd property, stated honestly

With one member, correlation is trivial (same human bridges, pays, and appears with a handle minutes
later). The guarantee is *"you cannot tell which member's payment maps to which handle"* and it grows
with `memberCount`. Copy must say unlinkability, never invisibility (§8).

### What the relayer can and cannot do

| | |
|---|---|
| **Cannot** forge a claim | No burned ticket ⇒ nothing to relay. |
| **Cannot** redirect a claim | `message` binds label + evm + sui + pubkey; changing any invalidates the proof. |
| **Cannot** read messages (after R2) | The pubkey is bound, and the app verifies it post-claim. |
| **Can** censor or stall | Accepted (§8 Layer 4). Mitigation: `spendTicket` is permissionless and the registrar's relayer set is a list — anyone can run one. |
| **Cannot** learn which payment funded a ticket | Nobody can. That is the product. |

---

## 4. Target flow

```
User (MetaMask + browser)                Relayer (fly)              Chains
─────────────────────────                ─────────────             ──────
1. connect + sign  ──────────────────────────────────────────────► (nothing on-chain)
   MS = HKDF(signature) → id_sem, K_msg, Sui keypair

2. bridge ~$1 ETH ───────────────────────────────────────────────► LI.FI → 0G
3. join(commitment) ─────────────────────────────────────────────► 0G: member tree grows
                                                                    [user's last on-chain act]
4. pick handle
5. GET /group    ───────────────────────►
                 ◄─────────────────────── members[], root
   verify root == on-chain root
6. generate Groth16 proof (browser, ~5-20s)
   message = H(label, evmAddr, suiAddr, pubkey)

7. POST /claim {label, evmAddr, suiAddr, pubkey, proof}
                 ───────────────────────►
                                          verify message binding
                                          spendTicket ───────────► 0G: nullifier burned
                                          claimFor    ───────────► Sepolia: handle issued
                                          stipend     ───────────► Sui: SUI + WAL sent
                 ◄─────────────────────── {handle, txs}
8. poll resolvePubkey(handle) until set
9. VERIFY on-chain pubkey == ours  ← R2
10. → Messenger
```

---

## 5. Concrete changes

### 5.1 `scripts/ens/lib/ens.mjs` — bind the pubkey (R2)

```js
// BEFORE
export function ticketMessage(label, evmAddr, suiAddr) {
  return BigInt(keccak256(encodeAbiParameters(
    [{ type: 'string' }, { type: 'address' }, { type: 'string' }],
    [label, getAddress(evmAddr), suiAddr],
  ))) >> 8n
}

// AFTER — pubkey bound, so a relayer cannot publish a key it controls
export function ticketMessage(label, evmAddr, suiAddr, pubkeyHex) {
  return BigInt(keccak256(encodeAbiParameters(
    [{ type: 'string' }, { type: 'address' }, { type: 'string' }, { type: 'string' }],
    [label, getAddress(evmAddr), suiAddr, pubkeyHex],
  ))) >> 8n
}
```

Update both callers: `scripts/ens/membership.mjs` (add `--pubkey`, default to the demo hash) and
`scripts/ens/relayer.mjs` (take pubkey as argv, stop using `CLAIM_PUBKEY` env fallback).

**Note:** already-burned testnet tickets use the old binding and will no longer match. Fine — mainnet
has one member and no spent tickets.

### 5.2 NEW `app/src/lib/live/proof.ts` — browser proving

```ts
// Semaphore proving, client-side. Artifacts (~3.3MB) come from PSE's CDN and are cached by the
// browser after the first run.
import type { Hex } from 'viem'

export type Ticket = {
  merkleTreeDepth: number
  merkleTreeRoot: string
  nullifier: string
  message: string
  scope: string
  points: string[]
}

/** id_sem (§5.1) → Semaphore identity. Same derivation as membership.ts::commitmentFrom. */
async function identityFrom(ms: Uint8Array) { /* hkdf 'lortnoc/semaphore/v1' → Identity(hex) */ }

export async function generateTicket(opts: {
  ms: Uint8Array
  members: string[]        // from GET /group, root-verified against 0G
  label: string
  evmAddr: Hex
  suiAddr: string
  pubkeyHex: string
  onProgress?: (s: 'loading-artifacts' | 'proving') => void
}): Promise<Ticket>
```

- `scope = keccak256("lortnoc/claim/v1") >> 8` — **fixed**, so one membership ⇒ one nullifier ⇒ one
  handle. That product rule is enforced by maths, not by us.
- `message = ticketMessage(...)` — port from `scripts/ens/lib/ens.mjs`; keep the two in sync or
  extract to a shared module (see §7 risk).

**Vite/bundling:** snarkjs expects some Node globals. Expect to add to `app/vite.config.ts`:
```ts
define: { global: 'globalThis' },
optimizeDeps: { include: ['@semaphore-protocol/proof', '@semaphore-protocol/identity'] },
```
If `Buffer` errors appear, add `vite-plugin-node-polyfills` (buffer only). **Timebox this to 30
minutes** — it is the single most likely thing to eat an evening.

### 5.3 NEW `app/src/lib/live/relayerClient.ts`

```ts
const BASE = import.meta.env.VITE_RELAYER_URL || 'https://lortnoc-relayer.fly.dev'

export async function fetchGroup(): Promise<{ members: string[]; root: string; memberCount: number }>
export async function submitClaim(body: {
  label: string; evmAddr: string; suiAddr: string; pubkey: string; ticket: Ticket
}): Promise<{ handle: string; spendTx: string; claimTx: string; stipendTx?: string }>
export async function claimStatus(label: string): Promise<{ state: 'none'|'pending'|'done'|'failed'; detail?: string }>
```

Every call: 30s timeout, one retry on network error, typed errors surfaced to the UI verbatim.

### 5.4 `app/src/lib/live/membership.ts` — additions

```ts
/** Has this identity already paid? Drives "resume" when someone paid then closed the tab. */
export async function hasPaid(ms: Uint8Array): Promise<boolean>   // isMember(commitmentFrom(ms))

/** Has this identity already burned its ticket? Prevents a doomed second attempt. */
export async function ticketSpent(nullifier: bigint): Promise<boolean>
```

### 5.5 `app/src/lib/backend.ts` — interface change

```ts
export interface Backend {
  // ...
  /** Claim via the paid, unlinkable path. Returns the issued handle. */
  claimHandlePaid(name: string, onStage: (s: ClaimStage) => void): Promise<Identity>
  /** Whether the paid path is available (live mode + membership deployed + relayer reachable). */
  paidClaimAvailable(): Promise<boolean>
}

export type ClaimStage =
  | 'checking-membership' | 'loading-group' | 'proving'
  | 'relaying' | 'waiting-for-ens' | 'verifying-pubkey' | 'done'
```

`MockBackend`: `paidClaimAvailable() → false`, `claimHandlePaid()` throws "demo mode".

### 5.6 `app/src/lib/live.ts` — implement `claimHandlePaid`

```ts
async claimHandlePaid(name: string, onStage: (s: ClaimStage) => void): Promise<Identity> {
  if (!this.ms || !this.kp || !this.id) throw new Error('connect first')
  const label = shortName(name)
  const suiAddr = await this.suiAddress()

  onStage('checking-membership')
  if (!(await hasPaid(this.ms))) throw new Error('no membership found for this identity')

  onStage('loading-group')
  const group = await fetchGroup()
  await assertGroupRootMatchesChain(group)      // never prove against a root the relayer invented

  onStage('proving')
  const ticket = await generateTicket({ ms: this.ms, members: group.members, label,
    evmAddr: this.id.address as Hex, suiAddr, pubkeyHex: this.id.pubkeyHex })

  onStage('relaying')
  await submitClaim({ label, evmAddr: this.id.address, suiAddr, pubkey: this.id.pubkeyHex, ticket })

  onStage('waiting-for-ens')
  const handle = fullHandle(label)
  await pollUntil(() => ens.resolvePubkey(handle), 120_000)

  onStage('verifying-pubkey')                    // R2 — the relayer could have lied
  const onChain = await ens.readText(handle, REC.pubkey)
  if (onChain?.toLowerCase() !== this.id.pubkeyHex.toLowerCase()) {
    throw new Error('SECURITY: the published pubkey is not ours — do not use this handle')
  }

  // Publish the Sui address so peers can address threads to us (existing helper).
  await this.publishSuiAddress()
  onStage('done')
  this.id = { ...this.id, handle }
  return this.id
}
```

**Do not delete** `claimHandle` (free path) — it stays for the free tier and as the fallback if the
relayer is down.

### 5.7 `app/src/ui/Claim.tsx` — stage-aware UI

Detect the paid path with `paidClaimAvailable()`. When true, call `claimHandlePaid` and render stages
instead of a single spinner — proving takes 5–20s and silence reads as a hang:

```
◐ Proving you're a member…            ~15s, in your browser. Your secret never leaves this device.
✓ Proof generated
◐ Issuing your handle…                a relayer pays the gas, so your wallet stays unlinked
✓ paidmember.lortnoctahc.eth is yours
```

Copy for the win, shown on completion:
> Issued to `0x7315…76AA` by a relayer. That wallet has never sent a transaction, and nothing
> on-chain connects it to the payment you just made.

### 5.8 NEW service `relayer/`

```
relayer/
  package.json          # express (or fastify), viem, @mysten/sui, @semaphore-protocol/*
  server.mjs            # the three endpoints
  lib/chains.mjs        # 0G mainnet + Sepolia + Sui clients (port from scripts/ens/lib/ens.mjs)
  Dockerfile            # copy codec/zerog-sidecar/Dockerfile
  fly.toml              # app = "lortnoc-relayer"
  README.md
```

**`GET /health`** → `{ ok, relayer, sepoliaAuthorized, zeroGBalance, suiBalance, walBalance }`.
Deploy is not "done" until `sepoliaAuthorized` is true and both Sui balances are non-zero.

**`GET /group`** → `{ members: string[], root: string, memberCount: number }`
Rebuilt from `Joined` events on 0G, cached 30s. The client re-verifies `root` against
`Semaphore.getMerkleTreeRoot` — the relayer must never be trusted to supply the member set.

**`POST /claim`** — the whole job, and it must be **idempotent** (see §7):

1. Recompute `expected = ticketMessage(label, evmAddr, suiAddr, pubkey)`; reject unless
   `ticket.message === expected`. *(Cheap, and blocks all redirection attempts.)*
2. If `spent(ticket.nullifier)` → skip to 4 (a retry after a partial failure).
3. `eth_call` simulate `spendTicket` first, then submit. Reject invalid proofs without paying gas.
4. If `registrar.available(label)` → `claimFor(label, pubkey, evmAddr)` on Sepolia.
5. Best-effort stipend on Sui (0.05 SUI + 0.05 WAL). **Failure here must not fail the request** —
   the handle is already issued; return `stipendTx: null` and surface it.
6. Return `{ handle, spendTx, claimTx, stipendTx }`.

Rejections: 400 for message mismatch / bad proof, 409 for label taken, 503 if under-funded.

**Secrets (fly):**
```
fly secrets set RELAYER_PRIVATE_KEY=0x…   # Sepolia; must be isRelayer on the registrar
fly secrets set SUI_TREASURY_KEY=suiprivkey…
```
Both are hot keys. Fund thinly and top up — see §7.

### 5.9 `app/src/app.tsx`

Replace the `paid` boolean with real state. Payment status comes from the chain
(`hasPaid(masterSecret())`), not from React:

```ts
const [member, setMember] = useState<boolean | null>(null)
useEffect(() => { /* hasPaid(backend.masterSecret()) */ }, [identity])
const gated = live && membershipReady() && !identity.handle && member === false
```

This also fixes the current "pay, close tab, reopen, get asked to pay again" bug.

---

## 6. Milestones (with a cut line)

| # | Work | Est | Cut line |
|---|---|---|---|
| 1 | R2 pubkey binding across `lib/ens.mjs`, `membership.mjs`, `relayer.mjs`; re-verify CLI flow end to end on testnet | 30m | **Never cut.** This is a live MITM hole. |
| 2 | `relayer/` service + fly deploy + `/health` green | 60m | — |
| 3 | `proof.ts` browser proving (incl. Vite bundling) | 45m | Timebox 30m; if bundling fights back, fall back to a `POST /prove` on the relayer and **say plainly in the demo that proving is server-side for now** |
| 4 | `claimHandlePaid` + `relayerClient.ts` + `app.tsx` state | 30m | — |
| 5 | `Claim.tsx` stages + win copy | 25m | Reduce to one spinner + final copy |
| 6 | End-to-end on mainnet with a fresh wallet | 20m | **Never cut.** |

**Stop-and-ship point:** after milestone 4 the loop is real and provable from the CLI plus the app;
5 is polish.

**Fallback if it all goes wrong:** revert `app.tsx` to the current `paid` boolean. The free path is
untouched throughout, so the app is never broken by this work.

---

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **snarkjs/Vite bundling** | High | Timebox 30m; server-side `/prove` fallback (milestone 3) |
| **Proving too slow on a phone** | Medium | Measure early. If >30s, prove server-side and disclose it |
| **Partial failure: ticket burned, claim not issued** | Medium | `/claim` idempotency (step 2). The ticket is on-chain, so a retry — or *any* relayer — can finish the job. Test by killing the process between steps 3 and 4 |
| **`ticketMessage` drifts between app and scripts** | High | Two copies of a security-critical hash. Either extract to `shared/ticket.mjs` imported by both, or add a test asserting they agree. **Do not skip this** |
| **Relayer hot keys** | High | Fund thin (0.05 ETH Sepolia, 1 SUI, 1 WAL). Compromise costs gas, not user funds — it cannot forge or redirect claims |
| **Relayer down at demo** | Medium | `paidClaimAvailable()` falls back to the free path; the demo degrades to today's behaviour instead of erroring |

---

## 8. Definition of done

- [ ] A fresh wallet with only mainnet ETH completes: bridge → pay → prove → handle, entirely in the browser.
- [ ] The resulting handle's owner address has **nonce 0 on Sepolia**.
- [ ] `eth.lortnoc.pubkey` on-chain equals the app's derived key (R2 verified in-app).
- [ ] The claimant's Sui address holds the stipend, and a message actually sends.
- [ ] A second claim from the same membership **fails** — nullifier already spent.
- [ ] `GET /health` green; `scripts/ens/status.mjs <label>` agrees with the app.
- [ ] `CHECKLIST.md` and `CLAUDE.md` §6.5/§7 updated in the same commit.

---

## 9. Out of scope

Nullifier-gating the registrar (`setGate`) — the relayer enforces payment today and turning the gate
on would break the free tier. Multi-relayer redundancy. Refunds. Repricing automation at member 101
(one `setPrice` call). Seal client-side encryption. The `ConversationHead` cleartext-handle leak.
