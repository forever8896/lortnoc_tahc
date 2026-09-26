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
//
// SPACES (optional `space` param, public): the World ID action becomes one per SPACE instead of one
// per post, so the same human always yields the same nullifier there. The gate turns that into a
// stable pseudonym (member-xxxxxx), and a space owner's ban on it sticks — a banned person who
// re-verifies, even from a new World App account, gets the same nullifier and stays out
// (shared/member.mjs, gate/spaces.mjs). With Selfie Check a determined person may get a second
// identity; with Proof of Human (Orb) they cannot — say so when bans matter.

export const REF_LEN = 8
const enc = new TextEncoder()
const dec = new TextDecoder()
const PRESETS = ['poh', 'selfie']
const LABEL = { poh: 'Verified human (World ID)', selfie: 'Verified human (World ID Selfie Check)' }

export default {
  id: 'human',
  tag: 17,
  kind: 'attested',
  flags: { gateHoldsShare: true, worldSeesCounts: true },
  validate(node) {
    if (node.preset !== undefined && !PRESETS.includes(node.preset)) throw new Error('human: unknown preset')
    if (node.space !== undefined && !/^[a-z0-9-]{3,32}$/.test(node.space)) throw new Error('human: bad space name')
  },
  describe: (p) => LABEL[p.preset ?? 'poh'] + (p.space ? ` · members of ${p.space}` : ''),
  encodeParams(node) {
    const space = enc.encode(node.space ?? '')
    return [PRESETS.indexOf(node.preset ?? 'poh'), space.length, ...space]
  },
  decodeParams(bytes, at) {
    const preset = PRESETS[bytes[at]]
    const n = bytes[at + 1]
    if (!preset || n > 32 || at + 2 + n > bytes.length) throw new Error('human: bad params')
    const space = n ? dec.decode(bytes.subarray(at + 2, at + 2 + n)) : undefined
    return { params: { preset, ...(space ? { space } : {}), fromWire: true }, at: at + 2 + n }
  },
  async seal(ctx, share, node) {
    if (!ctx.deposit) throw new Error('human: needs a gate to deposit with')
    const ref = await ctx.deposit({ check: 'human', preset: node.preset ?? 'poh', ...(node.space ? { space: node.space } : {}) }, share, ctx)
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
      const { preset, space } = stored.params
      if (space && !services.spaces?.exists(space)) return { deny: `the space "${space}" is not registered on this gate` }
      const action = services.world.actionFor(stored.ref, space)
      return { request: services.world.challenge(stored.ref, req.readerPub, state, preset, action) }
    },
    async release(stored, req, state, services) {
      if (!services.world) return { deny: 'World ID is not configured on this gate' }
      const { preset, space } = stored.params
      const action = services.world.actionFor(stored.ref, space)
      const v = await services.world.verify(req.proof, { ref: stored.ref, readerPub: req.readerPub, preset, action }, state)
      if (!v.ok) return v
      state.set(`nullifier:${v.nullifier}`, String(Date.now())) // a record for quotas, not a refusal
      if (!space) return true
      // In a space: the banned stay out; everyone else is (re)admitted under their stable pseudonym.
      const m = services.spaces.admit(space, v.nullifier, req.memberPub)
      if (m.deny) return m
      return { ok: true, member: { space, memberId: m.memberId } }
    },
  },
}
