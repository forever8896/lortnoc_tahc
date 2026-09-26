// Test helpers for the `nft` check: real EIP-191 signatures (viem local accounts), faked ENS space
// records and faked balances — so the gate's own refusals are exercised without any chain.
import { privateKeyToAccount, generatePrivateKey } from '../../gate/node_modules/viem/_esm/accounts/index.js'
import { createEnsSpaces } from '../../gate/ens-spaces.mjs'
import { createHolders } from '../../gate/holders.mjs'

export const COLLECTION = 'eip155:11155111/erc721:0x00000000000000000000000000000000000000aa'

export function fakeChain() {
  const ens = new Map() // name → { owner, token, bans }
  const balances = new Map() // lowercase address → bigint
  const ensSpaces = createEnsSpaces({ read: async (name) => ens.get(name) ?? { owner: null, token: null, bans: null } })
  const holders = createHolders({ ensSpaces, balanceOf: async (_col, a) => balances.get(a.toLowerCase()) ?? 0n })
  return { ens, balances, ensSpaces, holders }
}

export const wallet = () => privateKeyToAccount(generatePrivateKey())

/** gateReleaser's proofFor for `nft`: challenge → sign with `account` (or a forger) → proof. */
export const nftProofFor = (account, { signer = account } = {}) => async ({ check, ref, readerPub, policyHash, post }) => {
  if (check !== 'nft') return undefined
  const c = await post('/challenge', { ref, readerPub, policyHash })
  if (!c.request) throw new Error(c.deny ?? 'no challenge')
  const sig = await signer.signMessage({ message: c.request.message })
  return { nonce: c.request.nonce, address: account.address, sig }
}
