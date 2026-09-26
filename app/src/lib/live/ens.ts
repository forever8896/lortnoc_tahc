// ENS v2 client (viem, Sepolia) — the real thing, against the pinned deployment
// (`sepolia-deployment-2026-09-15`, see ens-deployment.json).
//
// Reads go ONLY through viem's getEnsText / getEnsAddress against the stable UniversalResolver
// proxy (0xeeee…eeee, viem's sepolia default) — the exact path ENS's own tools take. There is no
// "direct resolver" fallback any more: the 09-15 PermissionedResolver has no text()/addr()
// getters at all, and a private read path is how, in July, our names worked in our code while no
// ENS tool could resolve them.
//
// Writes:
//   claim        → LortnocRegistrar.claim() — ONE tx that deploys the caller's own
//                  PermissionedResolver proxy whose INITIALIZER writes eth.lortnoc.pubkey + addr
//                  and grants the caller every role, then registers the subname.
//   setters      → 09-15 setters take the DNS-encoded NAME: setText(bytes,…), setAddress(bytes,60,…).
//   delegate     → grantSetterRoles(setText(name, key, ""), account) / revokeRoles(keccak256(key),
//                  ROLE_SET_TEXT, account) — per-KEY write delegation, the ENS v2 flagship (§6.5
//                  use #1). Scope is per resolver + key; with one resolver per handle that is per
//                  handle. (authorizeTextRoles/setAlias/clearRecords no longer exist at 09-15.)
//   owner        → UniversalHelper.findExactOwner(name) — the holder check. Never use addr for it.
//   verify       → VerifiableFactory.verifyContract(proxy) → implementation, compared off-chain.
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  http,
  keccak256,
  namehash,
  stringToHex,
  type Address,
  type Hex,
  type WalletClient,
} from 'viem'
import { sepolia } from 'viem/chains'
import type { Account } from 'viem'
import { ENS, LORTNOC, REC, ROLE_SET_TEXT, assertEnsSetup } from './config'

/** LortnocRegistrar.claim emits this. `claimant` is indexed, so "which handle does this address
 *  own?" is a single filtered log query — see handleOf(). */
const handleClaimedEvent = {
  type: 'event',
  name: 'HandleClaimed',
  inputs: [
    { name: 'label', type: 'string', indexed: false },
    { name: 'claimant', type: 'address', indexed: true },
    { name: 'resolver', type: 'address', indexed: true },
    { name: 'tokenId', type: 'uint256', indexed: false },
    { name: 'node', type: 'bytes32', indexed: false },
  ],
} as const

/** LortnocRegistrar.migrate emits this when a handle is REISSUED to its same owner after an ENS
 *  Sepolia reset (the 09-15 migration reissued 12 handles this way). It is NOT a HandleClaimed, so a
 *  lookup that scanned only HandleClaimed told every migrated user "no handle" and offered to sell
 *  them one (found 2026-09-26). handleOf() scans both. */
const handleMigratedEvent = {
  type: 'event',
  name: 'HandleMigrated',
  inputs: [
    { name: 'label', type: 'string', indexed: false },
    { name: 'claimant', type: 'address', indexed: true },
    { name: 'records', type: 'uint256', indexed: false },
  ],
} as const

// ---- ABIs (only what we call) -----------------------------------------------------------------

