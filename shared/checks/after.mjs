// `after` — opens only after a moment in time. The first ATTESTED check: its share is held by the
// gate, which releases it once the time has passed.
//
// It exists first among attested checks on purpose (PRD §16.4): it exercises the whole gate path —
// deposit, sealed release, reference binding — with zero external dependencies, so World ID, token
// and space checks plug into plumbing that is already proven.
//
// Honest limit (flags.gateHoldsShare): the gate operator holds this share, so a post locked ONLY by
// `after` is readable by the gate operator at any time. Combine it with a passphrase to avoid that.

export const REF_LEN = 8

export default {
  id: 'after',
  tag: 16,
  kind: 'attested',
  flags: { gateHoldsShare: true },
  validate(node) {
    if (!Number.isFinite(node.after) || node.after <= 0) throw new Error('after: needs a time (ms since epoch)')
  },
  describe: (p) => `Opens after ${new Date(p.after).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  // The unlock time is PUBLIC (in the shape): a reader should know when to come back.
  encodeParams(node) {
    const s = Math.floor(node.after / 1000)
    return [(s >>> 24) & 255, (s >>> 16) & 255, (s >>> 8) & 255, s & 255]
  },
  decodeParams(bytes, at) {
    if (at + 4 > bytes.length) throw new Error('after: truncated')
    const s = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
    return { params: { after: s * 1000, fromWire: true }, at: at + 4 }
  },
  async seal(ctx, share, node) {
    if (!ctx.deposit) throw new Error('after: needs a gate to deposit with')
    const ref = await ctx.deposit({ check: 'after', after: Math.floor(node.after / 1000) * 1000 }, share, ctx)
    if (!(ref instanceof Uint8Array) || ref.length !== REF_LEN) throw new Error('after: bad reference from gate')
    return ref
  },
  readMaterial: (bytes, at) => ({ material: bytes.subarray(at, at + REF_LEN), at: at + REF_LEN }),
  async open(ctx, ref, node) {
    const share = await ctx.inputs.release?.({ check: 'after', ref, params: node, policyHash: ctx.policyHash })
    return share ? [share] : []
  },
  // Gate side: decides against what was STORED at deposit, never what the post claims.
  gate: {
    async release(stored) {
      return Date.now() >= stored.params.after ? true : { deny: 'not yet', retryAt: stored.params.after }
    },
    // Sealed posts: nothing to prove — the post simply appears once its time has come.
    async unlock(stored) {
      return Date.now() >= stored.params.after
    },
  },
}
