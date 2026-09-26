// SEALED posts — a hidden message that says nothing about itself (docs/PRD-universal.md §24).
//
// The earlier web frame (webframe.mjs, mode 5) carries its policy in the clear: anyone with the
// extension — or anyone who reads this open-source format — can tell a post is ours AND read who it
// is for ("Citizens of UKR", "members of lentil-club", the unlock time). A censor needs no key to
// search for that. A sealed post carries no marker, no shape, no hint and no count of its checks:
// without a key it is uniformly random bytes, and the only way to learn anything about it is to
// open it. So a reader's extension simply TRIES what they have ("the keyring"), and posts they cannot
// open never appear as anything but ordinary text.
//
// ---------------------------------------------------------------------------
// WIRE FORMAT (everything uniformly random without a key)
// ---------------------------------------------------------------------------
//   salt(8) ‖ ref(8) ‖ slot(20) × SLOTS ‖ AES-SIV body
//
//   salt   fresh per post
//   ref    the gate's reference for this post's gate-held checks — RANDOM when there are none, so a
//          gate post and a passphrase post look the same
//   slot   an inline check's key share, wrapped: (share ⊕ m[0:16]) ‖ H(m[16:36] ‖ share)[0:4] with
//          m = HKDF(leafKey, salt, "lortnoc/sealed/slot/v1" ‖ i, 36). Unused slots are random.
//          The 4-byte tag only tells a reader "this key fits this slot"; the body's tag decides.
//   body   AES-SIV(CEK = HKDF(root, salt, LABEL_CEK, 64), AD = salt ‖ ref ‖ slots)
//          plaintext: version(1) ‖ flags(1: bit0 squeezed) ‖ shapeLen(2) ‖ shape ‖ message
//          The shape (policy.mjs encoding, public params only) is INSIDE: a reader who opened the
//          post learns what it asked for; nobody else does.
//
// Policies are CNF — rows AND together, the checks in a row OR together (exactly the builder's
// "Readers must [a] or [b], and [c]"). Row i gets a random share r_i, the last one r_n = root ⊕ …;
// every check in a row carries that row's share. A reader collects every share their keys produce
// (slots they can unwrap + shares the gate releases to them) and tries the XOR of each subset: with
// one share per row the XOR is the root. No shape is needed to open, so none is published.
//
// Keys:
//   passphrase — passKey(p) = Argon2id(normalised p, fixed salt). Fixed, so a reader's keyring stores
//                the derived key once instead of running Argon2id per post per passphrase.
//                Honest limit: an attacker's guess is then testable against every post at once — a
//                trivia answer falls fast; the generated five words (55 bits) do not.
//   public     — a constant everyone with the extension has: obfuscation, never a lock.
//   gate checks (after, human, nft) — no slot; the gate stores their shares under `ref` and releases
//                them to a reader whose connected credentials satisfy the stored params.
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { argon2id } from '@noble/hashes/argon2.js'
import { aessiv } from '@noble/ciphers/aes.js'
import { encodeShape, decodeShape, kind, moduleFor, describe, honesty } from './policy.mjs'
import { normalisePassphrase } from './checks/passphrase.mjs'
import { squeezeIfSmaller, unsqueezeMaybe } from './squeeze.mjs'

const enc = new TextEncoder()
export const SEALED_VERSION = 1
export const SALT_LEN = 8
export const REF_LEN = 8
export const SLOTS = 2
export const SLOT_LEN = 20
const SHARE = 16
const HEAD = SALT_LEN + REF_LEN + SLOTS * SLOT_LEN
const LABEL_CEK = enc.encode('lortnoc/sealed/cek/v1')
const LABEL_SLOT = enc.encode('lortnoc/sealed/slot/v1')
const PASS_SALT = enc.encode('lortnoc/sealed/pass/v1')
/** Argon2id for keyring passphrases (RFC 9106's second profile, the same cost as the knock). */
export const PASS_KDF = Object.freeze({ t: 2, m: 19456, p: 1 })
/** Cap on the shares a reader combines — 2^n XORs are tried. */
const MAX_SHARES = 10

