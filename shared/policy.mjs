// The reader-policy engine (docs/PRD-universal.md §4, §16) — who may turn a post back into text.
//
// A policy is a tree: AND / OR over LEAVES, and every leaf is a CHECK plugin from shared/checks/.
// This file knows only the tree. It never knows what a passphrase or a recipient is — a check is
// found by its tag in the registry, and adding one is a new file there, not an edit here.
//
// ---------------------------------------------------------------------------
// THE ONE RULE: a check is only real if it controls a KEY
// ---------------------------------------------------------------------------
// The extension is open source and runs on the reader's machine, so `if (passed) show()` is bypassed
// by editing one line. Every check therefore either DERIVES a share of the key (passphrase,
// recipients) or has one RELEASED to it by the gate (World ID, ENS holder, time). Nothing here is a
// UI gate.
//
//   root  = 16 random bytes
//   CEK   = HKDF(root, salt=nonce, info=LABEL_CEK) → 64 B. noble's aessiv only takes 32/48/64-byte
//           keys; a 16-byte key passed straight in THROWS (measured, research-tokyo/probe.mjs).
//   OR    = every child receives the full key.
//   AND   = children receive XOR shares that recombine to the key; a missing share is no key.
//   body  = AES-SIV(CEK, AD = mode byte ‖ header). The header is nonce ‖ shape ‖ material, so any
//           change to the shape, a wrap or a gate reference fails the tag.
//
// Every leaf's mask is bound to (nonce, tree path) by THIS file, through ctx.mask(). Without the
// path, OR(AND(a,b), AND(a,c)) with one passphrase gives w1⊕w2 = share_b⊕share_c: whoever is
// released b's share learns c's. Doing it here means no check module can forget it.
//
// The AES-SIV tag is the only verdict. A wrong passphrase and a forged share fail identically, and
// open() returns null for both — there is no oracle beyond "it decrypted".
//
// ---------------------------------------------------------------------------
// WIRE FORMAT
// ---------------------------------------------------------------------------
//   nonce(8) ‖ shape ‖ material(leaf order) ‖ body
//   shape, prefix order, one byte per node:
//     0b000nnnnn AND with n children (2..8)
//     0b001nnnnn OR  with n children (2..8)
//     0b010ttttt LEAF, check tag t — followed by that check's encoded (PUBLIC) params
// The shape is public: a reader has to know which checks to attempt. The secrets — passphrases,
// recipient identities, released shares — never appear in it.
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { aessiv } from '@noble/ciphers/aes.js'
import { CHECKS, byTag } from './checks/index.mjs'

const enc = new TextEncoder()

export const NONCE_LEN = 8
export const SHARE_LEN = 16
export const MAX_DEPTH = 3
export const MAX_LEAVES = 8
export const MAX_CHILDREN = 8
/** Cap on candidate keys a reader tries — OR × AND fan-out is multiplicative. */
export const MAX_CANDIDATES = 256

const LABEL_CEK = enc.encode('lortnoc/policy/cek/v1')
const NODE = { AND: 0, OR: 1, LEAF: 2 }

export const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
  let at = 0
  for (const p of parts) (out.set(p, at), (at += p.length))
  return out
}
const xor = (a, b) => a.map((x, i) => x ^ b[i])
const rand = (n) => crypto.getRandomValues(new Uint8Array(n))

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------
/** Nodes: { and: [...] } | { or: [...] } | { check: '<id>', ...spec }. */
export function kind(node) {
  if (Array.isArray(node?.and)) return 'and'
  if (Array.isArray(node?.or)) return 'or'
  if (typeof node?.check === 'string') return 'leaf'
  throw new Error('policy: unknown node ' + JSON.stringify(node))
}

export function moduleFor(node) {
  const m = CHECKS[node.check]
  if (!m) throw new Error(`policy: unknown check "${node.check}"`)
  return m
}

/** Depth-first leaves with their paths (child indices from the root). */
export function leaves(node, path = [], out = []) {
  const k = kind(node)
  if (k === 'leaf') out.push({ node, path })
  else node[k].forEach((c, i) => leaves(c, [...path, i], out))
  return out
}

export function validate(node, depth = 0) {
  const k = kind(node)
  if (k === 'leaf') {
    moduleFor(node).validate?.(node)
    return
  }
  if (depth >= MAX_DEPTH) throw new Error('policy: nested too deep')
  const kids = node[k]
  if (kids.length < 2 || kids.length > MAX_CHILDREN) throw new Error(`policy: ${k} needs 2..${MAX_CHILDREN} children`)
  kids.forEach((c) => validate(c, depth + 1))
  if (depth === 0 && leaves(node).length > MAX_LEAVES) throw new Error(`policy: at most ${MAX_LEAVES} checks`)
}

