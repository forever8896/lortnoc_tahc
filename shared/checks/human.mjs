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
// Credential presets on the wire (public): 0 = proof_of_human (Orb), 1 = selfie (Selfie Check),
// 2 = identity (World ID Identity Check on NATIONALITY, preview — the reader's passport must match
// `country`, ISO 3166-1 alpha-3). The country is public in the post: readers must know who may read.
// Heaviest credential there is (an NFC-scanned passport); an author's opt-in for spaces that need a
// national boundary, never a default — it also shuts out refugees and people without a passport.
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
const PRESETS = ['poh', 'selfie', 'identity']
const LABEL = { poh: 'Verified human (World ID)', selfie: 'Verified human (World ID Selfie Check)', identity: 'Citizens of' }

export default {
  id: 'human',
  tag: 17,
  kind: 'attested',
  flags: { gateHoldsShare: true, worldSeesCounts: true },
  validate(node) {
    if (node.preset !== undefined && !PRESETS.includes(node.preset)) throw new Error('human: unknown preset')
    if (node.space !== undefined && !/^@?[a-z0-9-]{3,32}$/.test(node.space)) throw new Error('human: bad space name')
    if (node.preset === 'identity' && !/^[A-Z]{3}$/.test(node.country ?? '')) throw new Error('human: nationality needs a 3-letter country code (e.g. UKR)')
  },
  describe: (p) => (p.preset === 'identity' ? `Citizens of ${p.country} (World ID passport)` : LABEL[p.preset ?? 'poh']) + (p.space ? ` · members of ${p.space.startsWith('@') ? `${p.space.slice(1)}.space.lortnoctahc.eth` : p.space}` : ''),
  encodeParams(node) {
    const space = enc.encode(node.space ?? '')
    const country = node.preset === 'identity' ? [...enc.encode(node.country)] : []
    return [PRESETS.indexOf(node.preset ?? 'poh'), space.length, ...space, ...country]
  },
  decodeParams(bytes, at) {
    const preset = PRESETS[bytes[at]]
    const n = bytes[at + 1]
    if (!preset || n > 33 || at + 2 + n > bytes.length) throw new Error('human: bad params')
    const space = n ? dec.decode(bytes.subarray(at + 2, at + 2 + n)) : undefined
    let end = at + 2 + n
    let country
    if (preset === 'identity') {
      if (end + 3 > bytes.length) throw new Error('human: bad params')
      country = dec.decode(bytes.subarray(end, end + 3))
      end += 3
    }
    return { params: { preset, ...(space ? { space } : {}), ...(country ? { country } : {}), fromWire: true }, at: end }
  },
  async seal(ctx, share, node) {
    if (!ctx.deposit) throw new Error('human: needs a gate to deposit with')
    const ref = await ctx.deposit({ check: 'human', preset: node.preset ?? 'poh', ...(node.space ? { space: node.space } : {}), ...(node.country ? { country: node.country } : {}) }, share, ctx)
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
    async challenge(stored, req, state, services) {
      if (!services.world) return { deny: 'World ID is not configured on this gate' }
      const { preset, space, country } = stored.params
      const known = !space ? true
        : space.startsWith('@') ? await services.ensSpaces?.exists(space) : services.spaces?.exists(space)
      if (!known) return { deny: `the space "${space}" does not exist` }
      const action = services.world.actionFor(stored.ref, space)
      return { request: services.world.challenge(stored.ref, req.readerPub, state, preset, action, country, req.env) }
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
      // ENS spaces: the ban list is the space's own ENS record — owner- and moderator-written.
      if (space.startsWith('@') && (await services.ensSpaces?.isBanned(space, m.memberId))) return { deny: 'You are banned from this space.' }
      return { ok: true, member: { space, memberId: m.memberId } }
    },
  },
}