const rand = (n) => crypto.getRandomValues(new Uint8Array(n))
const xor = (a, b) => a.map((x, i) => x ^ b[i])
const cat = (...p) => {
  const o = new Uint8Array(p.reduce((a, x) => a + x.length, 0))
  let at = 0
  for (const x of p) (o.set(x, at), (at += x.length))
  return o
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

/** The keyring key for a passphrase. Case and spacing never matter (normalisePassphrase). */
export function passKey(passphrase) {
  const norm = normalisePassphrase(passphrase)
  if (!norm) throw new Error('empty passphrase')
  return argon2id(enc.encode(norm), PASS_SALT, { ...PASS_KDF, dkLen: 32 })
}

/** The key everyone with the extension has — "anyone with lortnoc". Obfuscation, not a lock. */
export const PUBLIC_KEY = sha256(enc.encode('lortnoc/sealed/public/v1'))

const INLINE = new Set(['passphrase', 'public'])

/** policy tree → rows (CNF): leaf | or(leaves) | and(leaf | or(leaves)). Anything deeper is refused. */
export function toRows(policy) {
  const k = kind(policy)
  const leafList = (n) => {
    const kk = kind(n)
    if (kk === 'leaf') return [n]
    if (kk === 'or' && n.or.every((c) => kind(c) === 'leaf')) return n.or
    throw new Error('sealed posts take "a or b, and c or d" rules — nothing nested deeper')
  }
  const rows = k === 'and' ? policy.and.map(leafList) : [leafList(policy)]
  for (const row of rows) for (const leaf of row) {
    const m = moduleFor(leaf)
    m.validate?.(leaf)
    if (!INLINE.has(leaf.check) && m.kind !== 'attested') throw new Error(`"${leaf.check}" cannot be used in a sealed post yet`)
  }
  const inline = rows.flat().filter((l) => INLINE.has(l.check)).length
  if (inline > SLOTS) throw new Error(`at most ${SLOTS} passphrase / anyone rules per post`)
  return rows
}

/** The canonical tree for the shape carried inside the body (rows → and/or/leaf). */
function treeOf(rows) {
  const r = rows.map((row) => (row.length === 1 ? row[0] : { or: row }))
  return r.length === 1 ? r[0] : { and: r }
}

function wrapSlot(key, salt, i, share) {
  const m = hkdf(sha256, key, salt, cat(LABEL_SLOT, [i]), 36)
  return cat(xor(share, m.subarray(0, 16)), sha256(cat(m.subarray(16), share)).subarray(0, 4))
}
function unwrapSlot(key, salt, i, slot) {
  const m = hkdf(sha256, key, salt, cat(LABEL_SLOT, [i]), 36)
  const share = xor(slot.subarray(0, 16), m.subarray(0, 16))
  return same(sha256(cat(m.subarray(16), share)).subarray(0, 4), slot.subarray(16, 20)) ? share : null
}

/**
 * Author side: message + policy → the bytes handed to the codec.
 * @param {string} text
 * @param {object} policy  tree from the builder (secrets included: passphrases)
 * @param {{gateSeal?: (items: {leaf: object, share: Uint8Array}[]) => Promise<Uint8Array>}} opts
 *   gateSeal stores the gate checks' shares and returns the 8-byte ref. Only called if there are any.
 */
export async function sealPost(text, policy, { gateSeal } = {}) {
  const rows = toRows(policy)
  const root = rand(SHARE)
  const shares = rows.map(() => rand(SHARE))
  shares[shares.length - 1] = shares.slice(0, -1).reduce(xor, root)
  const salt = rand(SALT_LEN)

  const slots = []
  const gateItems = []
  rows.forEach((row, r) => {
    for (const leaf of row) {
      if (leaf.check === 'public') slots.push(wrapSlot(PUBLIC_KEY, salt, slots.length, shares[r]))
      else if (leaf.check === 'passphrase') slots.push(wrapSlot(leaf.key ?? passKey(leaf.passphrase), salt, slots.length, shares[r]))
      else gateItems.push({ leaf, share: shares[r] })
    }
  })
  while (slots.length < SLOTS) slots.push(rand(SLOT_LEN))
  let ref
  if (gateItems.length) {
    if (!gateSeal) throw new Error('this post needs the gate')
    ref = await gateSeal(gateItems)
    if (!(ref instanceof Uint8Array) || ref.length !== REF_LEN) throw new Error('bad reference from the gate')
  } else ref = rand(REF_LEN)

  const { bytes, compressed } = squeezeIfSmaller(text)
  const shape = Uint8Array.from(encodeShape(treeOf(rows)))
  const inner = cat([SEALED_VERSION, compressed ? 1 : 0, shape.length >> 8, shape.length & 255], shape, bytes)
  const head = cat(salt, ref, ...slots)
  const cek = hkdf(sha256, root, salt, LABEL_CEK, 64)
  return cat(head, aessiv(cek, head).encrypt(inner))
}

/** The gate reference of a (possible) sealed post — any bytes long enough have one. */
export function sealedRef(frame) {
  return frame && frame.length > HEAD + 16 ? frame.subarray(SALT_LEN, SALT_LEN + REF_LEN) : null
}

/**
 * Reader side: try the keyring. Knows nothing about the post beforehand.
 * @param {Uint8Array} frame
 * @param {{keys?: Uint8Array[], gateShares?: Uint8Array[]}} have
 *   keys — passphrase keys (passKey) — PUBLIC_KEY is always tried; gateShares — released by the gate
 * @returns {Promise<null | {text: string, checks: string[], honesty: object, shape: object}>}
 */
export async function openPost(frame, { keys = [], gateShares = [] } = {}) {
  if (!frame || frame.length <= HEAD + 16) return null
  const salt = frame.subarray(0, SALT_LEN)
  const head = frame.subarray(0, HEAD)
  const found = []
  for (let i = 0; i < SLOTS; i++) {
    const slot = frame.subarray(SALT_LEN + REF_LEN + i * SLOT_LEN, SALT_LEN + REF_LEN + (i + 1) * SLOT_LEN)
    for (const k of [PUBLIC_KEY, ...keys]) {
      const s = unwrapSlot(k, salt, i, slot)
      if (s) found.push(s)
    }
  }
  const shares = [...found, ...gateShares.filter((s) => s?.length === SHARE)]
    .filter((s, i, all) => all.findIndex((o) => same(o, s)) === i)
    .slice(0, MAX_SHARES)
  const body = frame.subarray(HEAD)
  for (let mask = 1; mask < 1 << shares.length; mask++) {
    let k = new Uint8Array(SHARE)
    for (let b = 0; b < shares.length; b++) if (mask & (1 << b)) k = xor(k, shares[b])
    let inner
    try {
      inner = aessiv(hkdf(sha256, k, salt, LABEL_CEK, 64), head).decrypt(body)
    } catch {
      continue
    }
    if (inner[0] !== SEALED_VERSION) return null
    const shapeLen = (inner[2] << 8) | inner[3]
    const { node: shape } = decodeShape(inner.subarray(4, 4 + shapeLen), 0)
    const text = unsqueezeMaybe(inner.subarray(4 + shapeLen), (inner[1] & 1) === 1)
    return { text, checks: describe(shape), honesty: honesty(shape), shape }
  }
  return null
}
