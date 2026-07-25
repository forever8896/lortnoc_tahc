// ENS v2 client (viem, Sepolia). Resolve is robust (direct resolver.text read via
// namehash). Claim/delegate/verify need the day-0 setup (docs/LIVE-SETUP.md) and are
// validated in-browser with the funded wallet — marked where that applies.
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  namehash,
  type Address,
  type WalletClient,
} from 'viem'
import { sepolia } from 'viem/chains'
import { ENS, LORTNOC, REC, assertEnsSetup } from './config'

const RESOLVER_ABI = [
  { type: 'function', name: 'text', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'setText', stateMutability: 'nonpayable', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }, { name: 'value', type: 'string' }], outputs: [] },
  // v2 Permissioned Resolver — per-record write delegation (use authorize*Roles, NOT grantRoles)
  { type: 'function', name: 'authorizeTextRoles', stateMutability: 'nonpayable', inputs: [{ name: 'toName', type: 'bytes' }, { name: 'key', type: 'string' }, { name: 'account', type: 'address' }, { name: 'grant', type: 'bool' }], outputs: [{ type: 'bool' }] },
] as const

const FACTORY_ABI = [
  { type: 'function', name: 'verifyContract', stateMutability: 'view', inputs: [{ name: 'proxy', type: 'address' }], outputs: [{ type: 'address' }] },
] as const

export const publicClient = createPublicClient({ chain: sepolia, transport: http(ENS.rpc) })

export async function walletClient(): Promise<{ client: WalletClient; account: Address }> {
  const eth = (window as unknown as { ethereum?: any }).ethereum
  if (!eth) throw new Error('No EVM wallet found. Install MetaMask and connect on Sepolia.')
  const client = createWalletClient({ chain: sepolia, transport: custom(eth) })
  const [account] = await client.requestAddresses()
  return { client, account }
}

/** Sign the fixed domain string → the seed for MS (§5.1). */
export async function signIdentity(): Promise<Uint8Array> {
  const { client, account } = await walletClient()
  const sig = await client.signMessage({ account, message: 'lortnoc.eth identity v1' })
  return hexToBytes(sig)
}

/** Resolve <handle> → its eth.lortnoc.pubkey (null if unset). Robust: direct resolver read. */
export async function resolvePubkey(handle: string): Promise<string | null> {
  if (!LORTNOC.resolver) return null
  try {
    const val = await publicClient.readContract({
      address: LORTNOC.resolver as Address,
      abi: RESOLVER_ABI,
      functionName: 'text',
      args: [namehash(handle), REC.pubkey],
    })
    return val && val.length > 0 ? val : null
  } catch {
    return null
  }
}

/** Publish the messaging pubkey for a handle (writes the text record). Needs the subname
 *  to exist + the caller to hold the write role (day-0 setup issues the subname). */
export async function claimHandle(handle: string, pubkeyHex: string): Promise<string> {
  assertEnsSetup()
  const { client, account } = await walletClient()
  // NOTE: subname issuance (LortnocRegistry.register) is a day-0/relayer concern; here we
  // publish the pubkey on the resolver for the (already-issued) node.
  const hash = await client.writeContract({
    account,
    chain: sepolia,
    address: LORTNOC.resolver as Address,
    abi: RESOLVER_ABI,
    functionName: 'setText',
    args: [namehash(handle), REC.pubkey, pubkeyHex],
  })
  return hash
}

/** ENS creative demo: delegate write of ONLY eth.lortnoc.inbox to a gateway address. */
export async function delegateInbox(handle: string, gateway: Address): Promise<string> {
  assertEnsSetup()
  const { client, account } = await walletClient()
  const dnsName = dnsEncode(handle)
  const hash = await client.writeContract({
    account,
    chain: sepolia,
    address: LORTNOC.resolver as Address,
    abi: RESOLVER_ABI,
    functionName: 'authorizeTextRoles',
    args: [dnsName, REC.inbox, gateway, true],
  })
  return hash
}

/** Trustless handle proof: verifyContract(proxy) → impl (compare to PermissionedResolverImpl). */
export async function verifyResolver(proxy: Address): Promise<{ ok: boolean; impl: string }> {
  const impl = (await publicClient.readContract({
    address: ENS.verifiableFactory as Address,
    abi: FACTORY_ABI,
    functionName: 'verifyContract',
    args: [proxy],
  })) as Address
  return { ok: impl.toLowerCase() === ENS.permissionedResolverImpl.toLowerCase(), impl }
}

// ---- helpers ----
function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, '')
  return Uint8Array.from(h.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)))
}
/** DNS-encode a name to bytes (for authorize*Roles' `toName`). */
function dnsEncode(name: string): `0x${string}` {
  const parts = name.split('.').filter(Boolean)
  let out = '0x'
  for (const p of parts) {
    const bytes = new TextEncoder().encode(p)
    out += bytes.length.toString(16).padStart(2, '0')
    for (const b of bytes) out += b.toString(16).padStart(2, '0')
  }
  out += '00'
  return out as `0x${string}`
}
