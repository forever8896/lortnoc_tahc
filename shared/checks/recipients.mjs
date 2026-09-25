// `recipients` — named people, by their X25519 messaging key (ENS eth.lortnoc.pubkey).
//
// The recipient SET is hidden, as in X Mode 3 (shared/envelope.mjs): the post carries one
// ephemeral pubkey and one 16-byte wrap per recipient, and nothing that says whose. The COUNT is
// public — it is in the shape, and the length scales with it. Resolving a handle to its key is the
// caller's job (the extension's ENS reader), so this module never touches the network.
//
// K_i = deriveConvKey(ephemeral, recipient) — the SAME ECDH the Telegram handshake and Mode 3 use,
// so the project keeps one ECDH implementation. The mask is then bound to (nonce, path, index) by
// ctx.mask, which is what makes a wrap single-use.
import { deriveConvKey, genKeyPair, fromHex } from '../keys.mjs'

const LABEL = 'lortnoc/policy/recip/v1'
export const MAX_RECIPIENTS = 16
const asBytes = (k) => (typeof k === 'string' ? fromHex(k) : k)

export default {
  id: 'recipients',
  tag: 3,
  kind: 'inline',
  flags: {},
  validate(node) {
    const n = node.fromWire ? node.count : node.recipients?.length
    if (!(n >= 1 && n <= MAX_RECIPIENTS)) throw new Error(`recipients: 1..${MAX_RECIPIENTS}`)
    if (!node.fromWire) for (const k of node.recipients) if (asBytes(k).length !== 32) throw new Error('recipients: bad pubkey')
  },
  describe: (p) => {
    const n = p.count ?? p.recipients?.length
    return n === 1 ? 'One named person' : `${n} named people`
  },
  encodeParams: (node) => [node.recipients.length],
  decodeParams(bytes, at) {
    const count = bytes[at]
    if (!(count >= 1 && count <= MAX_RECIPIENTS)) throw new Error('recipients: bad count')
    return { params: { count, fromWire: true }, at: at + 1 }
  },
  async seal(ctx, share, node) {
    const eph = genKeyPair()
    const wraps = node.recipients.map((k, j) =>
      ctx.xor(share, ctx.mask(deriveConvKey(eph.priv, asBytes(k), eph.pub), LABEL, [j])),
    )
    return new Uint8Array([...eph.pub, ...wraps.flatMap((w) => [...w])])
  },
  readMaterial(bytes, at, node) {
    const end = at + 32 + 16 * node.count
    return { material: { eph: bytes.subarray(at, at + 32), wraps: bytes.subarray(at + 32, end) }, at: end }
  },
  async open(ctx, m, node) {
    const me = ctx.inputs.msgKey
    if (!me) return []
    const k = deriveConvKey(me.priv, m.eph, me.pub)
    // The reader cannot tell which wrap is theirs — that is the property — so each is a candidate
    // and the body tag picks. N <= 16 AES-SIV attempts on a small body is nothing.
    return Array.from({ length: node.count }, (_, j) =>
      ctx.xor(m.wraps.subarray(j * 16, j * 16 + 16), ctx.mask(k, LABEL, [j])),
    )
  },
}
