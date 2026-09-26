// Buying a paid ENS space (PRD §22.7, §23), run in the service worker so it survives the popup
// closing when the wallet pops up:
//   1. generate the space's EVM OWNER key and SAVE IT FIRST — if anything later fails, the key that
//      the purchase names as owner is not lost with the money
//   2. the reader's own wallet (MAIN world on the current page) sends LortnocSpaces.buySpace
//   3. the relayer turns the SpaceBought event into <label>.space.lortnoctahc.eth with the collection
// Progress is kept in storage so the popup shows it when reopened.
import { encodeFunctionData, keccak256, toHex, numberToHex, createPublicClient, http } from 'viem'
import { sepolia, mainnet, base, baseSepolia } from 'viem/chains'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import deployments from '../../../app/src/lib/live/spaces-deployment.json'
import { RELAYER_URL } from '../shared/messages'
import type { SwResponse } from '../shared/messages'
import { saveEnsKey, addEnsSpace } from '../shared/spaces'

const STATE = 'buyState'
const BUY_ABI = [{ type: 'function', name: 'buySpace', stateMutability: 'payable',
  inputs: [{ name: 'label', type: 'string' }, { name: 'spaceOwner', type: 'address' }, { name: 'rulesHash', type: 'bytes32' }],
  outputs: [{ type: 'uint256' }] }] as const

export const rulesHash = (token: string) => keccak256(toHex(`lortnoc/space/rules/v1|${token}`))
const setState = (v: object) => chrome.storage.local.set({ [STATE]: { ...v, at: Date.now() } })
export const buyState = async (): Promise<SwResponse> => ({ ok: true, data: (await chrome.storage.local.get(STATE))[STATE] ?? null })

const COLLECTION_CHAINS = {
  1: [mainnet, 'https://ethereum-rpc.publicnode.com'],
  8453: [base, 'https://base-rpc.publicnode.com'],
  11155111: [sepolia, 'https://ethereum-sepolia-rpc.publicnode.com'],
  84532: [baseSepolia, 'https://base-sepolia-rpc.publicnode.com'],
} as const
const ERC165 = [{ type: 'function', name: 'supportsInterface', stateMutability: 'view', inputs: [{ type: 'bytes4' }], outputs: [{ type: 'bool' }] }] as const

/** null if `token` names an ERC-721 contract that exists; otherwise what is wrong, in plain words. */
export async function checkCollection(token: string): Promise<string | null> {
  const m = /^eip155:(\d+)\/erc721:(0x[0-9a-fA-F]{40})$/.exec(token)
  if (!m) return 'Enter the NFT collection as a chain and a contract address.'
  const entry = COLLECTION_CHAINS[Number(m[1]) as keyof typeof COLLECTION_CHAINS]
  if (!entry) return `Collections on chain ${m[1]} are not supported yet.`
  const [chain, rpc] = entry
  const c = createPublicClient({ chain, transport: http(rpc) })
  const address = m[2] as `0x${string}`
  // viem returns undefined for "no code here" — so a network failure gets its own sentinel
  const code = await c.getCode({ address }).catch(() => 'unreachable' as const)
  if (code === 'unreachable') return `Could not reach ${chain.name} to check the collection — try again.`
  if (!code || code === '0x') return `There is no contract at ${address} on ${chain.name}. Check the chain and the address.`
  const is721 = await c.readContract({ address, abi: ERC165, functionName: 'supportsInterface', args: ['0x80ac58cd'] }).catch(() => false)
  if (!is721) return `The contract at ${address} on ${chain.name} is not an ERC-721 NFT collection.`
  return null
}

/** Is <label>.space.lortnoctahc.eth still free? (A space always has addr = owner, so a resolving
 *  address means taken.) Used live by the full page as the buyer types. */
export async function spaceAvailable(label: string): Promise<SwResponse> {
  if (!/^[a-z0-9-]{3,32}$/.test(label) || label.startsWith('-') || label.endsWith('-')) return { ok: true, data: { valid: false } }
  const taken = await createPublicClient({ chain: sepolia, transport: http('https://ethereum-sepolia-rpc.publicnode.com') })
    .getEnsAddress({ name: `${label}.space.lortnoctahc.eth` }).catch(() => undefined)
  return taken === undefined ? { ok: false, error: 'could not check' } : { ok: true, data: { valid: true, available: !taken } }
}

