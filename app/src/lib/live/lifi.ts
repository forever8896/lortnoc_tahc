// LI.FI bridge — turn ETH on whatever chain the user is already on into native 0G, in ONE
// transaction (§7 payment path).
//
// We call the REST API rather than dropping in @lifi/widget: the widget expects a wagmi context
// and this app is raw viem + window.ethereum, and a quote response already contains a
// ready-to-send `transactionRequest`. One request, one signature, ~12s.
import { createPublicClient, http, type Address, type Hex } from 'viem'

export const ZEROG_CHAIN_ID = 16661
export const NATIVE = '0x0000000000000000000000000000000000000000'

const API = 'https://li.quest/v1'

export type BridgeQuote = {
  tool: string
  fromAmount: bigint
  fromAmountUSD: string
  toAmount: bigint
  toAmountUSD: string
  /** Seconds the bridge expects to take. gasZipBridge quotes ~12s ETH→0G. */
  durationSeconds: number
  gasCostUSD: string
  tx: {
    to: Address
    data: Hex
    value: bigint
    chainId: number
    gasLimit?: bigint
    gasPrice?: bigint
  }
}

/** Quote `fromAmountWei` of native gas on `fromChain` → native 0G on 0G mainnet. */
export async function quoteToZeroG(params: {
  fromChain: number
  fromAddress: Address
  fromAmountWei: bigint
  toAddress?: Address
}): Promise<BridgeQuote> {
  // Fail with something a human can act on. Left to the API this surfaces as a raw schema error
  // ("/fromChain must be equal to one of the allowed values"), which reads like a bug in us.
  if (!isBridgeSource(params.fromChain)) {
    throw new Error(
      `Your wallet is on chain ${params.fromChain}, which no bridge supports as a source. ` +
        `Switch it to ${SOURCE_CHAINS.map((c) => c.name).join(', ')} and try again.`,
    )
  }

  const q = new URLSearchParams({
    fromChain: String(params.fromChain),
    toChain: String(ZEROG_CHAIN_ID),
    fromToken: NATIVE,
    toToken: NATIVE,
    fromAmount: params.fromAmountWei.toString(),
    fromAddress: params.fromAddress,
    toAddress: params.toAddress ?? params.fromAddress,
  })

  const res = await fetch(`${API}/quote?${q}`)
  const body = await res.json()
  if (!res.ok || body.message) {
    throw new Error(`No bridge route: ${body.message ?? res.statusText}`)
  }

  const e = body.estimate ?? {}
  const t = body.transactionRequest ?? {}
  return {
    tool: body.tool,
    fromAmount: BigInt(e.fromAmount ?? 0),
    fromAmountUSD: e.fromAmountUSD ?? '0',
    toAmount: BigInt(e.toAmount ?? 0),
    toAmountUSD: e.toAmountUSD ?? '0',
    durationSeconds: Number(e.executionDuration ?? 0),
    gasCostUSD: (e.gasCosts ?? [])
      .reduce((sum: number, g: { amountUSD?: string }) => sum + Number(g.amountUSD ?? 0), 0)
      .toFixed(2),
    tx: {
      to: t.to as Address,
      data: t.data as Hex,
      value: BigInt(t.value ?? 0),
      chainId: Number(t.chainId ?? params.fromChain),
      gasLimit: t.gasLimit ? BigInt(t.gasLimit) : undefined,
      gasPrice: t.gasPrice ? BigInt(t.gasPrice) : undefined,
    },
  }
}

export type BridgeStatus = 'PENDING' | 'DONE' | 'FAILED' | 'NOT_FOUND'

/** Poll until the bridge credits the destination. The source tx confirming is NOT the finish
 *  line — funds land on 0G a few seconds later, and paying before then just fails. */
export async function waitForBridge(
  txHash: Hex,
  fromChain: number,
  opts: { timeoutMs?: number; onTick?: (s: BridgeStatus, elapsed: number) => void } = {},
): Promise<BridgeStatus> {
  const timeout = opts.timeoutMs ?? 5 * 60_000
  const started = Date.now()

  for (;;) {
    let status: BridgeStatus = 'NOT_FOUND'
    try {
      const res = await fetch(
        `${API}/status?txHash=${txHash}&fromChain=${fromChain}&toChain=${ZEROG_CHAIN_ID}`,
      )
      const body = await res.json()
      status = (body.status as BridgeStatus) ?? 'NOT_FOUND'
    } catch {
      /* transient — keep polling */
    }

    const elapsed = Date.now() - started
    opts.onTick?.(status, elapsed)
    if (status === 'DONE' || status === 'FAILED') return status
    if (elapsed > timeout) return 'PENDING'
    await new Promise((r) => setTimeout(r, 3000))
  }
}

/** Chains we can bridge from, in the order we'd suggest them (cheapest gas first).
 *
 *  LI.FI routes mainnet value only — its `fromChain` is a closed enum of real chains, so a
 *  testnet id is rejected by schema validation before any routing is attempted:
 *  "/fromChain must be equal to one of the allowed values". That matters here because signing in
 *  puts the wallet on **Sepolia** (identity lives on ENS v2 there), which is exactly such an id.
 *  The bridge step therefore cannot assume the wallet's current chain is usable — see
 *  `fundedSources` and the switch in Membership.tsx. */
export const SOURCE_CHAINS = [
  { id: 8453, name: 'Base', rpc: 'https://base-rpc.publicnode.com' },
  { id: 42161, name: 'Arbitrum', rpc: 'https://arbitrum-one-rpc.publicnode.com' },
  { id: 10, name: 'Optimism', rpc: 'https://optimism-rpc.publicnode.com' },
  { id: 1, name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com' },
] as const

export type SourceChain = { id: number; name: string; balance: bigint }

/** Can we quote a bridge from this chain at all? */
export const isBridgeSource = (chainId: number): boolean =>
  SOURCE_CHAINS.some((c) => c.id === chainId)

/** Below this a balance is dust — not enough to cover ~$1 of membership plus source-chain gas. */
export const DUST = 250_000_000_000_000n // 0.00025 ETH

/** Where does this wallet actually hold gas? Read every supported source chain at once and
 *  return them richest-first, so the flow can move the wallet somewhere it can pay from instead
 *  of failing on whichever chain sign-in happened to leave it on. Best-effort per chain: one
 *  unreachable RPC must not sink the others. */
export async function fundedSources(address: Address): Promise<SourceChain[]> {
  const read = async (c: (typeof SOURCE_CHAINS)[number]): Promise<SourceChain> => {
    try {
      const client = createPublicClient({ transport: http(c.rpc) })
      return { id: c.id, name: c.name, balance: await client.getBalance({ address }) }
    } catch {
      return { id: c.id, name: c.name, balance: 0n }
    }
  }
  const all = await Promise.all(SOURCE_CHAINS.map(read))
  return all.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))
}