const resolverAbi = [
  { type: 'function', name: 'setText', stateMutability: 'nonpayable', inputs: [{ name: 'name', type: 'bytes' }, { name: 'key', type: 'string' }, { name: 'value', type: 'string' }], outputs: [] },
  { type: 'function', name: 'setAddress', stateMutability: 'nonpayable', inputs: [{ name: 'name', type: 'bytes' }, { name: 'coinType', type: 'uint256' }, { name: 'addressBytes', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'grantSetterRoles', stateMutability: 'nonpayable', inputs: [{ name: 'setter', type: 'bytes' }, { name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'revokeRoles', stateMutability: 'nonpayable', inputs: [{ name: 'resource', type: 'uint256' }, { name: 'roleBitmap', type: 'uint256' }, { name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'hasRoles', stateMutability: 'view', inputs: [{ name: 'resource', type: 'uint256' }, { name: 'roleBitmap', type: 'uint256' }, { name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
] as const

const helperAbi = [
  { type: 'function', name: 'findExactOwner', stateMutability: 'view', inputs: [{ name: 'name', type: 'bytes' }], outputs: [{ type: 'address' }] },
] as const

const registryAbi = [
  { type: 'function', name: 'findOwner', stateMutability: 'view', inputs: [{ name: 'label', type: 'string' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getResolver', stateMutability: 'view', inputs: [{ name: 'label', type: 'string' }], outputs: [{ type: 'address' }] },
] as const

const registrarAbi = [
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [{ name: 'label', type: 'string' }, { name: 'pubkey', type: 'string' }], outputs: [{ type: 'address' }, { type: 'uint256' }] },
  { type: 'function', name: 'available', stateMutability: 'view', inputs: [{ name: 'label', type: 'string' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'gate', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const

const factoryAbi = [
  { type: 'function', name: 'verifyContract', stateMutability: 'view', inputs: [{ name: 'proxy', type: 'address' }], outputs: [{ type: 'address' }] },
] as const


const ZERO = '0x0000000000000000000000000000000000000000' as const

export const publicClient = createPublicClient({ chain: sepolia, transport: http(ENS.rpc) })

// ---- wallet -----------------------------------------------------------------------------------

export async function walletClient(): Promise<{ client: WalletClient; account: Address }> {
  const eth = (window as unknown as { ethereum?: { request: (a: unknown) => Promise<unknown> } }).ethereum
  if (!eth) throw new Error('No EVM wallet found. Install MetaMask and connect on Sepolia.')
  const client = createWalletClient({ chain: sepolia, transport: custom(eth) })
  const [account] = await client.requestAddresses()
  await ensureSepolia(client)
  return { client, account }
}

async function ensureSepolia(client: WalletClient): Promise<void> {
  const current = await client.getChainId()
  if (current === ENS.chainId) return
  try {
    await client.switchChain({ id: sepolia.id })
  } catch {
    throw new Error(`Wallet is on chain ${current}. Switch it to Sepolia (${ENS.chainId}) and retry.`)
  }
}

/**
 * A signer for the handle OWNER — a key derived from MS, not the connected wallet.
 *
 * Records are written by whoever owns the name, and after a paid claim that is deliberately not
 * MetaMask (§4). This signs locally over plain RPC: no popup, and no need for the browser wallet
 * to have ever heard of the address.
 */
function ownerClient(account: Account) {
  return createWalletClient({ account, chain: sepolia, transport: http(ENS.rpc) })
}

/** Sign the fixed domain string → the seed for MS (§5.1). Deterministic per RFC 6979. */
export async function signIdentity(): Promise<Uint8Array> {
  const { client, account } = await walletClient()
  const sig = await client.signMessage({ account, message: 'lortnoc.eth identity v1' })
  return hexToBytes(sig)
}

// ---- names ------------------------------------------------------------------------------------

/** Strip the suffix: "alice.lortnoctahc.eth" → "alice". */
export const labelOf = (handle: string): string =>
  handle.endsWith(`.${LORTNOC.parentName}`) ? handle.slice(0, -(LORTNOC.parentName.length + 1)) : handle

/** namehash, computed the way LortnocRegistrar does it. */
export const nodeOf = (handle: string): Hex => namehash(handle)

/** The EAC resource a text-setter grant lands on at 09-15: keccak256(key) — per RESOLVER and key,
 *  not per name (decodeSetter ignores the name). One resolver per handle keeps it per handle. */
export const textResource = (key: string): bigint => BigInt(keccak256(stringToHex(key)))

/** DNS-encode a name — the `name` argument every 09-15 resolver setter takes. */
export function dnsEncode(name: string): Hex {
  let out = '0x'
  for (const part of name.split('.').filter(Boolean)) {
    const bytes = new TextEncoder().encode(part)
    out += bytes.length.toString(16).padStart(2, '0')
    for (const b of bytes) out += b.toString(16).padStart(2, '0')
  }
  return `${out}00` as Hex
}

// ---- reads ------------------------------------------------------------------------------------

/** The resolver serving a handle (zero address if unclaimed). */
export async function resolverFor(handle: string): Promise<Address | null> {
  if (!LORTNOC.registry) return null
  try {
    const r = await publicClient.readContract({
      address: LORTNOC.registry as Address,
      abi: registryAbi,
      functionName: 'getResolver',
      args: [labelOf(handle)],
    })
    return r === ZERO ? null : r
  } catch {
    return null
  }
}

/** Read one text record through ENS's canonical path (viem default UniversalResolver). */
export async function readText(handle: string, key: string): Promise<string | null> {
  if (!LORTNOC.registry) return null
  try {
    return (await publicClient.getEnsText({
      name: handle, key, universalResolverAddress: ENS.universalResolver as Address,
    })) || null
  } catch {
    return null
  }
}

/** Who owns a handle, as ENS's own tooling computes it (UniversalHelper.findExactOwner from the
 *  current root). 0x0 / null for unclaimed, expired, or nested names. "Resolves without error"
 *  is NOT existence: an unclaimed label falls back to the parent resolver and reads empty. */
export async function ownerOf(handle: string): Promise<Address | null> {
  try {
    const o = await publicClient.readContract({
      address: ENS.universalHelper as Address, abi: helperAbi, functionName: 'findExactOwner', args: [dnsEncode(handle)],
    })
    return o === ZERO ? null : o
  } catch {
    return null
  }
}

/** Resolve a handle → its X25519 messaging pubkey (§5.4). */
export const resolvePubkey = (handle: string): Promise<string | null> => readText(handle, REC.pubkey)

/** Is this label claimable right now? Asks the registrar, so label rules match the contract. */
export async function isAvailable(label: string): Promise<boolean> {
  if (!LORTNOC.registrar) return false
  try {
    return await publicClient.readContract({
      address: LORTNOC.registrar as Address, abi: registrarAbi, functionName: 'available', args: [label],
    })
  } catch {
    return false
  }
}

/** Would `who` be allowed to write `key` on this handle's resolver? A real `eth_call` against the
 *  live authorization path — no gas, no wallet needed. Drives the permission matrix in the UI. */
export async function canWriteText(handle: string, who: Address, key: string): Promise<boolean> {
  const resolver = await resolverFor(handle)
  if (!resolver) return false
  try {
    await publicClient.simulateContract({
      account: who, address: resolver, abi: resolverAbi, functionName: 'setText',
      args: [dnsEncode(handle), key, 'probe'],
    })
    return true
  } catch {
    return false
  }
}

/** Does `who` hold ROLE_SET_TEXT on the resource for `key` (keccak256(key), per resolver)? */
export async function hasTextRole(handle: string, who: Address, key: string): Promise<boolean> {
  const resolver = await resolverFor(handle)
  if (!resolver) return false
  try {
    return await publicClient.readContract({
      address: resolver, abi: resolverAbi, functionName: 'hasRoles',
      args: [textResource(key), ROLE_SET_TEXT, who],
    })
  } catch {
    return false
  }
}

/**
 * Which handle does this address own? Answered from chain, by scanning the registrar's
 * `HandleClaimed(label, claimant indexed, …)` log.
 *
 * This exists because the app used to know your handle ONLY from a localStorage note written at
 * claim time. That is per-origin and per-browser, so moving to a new domain, a second device, or
 * a cleared cache made a claimed handle vanish and the app offered to sell you another one.
 * Ownership is on-chain; the app should read it there.
 *
 * Two constraints shape the implementation: the default RPC refuses log queries entirely, and the
 * log-capable one caps ranges at 10k blocks — so this uses a separate endpoint and walks in
 * chunks from the registrar's deployment block. Returns the most recent claim.
 */
export async function handleOf(owner: Address): Promise<string | null> {
  if (!LORTNOC.registrar) return null
  const client = createPublicClient({ chain: sepolia, transport: http(ENS.logsRpc) })
  const latest = await client.getBlockNumber()
  const step = ENS.logSpan
  let newest: { label: string; block: bigint } | null = null

  for (let from = LORTNOC.registrarDeployBlock; from <= latest; from += step + 1n) {
    const to = from + step > latest ? latest : from + step
    let logs
    try {
      const q = { address: LORTNOC.registrar as Address, args: { claimant: owner }, fromBlock: from, toBlock: to } as const
      const [claimed, migrated] = await Promise.all([
        client.getLogs({ ...q, event: handleClaimedEvent }),
        client.getLogs({ ...q, event: handleMigratedEvent }),
      ])
      logs = [...claimed, ...migrated]
    } catch (e) {
      // A log endpoint that rate-limits or dies must not break sign-in — we simply fall back to
      // whatever the local note says.
      console.warn('[lortnoc] handle lookup failed for one range (continuing):', e)
      continue
    }
    for (const l of logs) {
      const label = l.args.label
      if (label && (!newest || l.blockNumber > newest.block)) newest = { label, block: l.blockNumber }
    }
  }
  return newest ? `${newest.label}.${LORTNOC.parentName}` : null
}

/** Trustless handle proof: the resolver came from the canonical VerifiableFactory. */
export async function verifyResolver(handle: string): Promise<{ ok: boolean; resolver: Address | null; impl: string }> {
  const resolver = await resolverFor(handle)
  if (!resolver) return { ok: false, resolver: null, impl: '' }
  const impl = await publicClient.readContract({
    address: ENS.verifiableFactory as Address, abi: factoryAbi, functionName: 'verifyContract', args: [resolver],
  })
  return { ok: impl.toLowerCase() === ENS.permissionedResolverImpl.toLowerCase(), resolver, impl }
}

// ---- writes -----------------------------------------------------------------------------------

/** One transaction: own resolver proxy + pubkey published + subname registered. */
export async function claimHandle(label: string, pubkeyHex: string): Promise<{ hash: Hex; resolver: Address }> {
  assertEnsSetup()
  const { client, account } = await walletClient()
  const { request, result } = await publicClient.simulateContract({
    account, address: LORTNOC.registrar as Address, abi: registrarAbi, functionName: 'claim',
    args: [label, pubkeyHex],
  })
  const hash = await client.writeContract(request)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`claim reverted (tx ${hash})`)
  return { hash, resolver: result[0] }
}

/** Write one of your own text records. Signs as `signer` when given (the MS-derived owner),
 *  otherwise falls back to the connected wallet. */
export async function setText(
  handle: string, key: string, value: string, signer?: Account,
): Promise<Hex> {
  assertEnsSetup()
  const resolver = await resolverFor(handle)
  if (!resolver) throw new Error(`${handle} has no resolver`)
  // Pass the Account OBJECT through, never just its address. viem coerces a bare address into a
  // json-rpc account, and `writeContract` then dispatches on that type: eth_sendTransaction over
  // this client's transport. For the owner that transport is a public RPC which holds no keys —
  // "unknown account". A local account signs in-process and sends eth_sendRawTransaction instead.
  const { client, account } = signer
    ? { client: ownerClient(signer), account: signer }
    : await walletClient()
  const { request } = await publicClient.simulateContract({
    account, address: resolver, abi: resolverAbi, functionName: 'setText',
    args: [dnsEncode(handle), key, value],
  })
  const hash = await client.writeContract(request)
  await publicClient.waitForTransactionReceipt({ hash })
  return hash
}

/** The ETH address a handle resolves to, through ENS's canonical path. Handles issued on 09-15
 *  get addr from the resolver's initializer, so an unset addr now means "not a live handle". */
export async function readAddr(handle: string): Promise<Address | null> {
  if (!LORTNOC.registry) return null
  try {
    return await publicClient.getEnsAddress({ name: handle, universalResolverAddress: ENS.universalResolver as Address })
  } catch {
    return null
  }
}

/** Publish the ETH address for a handle. Same signer rules as setText — see the note there. */
export async function setAddr(handle: string, addr: Address, signer?: Account): Promise<Hex> {
  assertEnsSetup()
  const resolver = await resolverFor(handle)
  if (!resolver) throw new Error(`${handle} has no resolver`)
  const { client, account } = signer
    ? { client: ownerClient(signer), account: signer }
    : await walletClient()
  const { request } = await publicClient.simulateContract({
    account, address: resolver, abi: resolverAbi, functionName: 'setAddress',
    args: [dnsEncode(handle), 60n, addr],
  })
  const hash = await client.writeContract(request)
  await publicClient.waitForTransactionReceipt({ hash })
  return hash
}

/** Grant or revoke write access to exactly ONE text key. The flagship demo.
 *  Grant → grantSetterRoles(setText(name, key, ""), account); revoke → revokeRoles(keccak256(key),
 *  ROLE_SET_TEXT, account). Needs ROLE_SET_TEXT_ADMIN, which the owner holds from the claim. */
export async function setTextDelegation(
  handle: string,
  key: string,
  account_: Address,
  grant: boolean,
  signer?: Account,
): Promise<Hex> {
  assertEnsSetup()
  const resolver = await resolverFor(handle)
  if (!resolver) throw new Error(`${handle} has no resolver`)
  // Account object, not address — see setText above.
  const { client, account } = signer
    ? { client: ownerClient(signer), account: signer }
    : await walletClient()
  let hash: Hex
  if (grant) {
    const { request } = await publicClient.simulateContract({
      account, address: resolver, abi: resolverAbi, functionName: 'grantSetterRoles',
      args: [encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(handle), key, ''] }), account_],
    })
    hash = await client.writeContract(request)
  } else {
    const { request } = await publicClient.simulateContract({
      account, address: resolver, abi: resolverAbi, functionName: 'revokeRoles',
      args: [textResource(key), ROLE_SET_TEXT, account_],
    })
    hash = await client.writeContract(request)
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${grant ? 'grantSetterRoles' : 'revokeRoles'} reverted (tx ${hash})`)
  return hash
}

// ---- helpers ----------------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, '')
  return Uint8Array.from(h.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)))
}
