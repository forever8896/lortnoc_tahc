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
import { createPublicClient, http, toHex } from 'viem'
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

export function createEnsSpaces({ rpc = process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com', read } = {}) {
  const client = createPublicClient({ chain: sepolia, transport: http(rpc, { timeout: 10_000 }) })
  // `read` is injectable for tests: (name) => ({ owner, token, bans })
  const fetchSpace = read ?? (async (name) => {
    const [owner, token, bans] = await Promise.all([
      client.readContract({
        address: DEPLOYMENT.ens.universalHelper,
        abi: [{ type: 'function', name: 'findExactOwner', stateMutability: 'view', inputs: [{ type: 'bytes' }], outputs: [{ type: 'address' }] }],
        functionName: 'findExactOwner',
        args: [dnsEncode(name)],
      }).catch(() => null),
      client.getEnsText({ name, key: REC.token }).catch(() => null),
      client.getEnsText({ name, key: REC.bans }).catch(() => null),
    ])
    return { owner, token, bans }
  })
  const cache = new Map()

  async function get(space) {
    const name = ensNameOf(space)
    if (!name) return null
    const hit = cache.get(name)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.v
    const raw = await fetchSpace(name)
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
    async isBanned(space, memberId) {
      return !!(await get(space))?.bans.has(memberId)
    },
    forget: (space) => cache.delete(ensNameOf(space)),
  }
}