export async function buySpace(req: { label: string; token: string; chainId: 1 | 11155111; tabId: number }): Promise<SwResponse> {
  const { label, token, chainId, tabId } = req
  if (!/^[a-z0-9-]{3,32}$/.test(label) || label.startsWith('-') || label.endsWith('-')) return { ok: false, error: 'bad space name' }
  const dep = (deployments as Record<string, { address: `0x${string}`; price: string; chainId: number }>)[chainId === 1 ? 'mainnet' : 'sepolia']
  if (!dep) return { ok: false, error: 'no LortnocSpaces on that chain' }

  // 0. is the name still free? A Sepolia demo purchase can take a name first, and a mainnet buyer
  //    would then pay and be refused by the relayer (409). Check ENS BEFORE any money moves. A space
  //    always has addr = owner, so a resolving address means the name is taken.
  const taken = await createPublicClient({ chain: sepolia, transport: http('https://ethereum-sepolia-rpc.publicnode.com') })
    .getEnsAddress({ name: `${label}.space.lortnoctahc.eth` }).catch(() => null)
  if (taken) return { ok: false, error: `${label}.space.lortnoctahc.eth is already taken` }

  // 0b. the collection is a real ERC-721 contract on the chain named — a typo here would sell a space
  //     nobody can ever read, and the rules are committed on-chain at purchase, so check BEFORE paying.
  const bad = await checkCollection(token)
  if (bad) return { ok: false, error: bad }

  // 1. the owner key, saved before a single wei moves
  const priv = generatePrivateKey()
  const owner = privateKeyToAccount(priv).address
  await saveEnsKey(label, { priv, address: owner, role: 'owner' })
  await setState({ label, step: 'waiting for your wallet', owner })

  // 2. the buyer's wallet pays, on the current page
  const data = encodeFunctionData({ abi: BUY_ABI, functionName: 'buySpace', args: [label, owner, rulesHash(token)] })
  const [r] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    args: [numberToHex(chainId), dep.address, data, numberToHex(BigInt(dep.price))],
    func: async (chainHex: string, to: string, data: string, value: string) => {
      const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum
      if (!eth) return { error: 'No wallet found on this page (MetaMask, Rabby, …).' }
      try {
        await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex }] })
        const [from] = (await eth.request({ method: 'eth_requestAccounts' })) as string[]
        const hash = await eth.request({ method: 'eth_sendTransaction', params: [{ from, to, data, value }] })
        return { hash }
      } catch (e) {
        return { error: (e as { message?: string })?.message ?? 'The wallet declined.' }
      }
    },
  }).catch((e) => [{ result: { error: String(e) } }])
  const tx = r?.result as { hash?: string; error?: string }
  if (!tx?.hash) {
    await setState({ label, step: 'failed', error: tx?.error ?? 'no transaction', owner })
    return { ok: false, error: tx?.error ?? 'no transaction' }
  }
  await setState({ label, step: 'paid — creating the ENS name', txHash: tx.hash, owner })

  // 3. the relayer mints the space (it waits for confirmations; retry while it says "pending")
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${RELAYER_URL}/space`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chainId, txHash: tx.hash, label, token }),
    }).then((x) => x.json()).catch(() => ({}))
    if (res?.name) {
      await addEnsSpace(label)
      await setState({ label, step: 'done', name: res.name, txHash: tx.hash, owner })
      return { ok: true, data: res }
    }
    if (res?.error && !/pending|confirm|not found|not yet/i.test(res.error)) {
      await setState({ label, step: 'failed', error: res.error, txHash: tx.hash, owner })
      return { ok: false, error: res.error }
    }
    await new Promise((z) => setTimeout(z, 6000))
  }
  await setState({ label, step: 'failed', error: 'the relayer did not finish — the payment is on-chain; retry later', txHash: tx.hash, owner })
  return { ok: false, error: 'relayer timeout' }
}
