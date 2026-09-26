// Writing an ENS space's ban list and moderators — from the extension, with the space's OWNER key
// (or a moderator key the owner granted). ENS is the source of truth; the gate reads these records
// live (gate/ens-spaces.mjs), so a ban here takes effect for every reader of the space.
//
// 09-15 resolver API (CLAUDE.md §6.5): setters take the DNS-encoded NAME; moderators get exactly the
// `setText(name, "eth.lortnoc.space.bans", …)` setter via grantSetterRoles, revoked with revokeRoles.
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

export const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
export const BANS_KEY = 'eth.lortnoc.space.bans'
const ROLE_SET_TEXT = 1n << 4n
const RESOLVER_ABI = [
  { type: 'function', name: 'setText', stateMutability: 'nonpayable', inputs: [{ name: 'name', type: 'bytes' }, { name: 'key', type: 'string' }, { name: 'value', type: 'string' }], outputs: [] },
  { type: 'function', name: 'grantSetterRoles', stateMutability: 'nonpayable', inputs: [{ name: 'setter', type: 'bytes' }, { name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'revokeRoles', stateMutability: 'nonpayable', inputs: [{ name: 'resource', type: 'uint256' }, { name: 'roleBitmap', type: 'uint256' }, { name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
] as const

export const spaceName = (label: string) => `${label.replace(/^@/, '')}.space.lortnoctahc.eth`

function dnsEncode(name: string): `0x${string}` {
  const parts = name.split('.').map((l) => new TextEncoder().encode(l))
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length + 1, 1))
  let at = 0
  for (const p of parts) (out[at++] = p.length, out.set(p, at), (at += p.length))
  return toHex(out)
}

const pub = () => createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) })

async function resolverOf(name: string) {
  const r = await pub().getEnsResolver({ name })
  if (!r) throw new Error(`${name} has no resolver — does the space exist?`)
  return r
}

async function send(privHex: `0x${string}`, name: string, data: `0x${string}`) {
  const account = privateKeyToAccount(privHex)
  const c = pub()
  const to = await resolverOf(name)
  const w = createWalletClient({ account, chain: sepolia, transport: http(SEPOLIA_RPC) })
  // public RPCs suggest a zero tip on quiet networks; a zero-tip tx never lands (measured 2026-09-25)
  const fees = await c.estimateFeesPerGas()
  const tip = fees.maxPriorityFeePerGas > 50_000_000n ? fees.maxPriorityFeePerGas : 50_000_000n
  const hash = await w.sendTransaction({ to, data, maxPriorityFeePerGas: tip, maxFeePerGas: fees.maxFeePerGas + tip })
  const r = await c.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (r.status !== 'success') throw new Error('the ENS write reverted — is this key the owner or a moderator?')
  return hash
}

/** Current ban list, read the canonical way (viem's default UniversalResolver). */
export async function readBans(label: string): Promise<string[]> {
  const v = await pub().getEnsText({ name: spaceName(label), key: BANS_KEY }).catch(() => null)
  return String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

/** Add (or remove) a member pseudonym in the space's on-chain ban list. */
export async function writeBan(label: string, memberId: string, privHex: `0x${string}`, unban = false) {
  const name = spaceName(label)
  const list = new Set(await readBans(label))
  if (unban) list.delete(memberId)
  else list.add(memberId)
  const data = encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setText', args: [dnsEncode(name), BANS_KEY, [...list].join(',')] })
  return send(privHex, name, data)
}

/** Owner makes `moderator` able to edit the ban list — and nothing else. */
export async function grantModerator(label: string, moderator: `0x${string}`, ownerPriv: `0x${string}`) {
  const name = spaceName(label)
  const setter = encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setText', args: [dnsEncode(name), BANS_KEY, ''] })
  return send(ownerPriv, name, encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'grantSetterRoles', args: [setter, moderator] }))
}

export async function revokeModerator(label: string, moderator: `0x${string}`, ownerPriv: `0x${string}`) {
  const name = spaceName(label)
  const resource = BigInt(keccak256(toHex(BANS_KEY)))
  return send(ownerPriv, name, encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'revokeRoles', args: [resource, ROLE_SET_TEXT, moderator] }))
}
