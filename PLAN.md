# lortnoc_tahc — Real ENS v2 Identity Layer (decision walkthrough + build plan)

## Context

Earlier I told you to treat ENS v2 as "narrative only" and demo on v1 (audit finding CF-2), because I believed the
v2 contracts were unfrozen vapor. **That was wrong, and you were right to push.** Two independent source-level
investigations confirm ENS v2 is **deployed, permissionless, and callable on Sepolia today** — repo
`ensdomains/contracts-v2`, deployment snapshot **2026-06-29** (chainId 11155111). The "custom permission sets" you
were drawn to (per-record write delegation via the Permissioned Resolver + Enhanced Access Control) are **real,
concrete in source, and demoable this weekend.** This plan makes them the load-bearing ENS story.

**Decisions locked:** Q2 → **Full v2 identity layer** (per-user permissioned resolver + per-record roles +
`verifyContract` + `setAlias`). Q1 → **on-chain v2, nullifier-gated + relayed**, with the free tier preserved (free
messaging needs no handle; sponsored handles cost the user nothing; free-tier handles are intentionally non-anonymous
per §8). This **reverses audit finding CF-2** for the ENS layer while keeping CF-1 (codec local), CF-3 (see below),
CF-4, CF-5 intact.

**One precision that shapes the design:** v2 permission sets gate **who can WRITE/edit each record** (delegation,
least-privilege, revocable — genuinely "how users want to operate"). They do **not** gate reads — on-chain records
are world-readable. So the per-caller *discoverability* read-gating (§6.5 discoverability ladder) stays a **separate
offchain gateway concern**; do not conflate it with EAC roles. Both coexist; they are different mechanisms.

---

## 1. What's real on Sepolia (verified in source — pin these)

Deployment snapshot tag `sepolia-deployment-2026-06-29`. **Hardcode these; do not `git pull main` mid-hack** (repo
changes daily; addresses rotate ~monthly). `eth_getCode`-check each before spending build time.

| Contract | Sepolia address | Role in our build |
|---|---|---|
| `PermissionedResolverImpl` | `0x7e4b2d59938930168024201752ee5503df402303` | shared impl; each user gets a proxy of this |
| `VerifiableFactory` | `0x118bc31a50d559f7015a8da26d54b3b030cdb70f` | deploys per-user resolver proxies; `verifyContract` |
| `ETHRegistry` | `0x67b728a792e789a8978b30cf1b3b641f19354b43` | where `lortnoc.eth` lives in v2 |
| `ETHRegistrar` | `0xa4449a0dd2b83007553d9b1d28b583a46a805a30` | register `lortnoc.eth` (commit-reveal, mock-ERC20) |
| `UniversalResolverV2` | `0x85edf8b6b7d4211e2b07aa687506b746357b92cf` | resolution entrypoint (applies aliasing) |
| `UserRegistryImpl` | `0x840fa461059862ea466a711e8c98c8de732061c0` | clone via factory for our subname registry |
| `MockUSDC` / `MockDAI` | (in deployments dir) | payment token for `.eth` registration on Sepolia |

**Concrete role constants** (`PermissionedResolverLib.sol` — NOT placeholders):
`ROLE_SET_ADDR=1<<0`, `ROLE_SET_TEXT=1<<4`, `ROLE_SET_CONTENTHASH=1<<8`, `ROLE_SET_PUBKEY=1<<12`,
`ROLE_SET_ABI=1<<16`, `ROLE_SET_INTERFACE=1<<20`, `ROLE_SET_NAME=1<<24`, `ROLE_SET_ALIAS=1<<28` (root-only),
`ROLE_CLEAR=1<<32`, `ROLE_SET_DATA=1<<36`; **admin(role) = role<<128**. Per-record resource =
`keccak256(abi.encode(node, part))`, `part = keccak256(key)`.

**Real signatures we call:**
```solidity
// Permissioned Resolver (per-record WRITE delegation — the flagship)
function authorizeTextRoles(bytes toName, string key, address account, bool grant) external returns (bool);
function authorizeAddrRoles(bytes toName, uint256 coinType, address account, bool grant) external returns (bool);
function setAlias(bytes fromName, bytes toName) external;   // root-only; args DNS-encoded bytes
function initialize(address admin, uint256 roleBitmap, bytes[] setters) external;
// Verifiable Factory
function deployProxy(address implementation, uint256 salt, bytes data) external returns (address);
function verifyContract(address proxy) external view returns (address implementation);  // NO expectedImpl arg
// Registry hierarchy
function register(string label, address owner, IRegistry registry, address resolver, uint256 roleBitmap, uint64 expiry) external returns (uint256);
function setResolver(uint256 anyId, address resolver) external;
function setSubregistry(uint256 anyId, IRegistry registry) external;
```

