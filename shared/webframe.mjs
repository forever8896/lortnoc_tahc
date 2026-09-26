// The web wire format — a message hidden in ANY page's text (docs/PRD-universal.md §7.1, §8).
//
//   byte 0   0x50 | flags     mode 5 (POLICY) in the high nibble, as in frame v2's header byte,
//                             so a v2 reader rejects it by mode instead of misreading it.
//                             flags bit0 = the plaintext was squeezed (shared/squeeze.mjs)
//   byte 1.. policy container (shared/policy.mjs): nonce ‖ shape ‖ material ‖ AES-SIV body
//
// No threading: a comment box or a page takes a whole message, and the X build keeps its own
// frames. The squeeze flag is bound into the body's associated data, so flipping it fails the tag.
//
// Separately, canonicalCover() undoes what websites do to text. Every codec backend emits only
// [a-z]+ words and single spaces (research-tokyo/normalization.md), so lowercasing, turning every
// non-letter into a space and dropping the marker is the IDENTITY on any cover the codec ever
// produced — it can only repair, never break. Measured: capitalisation alone took decode from 15/15
// to 0/15, and canonicalisation brought it back to 15/15; WordPress's real comment filter chain
// passed ~26k cover words unchanged.
import { compile, open, parse, describe, honesty } from './policy.mjs'
import { squeezeIfSmaller, unsqueezeMaybe } from './squeeze.mjs'
import { HASHTAG } from './xframe.mjs'

export const MODE_POLICY = 0x5
const FLAG_SQUEEZED = 0x1
export const MARKER = HASHTAG
const MARKER_WORD = HASHTAG.slice(1)

/**
 * Author side: text + policy → the bytes handed to the codec.
 * @returns {Promise<Uint8Array>}
 */
export async function sealMessage(text, policy, opts = {}) {
  const { bytes, compressed } = squeezeIfSmaller(text)
  const container = await compile(policy, bytes, { ...opts, squeezed: compressed })
  const out = new Uint8Array(1 + container.length)
  out[0] = (MODE_POLICY << 4) | (compressed ? FLAG_SQUEEZED : 0)
  out.set(container, 1)
  return out
}

/**
 * Reader side, step 1 — what does this post need? No keys, no network.
 * @returns {null | {unsupported?: string, needs?: string[], checks?: string[], honesty?: object}}
 *   null = not a web frame at all. `needs` lists the input kinds worth asking the reader for.
 */
export function inspect(frame) {
  if (!frame || frame.length < 2 || frame[0] >> 4 !== MODE_POLICY) return null
  let p
  try {
    p = parse(frame.subarray(1))
  } catch {
    return null
  }
  if (p.unsupported) return { unsupported: p.unsupported }
  const ids = new Set()
  ;(function walk(n) {
    if (n.and || n.or) (n.and ?? n.or).forEach(walk)
    else ids.add(n.check)
  })(p.shape)
  return { checks: describe(p.shape), needs: [...ids], honesty: honesty(p.shape), shape: p.shape }
}

/**
 * Reader side, step 2 — try to open it with what the reader has.
 * @param {{passphrases?: string[], msgKey?: object, release?: Function, usePublic?: boolean}} inputs
 * @returns {Promise<string|null>} the message, or null if these inputs do not satisfy the policy
 */
export async function openMessage(frame, inputs = {}) {
  if (!frame || frame.length < 2 || frame[0] >> 4 !== MODE_POLICY) return null
  const squeezed = (frame[0] & FLAG_SQUEEZED) !== 0
  const bytes = await open(frame.subarray(1), { ...inputs, squeezed })
  return bytes ? unsqueezeMaybe(bytes, squeezed) : null
}

/** Author side: the text that goes into the page. The marker is optional — high-risk mode drops it,
 *  because searching for it lists every user (PRD §18.2). */
export function presentCover(cover, { marker = true } = {}) {
  return marker ? `${cover} ${MARKER}` : cover
}

/** Reader side: whatever text the page shows → the exact words the codec emitted. */
export function canonicalCover(text) {
  return String(text)
    .normalize('NFKC')
    .replace(/[​-‍⁠﻿­]/g, '') // zero-width + soft hyphen: invisible, never ours
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .split(' ')
    .filter((w) => w && w !== MARKER_WORD)
    .join(' ')
}

/**
 * Deep-scan pre-filter: could this block of page text be codec cover text?
 *
 * Every backend emits only [a-z]+ words and single spaces, so cover text is a long run of lowercase
 * words with no capitals and no punctuation — a shape ordinary human writing rarely has for 25+
 * words. This decides which blocks are worth a codec call; the codec + AES-SIV tag then decide what
 * is really ours. Tolerant of what sites do (a trailing full stop, the old #lortnoctahc tag, a
 * capitalised first word) because canonicalCover() undoes those before decoding.
 *
 * Honest limit: this shape is itself a weak fingerprint — someone hunting for hidden text could
 * look for it too. It is far less conspicuous than a hashtag, and it is all the extension needs.
 */
export function looksLikeCover(text, { minWords = 25 } = {}) {
  const words = String(text).replace(new RegExp(HASHTAG, 'ig'), ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length < minWords) return false
  const plain = words.filter((w) => /^[a-z]+$/.test(w)).length
  const capitalised = words.filter((w) => /[A-Z]/.test(w)).length
  const punctuated = words.filter((w) => /[.,!?;:"()]/.test(w)).length
  return plain / words.length >= 0.95 && capitalised <= 1 && punctuated <= 1
}

/** Does this text carry the (legacy) marker? */
export function hasMarker(text) {
  return String(text).toLowerCase().includes(HASHTAG)
}
