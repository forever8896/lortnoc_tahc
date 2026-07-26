// ENS v2 client (viem, Sepolia) — the real thing, against the pinned deployment.
//
// Reads go through UniversalResolverV2 (canonical ENS resolution: RootRegistry → eth →
// lortnoctahc → LortnocRegistry → handle → resolver), with a direct registry read as fallback so
// a UR hiccup can't break the messenger.
//
// Writes:
//   claim        → LortnocRegistrar.claim() — ONE tx that deploys the caller's own
//                  PermissionedResolver proxy, writes eth.lortnoc.pubkey, hands them every role
//                  on it, and registers the subname.
//   delegate     → resolver.authorizeTextRoles(name, key, gateway, true/false) — per-record write
//                  delegation, the ENS v2 flagship (§6.5 use #1). Note: authorize*Roles, NOT
//                  grantRoles, which is `pure` on the resolver and always reverts.
//   verify       → VerifiableFactory.verifyContract(proxy) → implementation, compared off-chain.
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeAbiParameters,
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

// ---- ABIs (only what we call) -----------------------------------------------------------------

const resolverAbi = [
  { type: 'function', name: 'text', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'setText', stateMutability: 'nonpayable', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }, { name: 'value', type: 'string' }], outputs: [] },
  { type: 'function', name: 'authorizeTextRoles', stateMutability: 'nonpayable', inputs: [{ name: 'toName', type: 'bytes' }, { name: 'key', type: 'string' }, { name: 'account', type: 'address' }, { name: 'grant', type: 'bool' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'hasRoles', stateMutability: 'view', inputs: [{ name: 'resource', type: 'uint256' }, { name: 'roleBitmap', type: 'uint256' }, { name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'clearRecords', stateMutability: 'nonpayable', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [] },
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

const universalResolverAbi = [
  { type: 'function', name: 'resolve', stateMutability: 'view', inputs: [{ name: 'name', type: 'bytes' }, { name: 'data', type: 'bytes' }], outputs: [{ type: 'bytes' }, { type: 'address' }] },
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

/** The per-record EAC resource a text-role grant lands on: keccak256(abi.encode(node, keccak(key))). */
export const textResource = (node: Hex, key: string): bigint =>
  BigInt(
    keccak256(
      encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [node, keccak256(stringToHex(key))]),
    ),
  )

/** DNS-encode a name — the `toName` argument shape for authorize*Roles. */
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

/** Read one text record. Canonical path first (UniversalResolverV2), direct resolver as fallback. */
export async function readText(handle: string, key: string): Promise<string | null> {
  if (!LORTNOC.registry) return null
  const node = nodeOf(handle)
  const call = encodeFunctionData({ abi: resolverAbi, functionName: 'text', args: [node, key] })

  try {
    const [result] = await publicClient.readContract({
      address: ENS.universalResolver as Address,
      abi: universalResolverAbi,
      functionName: 'resolve',
      args: [dnsEncode(handle), call],
    })
    const decoded = decodeString(result)
    if (decoded) return decoded
  } catch {
    /* fall through to the direct read */
  }

  const resolver = await resolverFor(handle)
  if (!resolver) return null
  try {
    const v = await publicClient.readContract({
      address: resolver, abi: resolverAbi, functionName: 'text', args: [node, key],
    })
    return v || null
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
      args: [nodeOf(handle), key, 'probe'],
    })
    return true
  } catch {
    return false
  }
}

/** Does `who` hold ROLE_SET_TEXT on the per-record resource for `key`? */
export async function hasTextRole(handle: string, who: Address, key: string): Promise<boolean> {
  const resolver = await resolverFor(handle)
  if (!resolver) return false
  try {
    return await publicClient.readContract({
      address: resolver, abi: resolverAbi, functionName: 'hasRoles',
      args: [textResource(nodeOf(handle), key), ROLE_SET_TEXT, who],
    })
  } catch {
    return false
  }
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
    args: [nodeOf(handle), key, value],
  })
  const hash = await client.writeContract(request)
  await publicClient.waitForTransactionReceipt({ hash })
  return hash
}

/** Grant or revoke write access to exactly ONE text record. The flagship demo. */
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
  const { request } = await publicClient.simulateContract({
    account, address: resolver, abi: resolverAbi, functionName: 'authorizeTextRoles',
    args: [dnsEncode(handle), key, account_, grant],
  })
  const hash = await client.writeContract(request)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`authorizeTextRoles reverted (tx ${hash})`)
  return hash
}

// ---- helpers ----------------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, '')
  return Uint8Array.from(h.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)))
}

/** Decode an ABI-encoded `string` return without pulling in a decoder for one shape. */
function decodeString(data: Hex): string | null {
  try {
    const body = data.slice(2)
    if (body.length < 128) return null
    const len = parseInt(body.slice(64, 128), 16)
    if (!len) return ''
    const bytes = body.slice(128, 128 + len * 2)
    return new TextDecoder().decode(Uint8Array.from(bytes.match(/.{1,2}/g)!.map((b) => parseInt(b, 16))))
  } catch {
    return null
  }
}