**Two gotchas that will burn time if missed:**
1. On the resolver, `grantRoles`/`revokeRoles` **revert** — you MUST use the `authorize*Roles` wrappers.
2. `.eth` registration is priced in an **ERC-20 (MockUSDC/DAI), not ETH**, behind a **commit→wait→reveal** delay.
   This applies to registering `lortnoc.eth` itself (day-0, once) — not to our own subname issuance.

Sources: `github.com/ensdomains/contracts-v2` (`contracts/src/resolver/PermissionedResolver.sol`,
`.../libraries/PermissionedResolverLib.sol`, `.../access-control/EnhancedAccessControl.sol`,
`.../registry/interfaces/IRegistry.sol`, `contracts/deployments/sepolia/`),
`github.com/ensdomains/verifiable-factory`.

---

## 2. The architecture — a real v2 self-sovereign identity per handle

1. **Day-0:** register `lortnoc.eth` in the v2 `ETHRegistry` on Sepolia (commit-reveal + MockUSDC). One-time.
2. **`LortnocRegistry` (custom `IRegistry`)** — clone `UserRegistryImpl` via `VerifiableFactory`, slot it under
   `lortnoc` (`setSubregistry`). Its issuance path verifies an **unspent Semaphore nullifier** (proof settled on 0G;
   `seal_approve`-style cheap set-membership check, verification done at registration) → mints the subname token to
   the claimer. **The claim tx is relayed/sponsored** (paying wallet ≠ claiming wallet) → payment↔handle stays
   ZK-unlinkable, and the user pays no gas (free-tier-friendly).
3. **Per-user Permissioned Resolver** — `VerifiableFactory.deployProxy(PermissionedResolverImpl, salt, initData)`
   with the user as `admin`; set it as the subname's resolver. This is the user's sovereign identity contract.
4. **Publish records** and **delegate per-record write roles** (the "custom permission sets"):

   | Record | Who holds write role | Mechanism |
   |---|---|---|
   | `eth.lortnoc.pubkey` | **user only** (keeps `ROLE_SET_TEXT` admin) | never delegated — identity key |
   | `eth.lortnoc.stealth` | user only | payments meta-address |
   | `eth.lortnoc.inbox` | **sync gateway** (write-only, this key) | `authorizeTextRoles(name,"eth.lortnoc.inbox",gateway,true)` |
   | `eth.lortnoc.discoverable` | **indexer** (write-only, this key) | `authorizeTextRoles(name,"eth.lortnoc.discoverable",indexer,true)` |
   | `eth.lortnoc.walrus` | user only | vault pointer |

   This is the demoable headline: *"the gateway can rotate my inbox pointer and nothing else — it cannot touch my
   pubkey, my vault, or my payment address, and I can revoke it in one tx."* Least-privilege as a live property.
5. **`verifyContract(proxy)`** — a counterparty proves your resolver came from the canonical factory (returns the
   impl; compare to `PermissionedResolverImpl` off-chain) = **trustless handle proof**, no trust in our backend.
6. **`setAlias(fromName,toName)`** — trial→permanent conversion and public-searchable-face over private-core, both
   real. Keep chains acyclic (2+ cycle = OOG).

**Discoverability read-gating stays offchain** (our CCIP-Read gateway / index), unchanged from the current spec —
it's a read concern, orthogonal to the v2 write-permission sets above.

---

## 3. Two-tier privacy, both on real v2 (honesty preserved)

- **Free tier:** free messaging via in-band handshake (no ENS, no gas). If a free user wants a handle, it's a
  **sponsored** on-chain v2 handle — deliberately **non-anonymous** (metered by Telegram handle, §9). Real v2
  resolver + permission sets, just identified. Demo cost = testnet gas ($0).
- **Paid tier:** on-chain v2 handle via nullifier-gated `LortnocRegistry` + relayed claim → **ZK-unlinkable**. Full
  self-sovereign permission sets.
- **Honest tradeoff vs the old plan:** on-chain issuance forfeits §8 **Layer 0** (zero on-chain footprint). We keep
  **ZK-unlinkability** via nullifier + relayed claim + wallet separation (Layers 1/2/4). State this plainly; it's a
  deliberate trade of one privacy layer for genuine v2 + on-chain verifiability. Scaling knob: free-tier handles can
  fall back to offchain on mainnet to control gas cost (roadmap, not demo).

---

## 4. Weekend build order (ENS track — parallel to codec/Sui/0G)

1. **Preflight (30 min):** `eth_getCode` on `PermissionedResolverImpl`, `VerifiableFactory`, `ETHRegistrar`; pin
   addresses + the `2026-06-29` tag; acquire MockUSDC and Sepolia ETH.
