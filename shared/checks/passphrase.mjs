// `passphrase` — anyone who knows the words.
//
// OFFLINE-GUESSABLE, and the UI must say so. The wrap is share ⊕ mask(Argon2id(passphrase)), with no
// tag of its own, but the post's AES-SIV tag confirms a right guess — so anyone holding the post can
// guess offline at Argon2id speed. The knock's defence (online-only guessing behind a rate limit)
// does NOT exist here. Hence: generate() is the default, trivia is never called secure, and
// flags.offlineGuessable feeds the builder's warning.
//
// Estimates (research-tokyo/platform-crypto.md): a trivia answer falls in seconds on one GPU, a
// top-1M password in minutes; five random BIP39 words (55 bits) hold for millennia.
import { argon2id } from '@noble/hashes/argon2.js'
import { wordlist } from '@scure/bip39/wordlists/english'

const enc = new TextEncoder()
const dec = new TextDecoder()
const LABEL = 'lortnoc/policy/pass/v1'
export const MAX_HINT = 60

/** Argon2id profiles, selected by index on the wire. CONSENSUS — append only, never edit. */
export const KDF_PROFILES = Object.freeze([
  Object.freeze({ t: 2, m: 19456, p: 1 }), // 0 — RFC 9106 2nd profile; same as knock.ts DEFAULT_KDF (~0.6 s)
  Object.freeze({ t: 3, m: 65536, p: 1 }), // 1 — "strong", 64 MiB (~1.7 s)
])

/** Case, surrounding space and inner runs of space never make a passphrase wrong. */
export function normalisePassphrase(p) {
  return String(p).normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Five random BIP39 words — 55 bits. The default the builder offers. */
export function generatePassphrase(words = 5) {
  const idx = crypto.getRandomValues(new Uint16Array(words))
  return Array.from(idx, (i) => wordlist[i % 2048]).join(' ') // 65536 % 2048 === 0: no modulo bias
}

function stretch(ctx, passphrase, profile) {
  const prm = (ctx.kdfProfiles ?? KDF_PROFILES)[profile]
  if (!prm) throw new Error(`passphrase: unknown kdf profile ${profile}`)
  const norm = normalisePassphrase(passphrase)
  // The expensive part depends only on (passphrase, nonce, profile) — cached across leaves, so a
  // policy reusing one passphrase in two places costs one Argon2id, and the cheap per-path HKDF in
  // ctx.mask still keeps the two masks distinct.
  const k = `pass|${profile}|${norm}`
  if (!ctx.cache.has(k)) {
    // salt = nonce ‖ label: 8 fresh bytes + domain separation (RFC 9106 minimum is 8)
    const salt = new Uint8Array([...ctx.nonce, ...enc.encode(LABEL)])
    ctx.cache.set(k, argon2id(enc.encode(norm), salt, { ...prm, dkLen: 32 }))
  }
  return ctx.cache.get(k)
}

export default {
  id: 'passphrase',
  tag: 2,
  kind: 'inline',
  flags: { offlineGuessable: true },
  validate(node) {
    if (!normalisePassphrase(node.passphrase ?? '') && !node.fromWire) throw new Error('passphrase: empty')
    if (node.hint && enc.encode(node.hint).length > MAX_HINT) throw new Error(`passphrase: hint over ${MAX_HINT} bytes`)
  },
  describe: (p) => (p.hint ? `Passphrase · hint: ${p.hint}` : 'Passphrase'),
  // PUBLIC params only: the KDF profile and the author's optional hint. Never the passphrase.
  encodeParams(node) {
    const hint = enc.encode(node.hint ?? '')
    return [node.profile ?? 0, hint.length, ...hint]
  },
  decodeParams(bytes, at) {
    const profile = bytes[at]
    const n = bytes[at + 1]
    if (n > MAX_HINT || at + 2 + n > bytes.length) throw new Error('passphrase: bad params')
    const hint = n ? dec.decode(bytes.subarray(at + 2, at + 2 + n)) : undefined
    return { params: { profile, ...(hint ? { hint } : {}), fromWire: true }, at: at + 2 + n }
  },
  async seal(ctx, share, node) {
    return ctx.xor(share, ctx.mask(stretch(ctx, node.passphrase, node.profile ?? 0), LABEL))
  },
  readMaterial: (bytes, at) => ({ material: bytes.subarray(at, at + 16), at: at + 16 }),
  async open(ctx, wrap, node) {
    return (ctx.inputs.passphrases ?? []).map((pw) =>
      ctx.xor(wrap, ctx.mask(stretch(ctx, pw, node.profile ?? 0), LABEL)),
    )
  },
}
