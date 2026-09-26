// NFT holder checks for ENS spaces (shared/checks/nft.mjs). The collection comes from the space's
// ENS record (gate/ens-spaces.mjs), never from the post.
//
// challenge → a message naming the space, the post reference, the reader key and a single-use nonce.
// verify    → recover the signer (EIP-191), the nonce was issued for this reader and is unused,
//             then ERC-721/1155/20 balanceOf(signer) > 0 on the collection's chain.
import { createPublicClient, http, fallback, verifyMessage, getAddress } from 'viem'
import { mainnet, sepolia, base, baseSepolia, optimism } from 'viem/chains'

const CHAINS = { 1: mainnet, 11155111: sepolia, 8453: base, 84532: baseSepolia, 10: optimism }
// Several RPCs per chain (measured 2026-09-26); viem's fallback moves on when one errors or times out.
const RPC = {
  1: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'],
  11155111: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.gateway.tenderly.co', 'https://1rpc.io/sepolia'],
  8453: ['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://mainnet.base.org'],
  84532: ['https://base-sepolia-rpc.publicnode.com', 'https://sepolia.base.org'],
  10: ['https://optimism-rpc.publicnode.com', 'https://optimism.drpc.org', 'https://mainnet.optimism.io'],
}
const BALANCE_ABI = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }]

/** CAIP-19: eip155:<chainId>/erc721:<address> (erc20 also accepted). */
export function parseCaip19(s) {
  const m = /^eip155:(\d+)\/(erc721|erc20):(0x[0-9a-fA-F]{40})$/.exec(String(s ?? '').trim())
  return m ? { chainId: Number(m[1]), standard: m[2], address: getAddress(m[3]) } : null
}

/** What a reader signs to add a wallet to their keyring (once, not per post). */
export const connectText = (readerPub, nonce) =>
  `lortnoc tahc — connect this wallet to your keyring\nreader: ${readerPub}\nnonce: ${nonce}\n\nSigning costs nothing and moves nothing. Posts for holders of your NFTs will open for you.`

export async function walletSigned({ message, address, sig }) {
  try {
    return await verifyMessage({ address: getAddress(address), message, signature: sig })
  } catch {
    return false
  }
}

export const challengeText = (spaceName, ref, readerPub, nonce) =>
  `lortnoc tahc — prove you hold this space's NFT\nspace: ${spaceName}\npost: ${ref}\nreader: ${readerPub}\nnonce: ${nonce}\n\nSigning costs nothing and moves nothing.`

export function createHolders({ ensSpaces, balanceOf, now = () => Date.now() } = {}) {
  const balance = balanceOf ?? (async ({ chainId, address }, holder) => {
    const chain = CHAINS[chainId]
    if (!chain) throw new Error(`unsupported chain ${chainId}`)
    const c = createPublicClient({ chain, transport: fallback(RPC[chainId].map((u) => http(u, { timeout: 8_000 }))) })
    return c.readContract({ address, abi: BALANCE_ABI, functionName: 'balanceOf', args: [holder] })
  })

  const held = new Map() // `${space}|${address}` → { at, yes } — balances change, so only briefly
  return {
    /** Does `address` hold the NFT collection that `space`'s ENS record names? (cached 60 s) */
    async holds(space, address) {
      const k = `${space}|${address.toLowerCase()}`
      const hit = held.get(k)
      if (hit && now() - hit.at < 60_000) return hit.yes
      const sp = await ensSpaces?.get(space)
      const col = sp?.exists ? parseCaip19(sp.token) : null
      const yes = !!col && BigInt(await balance(col, getAddress(address))) > 0n
      held.set(k, { at: now(), yes })
      return yes
    },
    async challenge(stored, readerPub, state) {
      const sp = await ensSpaces?.get(stored.params.space)
      if (!sp?.exists) return { deny: `the space "${stored.params.space}" does not exist` }
      if (!parseCaip19(sp.token)) return { deny: 'this space has no NFT collection set' }
      const nonce = crypto.randomUUID()
      state.set(`nonce:${nonce}`, JSON.stringify({ readerPub, at: now() }))
      return { request: { message: challengeText(sp.name, stored.ref, readerPub, nonce), nonce, collection: sp.token } }
    },

    /** @returns {Promise<{ok: true, address: string} | {deny: string}>} */
    async verify(stored, req, state) {
      const p = req.proof
      if (!p?.nonce || !p?.address || !p?.sig) return { deny: 'no wallet signature' }
      const issued = state.get(`nonce:${p.nonce}`)
      if (!issued) return { deny: 'challenge was not issued by this gate' }
      const n = JSON.parse(issued)
      if (n.used) return { deny: 'challenge already used' }
      if (n.readerPub !== req.readerPub) return { deny: 'challenge was requested by a different reader' }
      if (now() - n.at > 10 * 60_000) return { deny: 'challenge expired' }
      state.set(`nonce:${p.nonce}`, JSON.stringify({ ...n, used: true }))
      const sp = await ensSpaces.get(stored.params.space)
      const col = parseCaip19(sp?.token)
      if (!col) return { deny: 'this space has no NFT collection set' }
      const message = challengeText(sp.name, stored.ref, req.readerPub, p.nonce)
      let ok = false
      try {
        ok = await verifyMessage({ address: getAddress(p.address), message, signature: p.sig })
      } catch {}
      if (!ok) return { deny: 'the signature is not from that wallet' }
      let bal = 0n
      try {
        bal = BigInt(await balance(col, getAddress(p.address)))
      } catch (e) {
        return { deny: `could not read the collection (${e.message ?? e})` }
      }
      if (bal <= 0n) return { deny: "that wallet doesn't hold this space's NFT" }
      return { ok: true, address: getAddress(p.address) }
    },
  }
}
