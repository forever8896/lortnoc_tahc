// Read-only ENS v2 resolution: handle → X25519 messaging pubkey. Mode 3's key directory.
//
// Deliberately a ~90-line READ-ONLY slice rather than a port of app/src/lib/live/ens.ts (417
// lines). That module also carries `walletClient`, `signIdentity`, `claimHandle`, `setText` and
// the whole claim path, which would drag `window.ethereum` and a signing surface into a browser
// extension that has no business holding either. Resolution is all Mode 3 needs: you encrypt TO
// people, so you only ever read their public records.
//
// This lives in the SERVICE WORKER, not the content script. MV3 content scripts do not get host
// permissions for `fetch` — a cross-origin request from one is subject to the page's CORS, the
// same reason codec calls are brokered here.
//
// Addresses are the pinned `sepolia-deployment-2026-06-29` set, matching
// app/src/lib/live/ens-deployment.json. That file is the source of truth; these are a copy
// because a service worker cannot read across workspaces at runtime. If they ever disagree, that
// file wins — re-run scripts/ens/status.mjs.
import { createPublicClient, http, encodeFunctionData, namehash, type Address, type Hex } from 'viem'
import { sepolia } from 'viem/chains'

const RPC = 'https://ethereum-sepolia-rpc.publicnode.com'

const ENS = {
  universalResolver: '0x85edf8b6b7d4211e2b07aa687506b746357b92cf' as Address,
}

const LORTNOC = {
  parentName: 'lortnoctahc.eth',
  registry: '0x2D95c86bd9a850d95897c604c8EB00131a9C62a5' as Address,
}

/** The §5.4 text record carrying the X25519 messaging pubkey. */
const REC_PUBKEY = 'eth.lortnoc.pubkey'

const ZERO = '0x0000000000000000000000000000000000000000'

const resolverAbi = [
  {
    type: 'function',
    name: 'text',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }],
    outputs: [{ type: 'string' }],
  },
] as const

const registryAbi = [
  {
    type: 'function',
    name: 'getResolver',
    stateMutability: 'view',
    inputs: [{ name: 'label', type: 'string' }],
    outputs: [{ type: 'address' }],
  },
] as const

const universalResolverAbi = [
  {
    type: 'function',
    name: 'resolve',
    stateMutability: 'view',
    inputs: [{ name: 'name', type: 'bytes' }, { name: 'data', type: 'bytes' }],
    outputs: [{ type: 'bytes' }, { type: 'address' }],
  },
] as const

const client = createPublicClient({ chain: sepolia, transport: http(RPC) })

/** `alice` or `alice.lortnoctahc.eth` → the full handle. */
export function fullHandle(input: string): string {
  const clean = input.trim().replace(/^@/, '').toLowerCase()
  return clean.endsWith(`.${LORTNOC.parentName}`) ? clean : `${clean}.${LORTNOC.parentName}`
}

const labelOf = (handle: string): string => handle.split('.')[0]

/** DNS wire format, as UniversalResolverV2.resolve expects. */
function dnsEncode(name: string): Hex {
  const out: number[] = []
  for (const part of name.split('.')) {
    const b = new TextEncoder().encode(part)
    out.push(b.length, ...b)
  }
  out.push(0)
  return `0x${out.map((n) => n.toString(16).padStart(2, '0')).join('')}`
}

function decodeString(data: Hex): string | null {
  // ABI `string` return: offset(32) · length(32) · bytes. Hand-decoded because the canonical
  // path returns raw `bytes` that still wrap the encoded string.
  try {
    const raw = data.slice(2)
    if (raw.length < 128) return null
    const len = parseInt(raw.slice(64, 128), 16)
    if (!len) return null
    const body = raw.slice(128, 128 + len * 2)
    const s = new TextDecoder().decode(Uint8Array.from(body.match(/.{2}/g)!.map((h) => parseInt(h, 16))))
    return s || null
  } catch {
    return null
  }
}

/**
 * Resolve a handle to its X25519 messaging pubkey, hex, or null.
 *
 * Canonical path first (UniversalResolverV2), direct resolver as fallback — mirroring
 * app/src/lib/live/ens.ts. The fallback matters: it is what kept handles resolving during the
 * period when the PARENT had no resolver linked (CLAUDE.md §6.5 resolution bug).
 */
export async function resolvePubkey(input: string): Promise<string | null> {
  const handle = fullHandle(input)
  const node = namehash(handle)
  const call = encodeFunctionData({ abi: resolverAbi, functionName: 'text', args: [node, REC_PUBKEY] })

  try {
    const [result] = await client.readContract({
      address: ENS.universalResolver,
      abi: universalResolverAbi,
      functionName: 'resolve',
      args: [dnsEncode(handle), call],
    })
    const decoded = decodeString(result)
    if (decoded) return decoded
  } catch {
    /* fall through to the direct read */
  }

  try {
    const resolver = await client.readContract({
      address: LORTNOC.registry,
      abi: registryAbi,
      functionName: 'getResolver',
      args: [labelOf(handle)],
    })
    if (!resolver || resolver === ZERO) return null
    const v = await client.readContract({
      address: resolver as Address,
      abi: resolverAbi,
      functionName: 'text',
      args: [node, REC_PUBKEY],
    })
    return v || null
  } catch {
    return null
  }
}
