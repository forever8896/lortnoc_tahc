// Read-only ENS v2 resolution: handle → X25519 messaging pubkey. Mode 3's key directory.
//
// Deliberately a tiny READ-ONLY slice rather than a port of app/src/lib/live/ens.ts. That module
// also carries `walletClient`, `signIdentity`, `claimHandle`, `setText` and the whole claim path,
// which would drag `window.ethereum` and a signing surface into a browser extension that has no
// business holding either. Resolution is all Mode 3 needs: you encrypt TO people, so you only
// ever read their public records.
//
// This lives in the SERVICE WORKER, not the content script. MV3 content scripts do not get host
// permissions for `fetch` — a cross-origin request from one is subject to the page's CORS, the
// same reason codec calls are brokered here.
//
// NO deployment addresses live in this file. Resolution goes through viem's built-in Sepolia
// UniversalResolver — the STABLE proxy 0xeeee…eeee that ENS keeps pointed at the current root
// across Sepolia resets — which is the same path manager.ens.dev and explorer.ens.dev take. The
// old copy of our registry/resolver addresses (and the direct `text(node,key)` fallback) is gone:
// the 09-15 PermissionedResolver has no direct getters, and a copy that must match
// ens-deployment.json is exactly what goes stale on the next reset.
import { createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'

const RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
const PARENT_NAME = 'lortnoctahc.eth'

/** The §5.4 text record carrying the X25519 messaging pubkey. */
const REC_PUBKEY = 'eth.lortnoc.pubkey'

const client = createPublicClient({ chain: sepolia, transport: http(RPC) })

/** `alice` or `alice.lortnoctahc.eth` → the full handle. */
export function fullHandle(input: string): string {
  const clean = input.trim().replace(/^@/, '').toLowerCase()
  return clean.endsWith(`.${PARENT_NAME}`) ? clean : `${clean}.${PARENT_NAME}`
}

/**
 * Resolve a handle to its X25519 messaging pubkey, hex, or null.
 *
 * An unclaimed or expired label does not throw: since ENS fix #440 it falls back to the parent's
 * resolver and reads EMPTY, which surfaces here as null — i.e. "no key, cannot encrypt to them".
 */
export async function resolvePubkey(input: string): Promise<string | null> {
  try {
    return (await client.getEnsText({ name: fullHandle(input), key: REC_PUBKEY })) || null
  } catch {
    return null
  }
}
