// The X (Twitter) wire format — PRD-x-extension.md §6.
//
// This lives in shared/ rather than inside extension-x/ deliberately. The X build is a SEPARATE
// extension from the Telegram one (PRD §10 Q2), and the failure mode of that split is the one
// documented at the top of keys.mjs: two surfaces that hand-roll the same format, agree today,
// drift silently, and each ends up able to read only its own posts. A frame is a consensus
// decision, so it belongs to the project, not to one extension.
//
// ---------------------------------------------------------------------------
// FRAME v2
// ---------------------------------------------------------------------------
//
//   byte 0   hdr = mode(4 bits) << 4 | flags(4 bits)
//                  flags bit0 = payload was squeezed (shared/squeeze.mjs)
//                  flags bit1 = part of a thread (tid present)
//   byte 1   pos = seq(4 bits) << 4 | (total - 1)(4 bits)     → up to 16 parts
//   byte 2-3 tid — ONLY when the threaded flag is set
//   byte n.. payload — a slice of the ciphertext
//
// v1 carried a 4-byte MAGIC and a 4-byte CRC32. Both are gone, and the reason is worth keeping:
// at these sizes the header WAS the message. A 9-byte message travelled in a 37-byte frame, so
// 76% of the cover text was spent on overhead, and one payload byte costs 6–11 characters of
// cover. MAGIC duplicated work the AES-SIV tag already does (deciding "is this ours"), and the
// CRC duplicated it a second time — AES-SIV's tag detects ANY alteration, so a corrupted frame
// already fails to decrypt. The CRC is load-bearing in the TELEGRAM handshake, where frames
// carry unencrypted pubkeys and have no tag to check; every X mode is encrypted, so here it
// bought nothing but length.
//
// The consequence to understand: parseXFrame can no longer reject a non-frame cheaply, because
// any bytes now parse as a header. That is fine and intended — the hashtag is the cheap
// pre-filter and the AES-SIV tag is the real detector. parseXFrame only rejects what is
// structurally impossible.
//
// ---------------------------------------------------------------------------
// THREADING
// ---------------------------------------------------------------------------
//
// The message is encrypted ONCE and the ciphertext is split, rather than splitting the message
// and encrypting each part. That choice matters twice over:
//   * one 16-byte AES-SIV tag for the whole thread instead of one per post — at ~6–11 cover
//     characters per byte, a per-part tag would cost more than the message;
//   * no part is independently decryptable, so a partial thread reveals NOTHING. PRD §6 demands
//     fail-closed on gaps; here that is structural rather than a check we remembered to write.
//
// `tid` is simply the first two bytes of the ciphertext. Those bytes are part of the AES-SIV
// tag, so they are already deterministic, already effectively random, and already public — this
// costs two bytes and no computation, and lets any part be grouped without holding part 0.

/** Payload shape per mode (PRD §6). Only PUBLIC is implemented today. */
export const X_MODE = Object.freeze({
  PUBLIC: 0x2,
  SHARED: 0x3,
  RECIPIENTS: 0x4,
})

const KNOWN_MODES = new Set(Object.values(X_MODE))

const FLAG_SQUEEZED = 0x1
const FLAG_THREADED = 0x2

/** Max parts in one thread — the 4-bit `total` field. */
export const MAX_PARTS = 16

/** The rendezvous marker. A DELIBERATE marker, and the reason the X threat model differs from
 *  Telegram's (PRD §3) — without it the extension would have to spend a full model decode on
 *  every tweet in a feed, which is not viable. It buys tractability and costs deniability. */
export const HASHTAG = '#lortnoctahc'

/**
 * Split a ciphertext into frames.
 *
 * @param {number} mode one of X_MODE
 * @param {Uint8Array} ciphertext the WHOLE encrypted payload
 * @param {{squeezed?: boolean, chunkBytes?: number}} opts
 *   chunkBytes = payload bytes per post. The caller derives it from what actually fits 280
 *   characters, then verifies the encoded result and retries smaller if a post overflows —
 *   cover length is variable, so it cannot be predicted exactly, only bounded.
 * @returns {Uint8Array[]} one frame per post, in order
 */
export function buildXFrames(mode, ciphertext, opts = {}) {
  if (!KNOWN_MODES.has(mode)) throw new Error(`xframe: unknown mode 0x${mode.toString(16)}`)
  if (ciphertext.length < 2) throw new Error('xframe: ciphertext too short to carry a thread id')

  const squeezed = opts.squeezed === true
  const chunk = opts.chunkBytes ?? ciphertext.length
  if (chunk < 1) throw new Error(`xframe: chunkBytes must be >= 1 (got ${chunk})`)

  const total = Math.max(1, Math.ceil(ciphertext.length / chunk))
  if (total > MAX_PARTS) {
    throw new Error(`xframe: message needs ${total} parts, max ${MAX_PARTS}`)
  }
  const threaded = total > 1

  const frames = []
  for (let seq = 0; seq < total; seq++) {
    const slice = ciphertext.subarray(seq * chunk, Math.min((seq + 1) * chunk, ciphertext.length))
    const head = threaded ? 4 : 2
    const frame = new Uint8Array(head + slice.length)
    frame[0] = (mode << 4) | (squeezed ? FLAG_SQUEEZED : 0) | (threaded ? FLAG_THREADED : 0)
    frame[1] = (seq << 4) | (total - 1)
    if (threaded) {
      frame[2] = ciphertext[0]
      frame[3] = ciphertext[1]
    }
    frame.set(slice, head)
    frames.push(frame)
  }
  return frames
}