2. **Own `lortnoc.eth`** in v2 `ETHRegistry` (commit→wait→reveal, pay MockUSDC).
3. **Per-user resolver happy path (the core demo):** `deployProxy` a `PermissionedResolver` for one demo handle →
   `setResolver` → user sets `pubkey` → `authorizeTextRoles` delegates `eth.lortnoc.inbox` to the gateway → gateway
   rotates inbox → show it **cannot** write `pubkey` (reverts) → user **revokes** the role (`grant=false`). This
   alone is a truthful, strong "we use ENS v2 permissioned resolver + per-record EAC roles" demo.
4. **`verifyContract`** the proxy → trustless handle-proof in the app UI.
5. **`LortnocRegistry`** (clone `UserRegistryImpl`): nullifier-gated `register()` + relayed claim (integrates the 0G
   Semaphore verifier). This is the anonymity headline; it's the heaviest piece — land steps 3–4 first.
6. **`setAlias`** conversion demo (trial→permanent), if time remains.

**Do NOT** put the on-chain registry (step 5) ahead of the resolver/roles demo (steps 3–4): steps 3–4 are the
feature you actually care about and are far lower-risk.

---

## 5. CLAUDE.md changes to apply after approval (not editable in plan mode)

- **§6.5:** reverse the "v2 = narrative only / demo on v1" framing (my prior CF-2 edit). Re-state v2 as **real,
  deployed on Sepolia**, with the pinned addresses, concrete role constants, and `authorize*Roles` (not `grantRoles`)
  note. Make the per-user Permissioned Resolver + per-record role delegation the **load-bearing** creative use.
- **§6.5 build order:** replace the offchain-only path with the §4 order above (own `lortnoc.eth` in v2 → per-user
  resolver → role delegation → verifyContract → nullifier-gated registry → setAlias). Add the day-0 commit-reveal +
  MockUSDC prerequisite and the address-pinning / `eth_getCode` warning.
- **CF-3 update:** `LortnocRegistry implements IRegistry` is now **on-chain and real** (custom registry under
  `lortnoc.eth`); the contradiction is resolved by choosing on-chain v2 (not offchain). Note the Layer-0 tradeoff.
- **§5.4:** clarify `eth.lortnoc.discoverable` write-delegated to indexer, `eth.lortnoc.inbox` to gateway, via
  per-record roles; keep read-gating offchain.
- **§8:** note the paid tier now forfeits Layer 0 (on-chain issuance) but retains ZK-unlinkability via Layers 1/2/4;
  free-tier handles are non-anonymous by design.
- **§6.5 discoverability model:** add the one-line precision that EAC roles gate **writes**, read-gating is offchain.
- **§11 / §12:** record the locked decision (full on-chain v2 identity layer) and the pinned Sepolia deployment tag.

---

## 6. Risks & mitigations

- **Unaudited, daily-changing repo.** Pin tag `2026-06-29` + hardcoded addresses; `eth_getCode` preflight; never
  pull `main` mid-hack. Testnet demo only — not mainnet-ready.
- **`grantRoles` reverts on resolver** → use `authorize*Roles`. (#1 time-sink if missed.)
- **Commit-reveal + MockERC20** for `lortnoc.eth` registration → do it first, budget the reveal delay.
- **Alias OOG** on 2+ cycles → keep chains acyclic; only demo a cycle deliberately to show the failure.
- **15 assignees/role, 32-role ceiling** → fine for a demo; don't fan delegation out widely.
- **Competes for 48h** → decision is Full v2 identity layer; fund it by trimming polish (native-mode UI, PWA), not
  the hero codec demo or Sui/0G prize minimums.

---

## 7. Verification (how we prove it works)

- **Per-record roles:** integration test — gateway address CAN `setText("eth.lortnoc.inbox",…)` but its
  `setText("eth.lortnoc.pubkey",…)` **reverts**; after `authorizeTextRoles(...,false)` the inbox write also reverts.
- **verifyContract:** `verifyContract(proxy)` returns `PermissionedResolverImpl`; a hand-rolled non-factory proxy
  reverts `VerificationFailed`.
- **Resolution:** `UniversalResolverV2.resolve(name, …)` returns the user's `pubkey`; after `setAlias`, an alias name
  resolves to the target's records.
- **Anonymity (paid):** `LortnocRegistry.register` succeeds with a valid unspent nullifier and reverts on reuse; the
  claim tx sender ≠ the paying wallet (relayer), so no on-chain payment↔handle link.
- **Free tier:** two users message end-to-end via in-band handshake with **no** ENS handle and **no** gas.
- **ENS-booth line:** "We deploy a v2 Permissioned Resolver per handle and use Enhanced Access Control to delegate
  write access to a single text key — the gateway can rotate my inbox pointer and nothing else, revocable in one tx."
