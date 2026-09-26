// POST /demo/mint — hand out LortnocDemoPass NFTs on Sepolia so anyone can try a holders-only space
// without owning an NFT or any Sepolia ETH. The relayer pays the gas.
//
// TESTNET ONLY and capped, because the relayer's Sepolia ETH also funds real space claims:
//   ≤ PER_REQUEST addresses per request · ≤ PER_IP_HOUR passes per visitor per hour · ≤ PER_DAY in total
// The pass itself gates nothing of value (contracts/src/LortnocDemoPass.sol: open mint by design).
import { getAddress, isAddress } from 'viem'

export const PER_REQUEST = 5
export const PER_IP_HOUR = 20
export const PER_DAY = 300

/**
 * @param {{ mintTo: (to: string, i: number) => Promise<string>, now?: () => number, log?: Function }} deps
 *   mintTo sends one mint and resolves to its tx hash (i = position in this batch, for nonces)
 * @returns {(body: unknown, ip: string) => Promise<{ status: number, body: object }>}
 */
export function createDemoMinter({ mintTo, now = () => Date.now(), log = () => {} }) {
  const perIp = new Map() // ip → timestamps
  let day = { start: now(), n: 0 }

  return async function handle(body, ip) {
    const list = Array.isArray(body?.to) ? body.to : typeof body?.to === 'string' ? [body.to] : null
    if (!list || !list.length) return { status: 400, body: { error: 'to: one address or a list of addresses' } }
    if (list.length > PER_REQUEST) return { status: 400, body: { error: `at most ${PER_REQUEST} addresses at a time` } }
    const bad = list.find((a) => typeof a !== 'string' || !isAddress(a.trim()))
    if (bad !== undefined) return { status: 400, body: { error: `not an address: ${String(bad).slice(0, 60)}` } }
    const to = [...new Set(list.map((a) => getAddress(a.trim())))]

    const t = now()
    if (t - day.start > 24 * 3600_000) day = { start: t, n: 0 }
    const hits = (perIp.get(ip) ?? []).filter((x) => t - x < 3600_000)
    if (hits.length + to.length > PER_IP_HOUR) return { status: 429, body: { error: 'enough demo passes for now — try again in an hour' } }
    if (day.n + to.length > PER_DAY) return { status: 429, body: { error: 'the demo pass limit for today is reached' } }
    perIp.set(ip, [...hits, ...to.map(() => t)])
    day.n += to.length

    const minted = []
    for (let i = 0; i < to.length; i++) {
      try {
        minted.push({ to: to[i], tx: await mintTo(to[i], i) })
      } catch (e) {
        minted.push({ to: to[i], error: String(e.shortMessage ?? e.message ?? e).split('\n')[0] })
      }
    }
    log(`demo passes: ${minted.filter((m) => m.tx).length}/${to.length} minted`)
    return { status: minted.some((m) => m.tx) ? 200 : 502, body: { minted } }
  }
}
