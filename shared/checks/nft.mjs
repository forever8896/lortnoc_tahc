// `nft` — only holders of the space's NFT collection can open it. Attested, and bound to an ENS
// space (docs/PRD-universal.md §22–23): the COLLECTION is not in the post, it is the space's ENS
// record `eth.lortnoc.space.token` — so the owner can change it, and the post never names it.
//
// The reader signs a gate challenge (EIP-191) with the wallet that holds the NFT; the gate recovers
// the address, reads balanceOf on the collection's chain, and releases the share. The wallet then
// stands in for a World ID nullifier: the gate derives a stable pseudonym from it, so "sign as
// member" and ENS bans work exactly as in World ID spaces.
//
// Honest limits, stated in the UI: the gate learns which wallet read (a wallet is public by nature);
// a banned holder can move the NFT to a fresh wallet and come back — pair with World ID when bans
// must stick to a person rather than a wallet.

export const REF_LEN = 8
const enc = new TextEncoder()
const dec = new TextDecoder()

export default {
  id: 'nft',
  tag: 18,
  kind: 'attested',
  flags: { gateHoldsShare: true, revealsWallet: true },
  validate(node) {
    if (!/^@[a-z0-9-]{3,32}$/.test(node.space ?? '')) throw new Error('nft: needs an ENS space (@name)')
  },
  describe: (p) => `Holders of ${p.space.slice(1)}.space.lortnoctahc.eth's NFT`,
  encodeParams(node) {
    const s = enc.encode(node.space)
    return [s.length, ...s]
  },
  decodeParams(bytes, at) {
    const n = bytes[at]
    if (!(n >= 4 && n <= 33) || at + 1 + n > bytes.length) throw new Error('nft: bad params')
    return { params: { space: dec.decode(bytes.subarray(at + 1, at + 1 + n)), fromWire: true }, at: at + 1 + n }
  },
  async seal(ctx, share, node) {
    if (!ctx.deposit) throw new Error('nft: needs a gate to deposit with')
    const ref = await ctx.deposit({ check: 'nft', space: node.space }, share, ctx)
    if (!(ref instanceof Uint8Array) || ref.length !== REF_LEN) throw new Error('nft: bad reference from gate')
    return ref
  },
  readMaterial: (bytes, at) => ({ material: bytes.subarray(at, at + REF_LEN), at: at + REF_LEN }),
  async open(ctx, ref, node) {
    const share = await ctx.inputs.release?.({ check: 'nft', ref, params: node, policyHash: ctx.policyHash })
    return share ? [share] : []
  },
  // Gate side — services.holders is gate/holders.mjs.
  gate: {
    async challenge(stored, req, state, services) {
      if (!services.holders) return { deny: 'NFT checks are not configured on this gate' }
      return services.holders.challenge(stored, req.readerPub, state)
    },
    async release(stored, req, state, services) {
      if (!services.holders) return { deny: 'NFT checks are not configured on this gate' }
      const v = await services.holders.verify(stored, req, state)
      if (!v.ok) return v
      const m = services.spaces.admit(stored.params.space, `wallet:${v.address.toLowerCase()}`, req.memberPub)
      if (m.deny) return m
      if (await services.ensSpaces?.isBanned(stored.params.space, m.memberId)) return { deny: 'You are banned from this space.' }
      return { ok: true, member: { space: stored.params.space, memberId: m.memberId } }
    },
  },
}
