// `human` — only a verified human (World ID) can open it. Attested: the gate holds the share and
// releases it for a valid World ID proof bound to THIS post and THIS reader (gate/world.mjs).
//
// What it is for, honestly (PRD §22.5): keeping bots and sock-puppet swarms out of a space. It does
// NOT prove gender, nationality or anything else about the reader — World ID's credentials cannot
// (verified against IDKit 4.3 types) — and a creator must never be told it does. It is always an
// OPTIONAL check an author chooses for readers; nobody needs World ID to write.
//
// Privacy, stated: the gate learns an anonymous per-post nullifier for each reader (not who they
// are); World's portal learns how many verifications each post's action gets. A post locked ONLY by
// `human` is readable by the gate operator (flags.gateHoldsShare) — pair it with a passphrase to
// close that.
//
// Credential presets on the wire (public): 0 = proof_of_human (Orb), 1 = selfie (Selfie Check).

export const REF_LEN = 8
const PRESETS = ['poh', 'selfie']
const LABEL = { poh: 'Verified human (World ID)', selfie: 'Verified human (World ID Selfie Check)' }

export default {
  id: 'human',
  tag: 17,
  kind: 'attested',
  flags: { gateHoldsShare: true, worldSeesCounts: true },
  validate(node) {
    if (node.preset !== undefined && !PRESETS.includes(node.preset)) throw new Error('human: unknown preset')
  },
  describe: (p) => LABEL[p.preset ?? 'poh'],
  encodeParams: (node) => [PRESETS.indexOf(node.preset ?? 'poh')],
  decodeParams(bytes, at) {
    const preset = PRESETS[bytes[at]]
    if (!preset) throw new Error('human: bad preset')
    return { params: { preset, fromWire: true }, at: at + 1 }
  },
  async seal(ctx, share, node) {
    if (!ctx.deposit) throw new Error('human: needs a gate to deposit with')
    const ref = await ctx.deposit({ check: 'human', preset: node.preset ?? 'poh' }, share, ctx)
    if (!(ref instanceof Uint8Array) || ref.length !== REF_LEN) throw new Error('human: bad reference from gate')
    return ref
  },
  readMaterial: (bytes, at) => ({ material: bytes.subarray(at, at + REF_LEN), at: at + REF_LEN }),
  async open(ctx, ref, node) {
    const share = await ctx.inputs.release?.({ check: 'human', ref, params: node, policyHash: ctx.policyHash })
    return share ? [share] : []
  },
  // Gate side — `services.world` is gate/world.mjs; absent when World is not configured.
  gate: {
    challenge(stored, req, state, services) {
      if (!services.world) return { deny: 'World ID is not configured on this gate' }
      return { request: services.world.challenge(stored.ref, req.readerPub, state, stored.params.preset) }
    },
    async release(stored, req, state, services) {
      if (!services.world) return { deny: 'World ID is not configured on this gate' }
      const v = await services.world.verify(req.proof, { ref: stored.ref, readerPub: req.readerPub, preset: stored.params.preset }, state)
      if (!v.ok) return v
      // One nullifier per human per post. A human may re-open (their proof is new each time only if
      // World App allows; v4 does not), so this is a record for quotas, not a refusal.
      state.set(`nullifier:${v.nullifier}`, String(Date.now()))
      return true
    },
  },
}