/** Truth value of the policy under a predicate over leaves. */
export function satisfied(node, pred, path = []) {
  const k = kind(node)
  if (k === 'and') return node.and.every((c, i) => satisfied(c, pred, [...path, i]))
  if (k === 'or') return node.or.some((c, i) => satisfied(c, pred, [...path, i]))
  return pred(node, path)
}

/**
 * Honesty chips (PRD §4.4, §16.1) — derived from each check's declared flags, so a check cannot ship
 * without saying what it does and does not protect.
 *   gateCanRead      — the gate operator alone could open this. A `public` leaf counts as held by
 *                      everyone, the gate included: AND(public, human) IS gate-readable.
 *   obfuscationOnly  — anyone with the extension can open it. Never show a lock.
 *   offlineGuessable — a passphrase that a party could brute-force offline, because the body tag
 *                      confirms a right guess.
 */
export function honesty(policy) {
  const flag = (f) => (n) => !!moduleFor(n).flags?.[f]
  const everyone = flag('anyoneCanOpen')
  return {
    obfuscationOnly: satisfied(policy, everyone),
    gateCanRead: satisfied(policy, (n) => everyone(n) || flag('gateHoldsShare')(n)),
    offlineGuessable: leaves(policy).some(({ node }) => flag('offlineGuessable')(node)),
  }
}

/** Reader-facing labels, e.g. ["Passphrase · hint: our street", "Verified human"]. */
export function describe(shape) {
  return leaves(shape).map(({ node }) => moduleFor(node).describe(node))
}

// ---------------------------------------------------------------------------
// Shape encoding — public params only
// ---------------------------------------------------------------------------
export function encodeShape(node, out = []) {
  const k = kind(node)
  if (k === 'leaf') {
    const m = moduleFor(node)
    out.push((NODE.LEAF << 5) | m.tag, ...m.encodeParams(node))
  } else {
    out.push(((k === 'and' ? NODE.AND : NODE.OR) << 5) | node[k].length)
    node[k].forEach((c) => encodeShape(c, out))
  }
  return out
}

export function decodeShape(bytes, at, depth = 0) {
  if (at >= bytes.length) throw new Error('shape: truncated')
  const b = bytes[at]
  const type = b >> 5
  const prm = b & 0x1f
  if (type === NODE.LEAF) {
    const m = byTag(prm)
    if (!m) return { node: { check: `unknown:${prm}`, unknown: true }, at: bytes.length } // cannot skip its params
    const r = m.decodeParams(bytes, at + 1)
    return { node: { check: m.id, ...r.params }, at: r.at }
  }
  if (type !== NODE.AND && type !== NODE.OR) throw new Error('shape: bad node')
  if (depth >= MAX_DEPTH || prm < 2 || prm > MAX_CHILDREN) throw new Error('shape: bad inner node')
  const kids = []
  let p = at + 1
  for (let i = 0; i < prm; i++) {
    const r = decodeShape(bytes, p, depth + 1)
    if (r.node.unknown) return r
    kids.push(r.node)
    p = r.at
  }
  return { node: type === NODE.AND ? { and: kids } : { or: kids }, at: p }
}

