// Paid membership on 0G (§7) — the client half.
//
// Payment, registration and membership are one act: `join()` inserts your Semaphore identity
// commitment into the paid-members set. Nothing about that transaction says which handle it will
// become; that link is severed by the proof you generate later.
//
// Everything here runs against 0G MAINNET (16661) — real value — and the identity secret is
// derived from MS, so it never leaves the device.
import {
  createPublicClient, createWalletClient, custom, defineChain, http, parseAbi,
  type Address, type Hex, type WalletClient,
} from 'viem'
import zerog from './zerog-deployment.json'

export const zeroGChain = defineChain({
  id: 16661,
  name: '0G',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: { default: { http: ['https://evmrpc.0g.ai'] } },
  blockExplorers: { default: { name: '0G Scan', url: 'https://chainscan.0g.ai' } },
})

export const MEMBERSHIP = (zerog.mainnet?.membership ?? '') as Address
export const membershipReady = (): boolean => !!MEMBERSHIP

export const membershipAbi = parseAbi([
  'function join(uint256 commitment) payable',
  'function price() view returns (uint256)',
  'function memberCount() view returns (uint256)',
  'function joined(uint256 commitment) view returns (bool)',
  'function spent(uint256 nullifier) view returns (bool)',
])

export const zeroG = createPublicClient({ chain: zeroGChain, transport: http(zeroGChain.rpcUrls.default.http[0]) })

/** Membership price in wei of 0G. Read live — it is repriced as the token moves so the
 *  dollar cost stays put. */
export async function price(): Promise<bigint> {
  if (!membershipReady()) throw new Error('membership contract not deployed yet')
  return zeroG.readContract({ address: MEMBERSHIP, abi: membershipAbi, functionName: 'price' })
}

export async function memberCount(): Promise<bigint> {
  if (!membershipReady()) return 0n
  return zeroG.readContract({ address: MEMBERSHIP, abi: membershipAbi, functionName: 'memberCount' })
}

export async function isMember(commitment: bigint): Promise<boolean> {
  if (!membershipReady()) return false
  return zeroG.readContract({ address: MEMBERSHIP, abi: membershipAbi, functionName: 'joined', args: [commitment] })
}

export const balanceOn0G = (address: Address): Promise<bigint> => zeroG.getBalance({ address })

/** Ask the wallet to move to 0G, adding the network if it has never seen it. */
export async function switchTo0G(client: WalletClient): Promise<void> {
  try {
    await client.switchChain({ id: zeroGChain.id })
  } catch {
    await client.addChain({ chain: zeroGChain })
    await client.switchChain({ id: zeroGChain.id })
  }
}

/** Pay. The only thing this puts on-chain is "some wallet paid, and the member tree grew". */
export async function join(commitment: bigint): Promise<Hex> {
  if (!membershipReady()) throw new Error('membership contract not deployed yet')
  const eth = (window as unknown as { ethereum?: never }).ethereum
  if (!eth) throw new Error('No EVM wallet found.')

  const client = createWalletClient({ chain: zeroGChain, transport: custom(eth) })
  const [account] = await client.requestAddresses()
  await switchTo0G(client)

  const value = await price()
  const balance = await balanceOn0G(account)
  if (balance < value) {
    throw new Error(
      `Not enough 0G: you have ${fmt0G(balance)}, membership costs ${fmt0G(value)}. Bridge first.`,
    )
  }

  // 0G rejects viem's default 1559 + nonce estimation params, so price legacy with explicit gas.
  const gasPrice = await zeroG.getGasPrice()
  const hash = await client.writeContract({
    account, chain: zeroGChain, address: MEMBERSHIP, abi: membershipAbi,
    functionName: 'join', args: [commitment], value, gas: 900_000n, gasPrice,
  })
  const receipt = await zeroG.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 3_000 })
  if (receipt.status !== 'success') throw new Error(`payment reverted (tx ${hash})`)
  return hash
}

/** id_sem → Semaphore identity commitment (§5.1). The secret stays on this device forever. */
export async function commitmentFrom(ms: Uint8Array): Promise<bigint> {
  const { Identity } = await import('@semaphore-protocol/identity')
  const { hkdf } = await import('@noble/hashes/hkdf.js')
  const { sha256 } = await import('@noble/hashes/sha2.js')
  const sem = hkdf(sha256, ms, new TextEncoder().encode('lortnoc/semaphore/v1'), new TextEncoder().encode('sem'), 32)
  const hex = Array.from(sem, (b) => b.toString(16).padStart(2, '0')).join('')
  return new Identity(hex).commitment
}

export const fmt0G = (wei: bigint, dp = 3): string => `${(Number(wei) / 1e18).toFixed(dp)} 0G`

/** Live 0G price, so the UI can show what a membership costs in dollars rather than in a token
 *  nobody prices intuitively. Best-effort: the flow must not break if this fails. */
export async function usdPerZeroG(): Promise<number | null> {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=zero-gravity&vs_currencies=usd')
    const body = await res.json()
    return body?.['zero-gravity']?.usd ?? null
  } catch {
    return null
  }
}
