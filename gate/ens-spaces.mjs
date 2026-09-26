// ENS spaces, read by the gate (docs/PRD-universal.md §23). A space written `@lentil-club` in a
// policy is the ENS name `lentil-club.space.lortnoctahc.eth`, and ENS is its source of truth:
//
//   owner  = UniversalHelper.findExactOwner(name)   — the registry owner, never the addr record
//   token  = text eth.lortnoc.space.token            — CAIP-19 NFT collection readers must hold
//   bans   = text eth.lortnoc.space.bans             — comma-separated member pseudonyms
//
// Everything is read through ENS's CANONICAL path (viem's default UniversalResolver 0xeeee…eeee),
// the same path the ENS app and explorer use — the July lesson: our own wrapper resolving a name
// proves nothing about whether ENS resolves it. Reads are cached briefly so a burst of readers
// does not hammer the RPC; a ban takes effect within that window.
import { createPublicClient, http, fallback, toHex } from 'viem'
import { sepolia } from 'viem/chains'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const DEPLOYMENT = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../app/src/lib/live/ens-deployment.json'), 'utf8'))
export const SPACE_PARENT = `space.${DEPLOYMENT.lortnoc.parentName}` // space.lortnoctahc.eth
export const REC = { token: 'eth.lortnoc.space.token', bans: 'eth.lortnoc.space.bans' }
const CACHE_MS = 20_000

/** `@lentil-club` → `lentil-club.space.lortnoctahc.eth`; null for a gate (non-ENS) space. */
export const ensNameOf = (space) => (space?.startsWith('@') ? `${space.slice(1)}.${SPACE_PARENT}` : null)

/** DNS wire format — what findExactOwner takes. */
function dnsEncode(name) {
  const parts = name.split('.').map((l) => new TextEncoder().encode(l))
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length + 1, 1))
  let at = 0
  for (const p of parts) (out[at++] = p.length, out.set(p, at), (at += p.length))
  return toHex(out)
}

/** Sepolia RPCs that answer the canonical ENS reads (measured 2026-09-26: drpc and rpc.sepolia.org did not). */
export const SEPOLIA_RPCS = ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.gateway.tenderly.co', 'https://1rpc.io/sepolia']

export function createEnsSpaces({ rpc = process.env.SEPOLIA_RPC, read } = {}) {
  // One node down must not take spaces down: viem's fallback moves to the next on errors/timeouts.
  const client = createPublicClient({ chain: sepolia, transport: fallback((rpc ? [rpc] : SEPOLIA_RPCS).map((u) => http(u, { timeout: 8_000 }))) })
  // `read` is injectable for tests: (name) => ({ owner, token, bans })
  // FAIL CLOSED: a read that errors is not "no record". Earlier every read was .catch(() => null), so an
  // RPC hiccup on the ban list read as "nobody is banned" — and was cached for 20 s. Now a failed read
  // marks the space `unknown`: it is not cached, it does not exist for that request, and everyone in it
  // counts as banned until a read succeeds.
  const fetchSpace = read ?? (async (name) => {
    const [owner, token, bans] = await Promise.all([
      client.readContract({
        address: DEPLOYMENT.ens.universalHelper,
        abi: [{ type: 'function', name: 'findExactOwner', stateMutability: 'view', inputs: [{ type: 'bytes' }], outputs: [{ type: 'address' }] }],
        functionName: 'findExactOwner',
        args: [dnsEncode(name)],
      }),
      client.getEnsText({ name, key: REC.token }),
      client.getEnsText({ name, key: REC.bans }),
    ])
    return { owner, token, bans }
  })
  const cache = new Map()

  async function get(space) {
    const name = ensNameOf(space)
    if (!name) return null
    const hit = cache.get(name)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.v
    let raw
    try {
      raw = await fetchSpace(name)
    } catch {
      return { name, exists: false, unknown: true, owner: null, token: '', bans: new Set() } // not cached
    }
    const exists = !!raw.owner && !/^0x0{40}$/i.test(raw.owner)
    const v = {
      name,
      exists,
      owner: exists ? raw.owner : null,
      token: raw.token || '',
      bans: new Set(String(raw.bans ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    }
    cache.set(name, { at: Date.now(), v })
    return v
  }

  return {
    get,
    async exists(space) {
      return !!(await get(space))?.exists
    },
    /** True if banned — and also when the ban list could not be read (fail closed). */
    async isBanned(space, memberId) {
      const sp = await get(space)
      return !!sp?.unknown || !!sp?.bans.has(memberId)
    },
    forget: (space) => cache.delete(ensNameOf(space)),
  }
}