// ---------------------------------------------------------------------------
// Leaf context — the ONLY way a check derives a mask, so path binding is structural
// ---------------------------------------------------------------------------
function leafCtx(nonce, path, extra) {
  const pathBytes = Uint8Array.from(path)
  return {
    nonce,
    path,
    /** HKDF(ikm, salt=nonce, info=label ‖ path ‖ suffix) — 16 bytes unless told otherwise. */
    mask(ikm, label, suffix = [], len = SHARE_LEN) {
      return hkdf(sha256, ikm, nonce, cat(enc.encode(label), pathBytes, Uint8Array.from(suffix)), len)
    },
    xor,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// Compile (author)
// ---------------------------------------------------------------------------
/**
 * @param {object} policy tree; leaves carry their check's spec, secrets included
 * @param {Uint8Array} plaintext
 * @param {{squeezed?: boolean, nonce?: Uint8Array, deposit?: Function, kdfProfiles?: object[]}} opts
 *   deposit(leaf, share, {policyHash, path}) → Promise<Uint8Array> — the gate, for attested checks
 * @returns {Promise<Uint8Array>} the policy container: header ‖ body
 */
export async function compile(policy, plaintext, opts = {}) {
  validate(policy)
  const nonce = opts.nonce ?? rand(NONCE_LEN)
  const root = rand(SHARE_LEN)
  const shape = Uint8Array.from(encodeShape(policy))
  const policyHash = sha256(cat(nonce, shape))

  const shares = new Map()
  ;(function assign(node, key, path) {
    const k = kind(node)
    if (k === 'leaf') return void shares.set(String(path), key)
    if (k === 'or') return node.or.forEach((c, i) => assign(c, key, [...path, i]))
    let acc = key
    node.and.forEach((c, i) => {
      if (i === node.and.length - 1) return assign(c, acc, [...path, i])
      const s = rand(SHARE_LEN)
      acc = xor(acc, s)
      assign(c, s, [...path, i])
    })
  })(policy, root, [])

  const cache = new Map()
  const material = []
  for (const { node, path } of leaves(policy)) {
    const ctx = leafCtx(nonce, path, { cache, kdfProfiles: opts.kdfProfiles, policyHash, deposit: opts.deposit })
    material.push(await moduleFor(node).seal(ctx, shares.get(String(path)), node))
  }
  const header = cat(nonce, shape, ...material)
  const cek = hkdf(sha256, root, nonce, LABEL_CEK, 64)
  return cat(header, aessiv(cek, ad(header, opts.squeezed)).encrypt(plaintext))
}

const ad = (header, squeezed) => cat([squeezed ? 1 : 0], header)

// ---------------------------------------------------------------------------
// Parse + open (reader)
// ---------------------------------------------------------------------------
/** Structure only — no keys needed. Throws on malformed input. `unsupported` = a check this
 *  version does not know; such a post can be described but never opened. */
export function parse(payload) {
  if (payload.length < NONCE_LEN + 1 + 16) throw new Error('parse: too short')
  const nonce = payload.subarray(0, NONCE_LEN)
  const { node: shape, at: shapeEnd } = decodeShape(payload, NONCE_LEN)
  if (shape.unknown) return { unsupported: shape.check, nonce }
  const lv = leaves(shape)
  if (lv.length > MAX_LEAVES) throw new Error('parse: too many checks')
  let at = shapeEnd
  const material = new Map()
  for (const { node, path } of lv) {
    const r = moduleFor(node).readMaterial(payload, at, node)
    material.set(String(path), r.material)
    at = r.at
  }
  if (at + 16 > payload.length) throw new Error('parse: truncated')
  // The same value compile() tags gate deposits with — a reader sends it with a release request.
  const policyHash = sha256(payload.subarray(0, shapeEnd))
  return { nonce, shape, material, policyHash, header: payload.subarray(0, at), body: payload.subarray(at) }
}

/**
 * @param {Uint8Array} payload
 * @param {{passphrases?: string[], msgKey?: {priv,pub}, release?: Function, squeezed?: boolean}} inputs
 * @returns {Promise<Uint8Array|null>} plaintext, or null on ANY failure
 */
export async function open(payload, inputs = {}) {
  let p
  try {
    p = parse(payload)
  } catch {
    return null
  }
  if (p.unsupported) return null
  const cache = new Map()
  const candidates = async (node, path) => {
    const k = kind(node)
    if (k === 'or') {
      const all = []
      for (let i = 0; i < node.or.length; i++) all.push(...(await candidates(node.or[i], [...path, i])))
      return dedupe(all).slice(0, MAX_CANDIDATES)
    }
    if (k === 'and') {
      let acc = [new Uint8Array(SHARE_LEN)]
      for (let i = 0; i < node.and.length; i++) {
        const cs = await candidates(node.and[i], [...path, i])
        if (!cs.length) return []
        acc = dedupe(acc.flatMap((a) => cs.map((c) => xor(a, c)))).slice(0, MAX_CANDIDATES)
      }
      return acc
    }
    const ctx = leafCtx(p.nonce, path, { cache, kdfProfiles: inputs.kdfProfiles, inputs, policyHash: p.policyHash })
    try {
      return (await moduleFor(node).open(ctx, p.material.get(String(path)), node)) ?? []
    } catch {
      return []
    }
  }
  let keys
  try {
    keys = await candidates(p.shape, [])
  } catch {
    return null
  }
  const a = ad(p.header, inputs.squeezed)
  for (const k of keys) {
    try {
      return aessiv(hkdf(sha256, k, p.nonce, LABEL_CEK, 64), a).decrypt(p.body)
    } catch {}
  }
  return null
}

function dedupe(arr) {
  const seen = new Set()
  return arr.filter((a) => {
    const k = String(a)
    return seen.has(k) ? false : (seen.add(k), true)
  })
}