/** Convenience for the single-post case. */
export function buildXFrame(mode, ciphertext, opts = {}) {
  return buildXFrames(mode, ciphertext, opts)[0]
}

/**
 * Parse a frame, or null when these bytes cannot be one.
 *
 * Null is the ordinary answer — most decoded posts are chatter that happened to carry the tag.
 *
 * @returns {{mode:number, squeezed:boolean, threaded:boolean, seq:number, total:number,
 *            tid:number|null, payload:Uint8Array}|null}
 */
export function parseXFrame(bytes) {
  if (bytes.length < 2) return null

  const mode = bytes[0] >> 4
  // Forward compatibility (PRD §6): a mode we do not know is a NEWER build's post, not
  // corruption. Ignore it silently so an old extension degrades to "shows chatter".
  if (!KNOWN_MODES.has(mode)) return null

  const flags = bytes[0] & 0x0f
  const squeezed = (flags & FLAG_SQUEEZED) !== 0
  const threaded = (flags & FLAG_THREADED) !== 0
  const seq = bytes[1] >> 4
  const total = (bytes[1] & 0x0f) + 1
  if (seq >= total) return null // structurally impossible
  if (threaded !== total > 1) return null // the flag and the count must agree

  const head = threaded ? 4 : 2
  if (bytes.length < head) return null
  const tid = threaded ? (bytes[2] << 8) | bytes[3] : null

  return { mode, squeezed, threaded, seq, total, tid, payload: bytes.slice(head) }
}

/**
 * Collects thread parts until a thread is complete.
 *
 * Deliberately keyed on (tid, total) rather than on posting order or reply structure: X's feed
 * is virtualised and arrives out of order, and a reader may see part 3 before part 1. Fails
 * closed by construction — `offer` returns the ciphertext ONLY when every part is present.
 */
export class ThreadCollector {
  constructor(maxThreads = 32) {
    this.maxThreads = maxThreads
    this.threads = new Map() // key -> { total, parts: Map<seq, Uint8Array> }
  }

  /**
   * Offer one parsed frame.
   * @returns {Uint8Array|null} the reassembled ciphertext, or null while parts are missing
   */
  offer(frame) {
    if (!frame.threaded) return frame.payload // single post: already complete

    const key = `${frame.tid}:${frame.total}`
    let entry = this.threads.get(key)
    if (!entry) {
      // Bound the map so a flood of junk that happens to carry the hashtag cannot grow it
      // without limit. Oldest out — Map preserves insertion order.
      if (this.threads.size >= this.maxThreads) {
        this.threads.delete(this.threads.keys().next().value)
      }
      entry = { total: frame.total, parts: new Map() }
      this.threads.set(key, entry)
    }
    entry.parts.set(frame.seq, frame.payload)
    if (entry.parts.size !== frame.total) return null

    let n = 0
    for (const p of entry.parts.values()) n += p.length
    const out = new Uint8Array(n)
    let at = 0
    for (let s = 0; s < frame.total; s++) {
      const part = entry.parts.get(s)
      if (!part) return null // defensive: size matched but a seq is missing (duplicate seq)
      out.set(part, at)
      at += part.length
    }
    return out
  }

  clear() {
    this.threads.clear()
  }
}

// ---------------------------------------------------------------------------
// Hashtag handling
// ---------------------------------------------------------------------------

/** Append the rendezvous tag to cover text. A single space + tag, so stripTag can undo it
 *  exactly — the codec must see byte-identical cover text on the way back or decoding fails. */
export function appendTag(coverText) {
  return `${coverText} ${HASHTAG}`
}

/**
 * Recover the cover text from a posted tweet, or null when the tag is absent.
 *
 * Null is the cheap pre-filter that replaces the Telegram build's MIN_COVER_WORDS: no tag means
 * we never spend a model decode on it (PRD §7).
 *
 * Tolerant of surrounding whitespace and of the tag's case, because X renders a hashtag as a
 * link and innerText round-trips carry no guarantee about our exact spacing. Deliberately NOT
 * tolerant of a tag in the middle: we always append, so a mid-text tag is somebody using the
 * hashtag normally.
 */
export function stripTag(tweetText) {
  let t = tweetText.trim()
  let found = false
  // Strip EVERY trailing tag, not just one.
  //
  // Measured on a real post 2026-08-20: X published `...at all #lortnoctahc#lortnoctahc`. The
  // extension appends exactly one tag with a leading space, so a second one — concatenated with
  // no space — came from X itself, most likely its hashtag autocomplete firing because the post
  // ends on a `#word`.
  //
  // Stripping one tag would leave the other inside the recovered cover text, the codec would
  // then be handed a word it never emitted, and the decode would fail: a doubled tag makes the
  // post UNREADABLE, not just untidy. The outbound side now avoids provoking the autocomplete,
  // but this stays as the fail-safe — it costs nothing, it rescues posts already published with
  // the doubled tag, and it survives whatever X does to trailing hashtags next.
  for (;;) {
    if (t.slice(-HASHTAG.length).toLowerCase() !== HASHTAG) break
    t = t.slice(0, -HASHTAG.length).trim()
    found = true
  }
  return found ? t : null
}
