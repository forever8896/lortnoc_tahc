// Plaintext compression for stego payloads.
//
// WHY THIS EXISTS, and why it is not just zlib. Every byte of payload costs roughly 6–11
// characters of cover text, so the plaintext is the highest-leverage place to save. But
// general-purpose compressors are useless at chat length: they have to LEARN their dictionary
// from the input, and a 40-character message gives them nothing to learn from. Measured on real
// messages, brotli made them BIGGER (its header alone outweighs any saving), and raw DEFLATE
// only wins with a preset dictionary — which `CompressionStream` does not support, so it cannot
// cross into the extension without pulling in a compression library.
//
// So the dictionary ships in the code instead of being learned. Greedy longest-match over a
// fixed table of common English fragments; a hit costs one byte, a miss costs one byte.
//
//   0x00..0x7E  literal ASCII byte
//   0x7F        escape: the next byte is a literal >= 0x7F (UTF-8 continuation, etc.)
//   0x80..0xFF  dictionary entry (index = byte - 0x80)
//
// Worst case is 2x the input (all non-ASCII), which is why the caller keeps a "compressed" flag
// and only ships the squeezed form when it actually won.
//
// ⚠️ TABLE IS CONSENSUS-CRITICAL. Both ends must hold the identical table in the identical
// order: an entry inserted in the middle renumbers every entry after it, and every message
// squeezed under the old table decodes to garbage under the new one. Treat it exactly like the
// HKDF labels in keys.mjs — APPEND only, never insert or reorder, and bump the version if you
// ever must. `test/unit/squeeze.test.mjs` pins the table's length and checksum for that reason.

/** Dictionary v1. APPEND ONLY — see the warning above. Max 128 entries. */
const TABLE = [
  // whole words with their surrounding spaces: the biggest wins in chat text
  ' the ', ' and ', ' you ', ' that ', ' for ', ' with ', ' this ', ' have ', ' not ', ' are ',
  ' but ', ' can ', ' will ', ' when ', ' what ', ' how ', ' see ', ' get ', ' out ', ' now ',
  ' back ', ' here ', ' there ', ' time ', ' call ', ' meet ', ' bring ', ' take ', ' come ',
  ' home ', ' place ', ' same ', ' just ', ' like ', ' good ', ' they ', ' your ', ' from ',
  ' about ', ' know ', ' need ', ' want ', ' think ', ' thing ', ' number ', ' please ',
  ' thanks ', ' sorry ',
  // longer words WITHOUT a trailing space, so they also match at end-of-message
  ' tomorrow', ' tonight', ' today', ' morning', ' love', ' okay',
  // short function words
  ' to ', ' a ', ' is ', ' in ', ' it ', ' of ', ' on ', ' at ', ' be ', ' me ', ' my ', ' we ',
  ' so ', ' if ', ' do ', ' up ', ' go ', ' ok ', ' no ', ' i ',
  // suffixes and contractions
  'ing ', 'ing', 'ed ', 'er ', 'tion', 'ly ', 'n\'t', '\'s ', '\'m ', '\'re ', '\'ll ', 'es ',
  // the highest-frequency English bigrams — these guarantee ~2:1 even on text the word
  // entries miss entirely (names, places, anything out of vocabulary)
  'th', 'he', 'in', 'er', 'an', 're', 'on', 'at', 'en', 'nd', 'ti', 'es', 'or', 'te', 'of',
  'ed', 'is', 'it', 'al', 'ar', 'st', 'to', 'nt', 'ng', 'se', 'ha', 'as', 'ou', 'io', 'le',
  've', 'co', 'me', 'de', 'hi', 'ri', 'ro', 'ic', 'ne', 'ea',
]

if (TABLE.length > 128) throw new Error(`squeeze: table has ${TABLE.length} entries, max 128`)

const ESCAPE = 0x7f
const BASE = 0x80

// Match longest-first so the result is independent of table order. Built once.
const BY_LENGTH = TABLE.map((s, i) => ({ s, code: BASE + i })).sort(
  (a, b) => b.s.length - a.s.length || (a.s < b.s ? -1 : 1),
)
/** Bucketed by first character so matching does not scan all 128 entries per position. */
const BY_FIRST = new Map()
for (const e of BY_LENGTH) {
  const k = e.s[0]
  if (!BY_FIRST.has(k)) BY_FIRST.set(k, [])
  BY_FIRST.get(k).push(e)
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Number of entries in the dictionary — pinned by the unit test. */
export const TABLE_SIZE = TABLE.length

/** Cheap order-sensitive checksum of the table, so a reorder fails a test instead of the field. */
export function tableChecksum() {
  let h = 0x811c9dc5
  for (let i = 0; i < TABLE.length; i++) {
    for (const ch of `${i}:${TABLE[i]}`) {
      h ^= ch.charCodeAt(0)
      h = Math.imul(h, 0x01000193) >>> 0
    }
  }
  return h >>> 0
}

/**
 * Compress text to bytes. Always succeeds; may be LARGER than the input for short or
 * non-ASCII text, so callers must compare and keep a flag saying which form they shipped.
 */
export function squeeze(text) {
  const out = []
  let i = 0
  while (i < text.length) {
    let hit = null
    for (const e of BY_FIRST.get(text[i]) ?? []) {
      if (e.s.length <= text.length - i && text.startsWith(e.s, i)) {
        hit = e
        break // BY_FIRST is longest-first, so the first match IS the longest
      }
    }
    if (hit) {
      out.push(hit.code)
      i += hit.s.length
      continue
    }
    // Literal. Encode this ONE character as UTF-8 and escape any byte the codes would collide with.
    for (const b of enc.encode(text[i])) {
      if (b >= ESCAPE) out.push(ESCAPE, b)
      else out.push(b)
    }
    i += 1
  }
  return Uint8Array.from(out)
}

/** Reverse of squeeze. Returns null if the bytes are not a well-formed squeeze stream. */
export function unsqueeze(bytes) {
  let text = ''
  const literals = []
  const flush = () => {
    if (literals.length) {
      text += dec.decode(Uint8Array.from(literals))
      literals.length = 0
    }
  }
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (b === ESCAPE) {
      if (++i >= bytes.length) return null // truncated escape
      literals.push(bytes[i])
    } else if (b >= BASE) {
      flush() // a dictionary entry ends the current literal run
      const entry = TABLE[b - BASE]
      if (entry === undefined) return null
      text += entry
    } else {
      literals.push(b)
    }
  }
  flush()
  return text
}

/**
 * Squeeze only when it wins.
 * @returns {{bytes: Uint8Array, compressed: boolean}}
 */
export function squeezeIfSmaller(text) {
  const raw = enc.encode(text)
  const small = squeeze(text)
  return small.length < raw.length ? { bytes: small, compressed: true } : { bytes: raw, compressed: false }
}

/** Inverse of squeezeIfSmaller. Returns null on malformed input. */
export function unsqueezeMaybe(bytes, compressed) {
  if (!compressed) {
    try {
      return dec.decode(bytes)
    } catch {
      return null
    }
  }
  return unsqueeze(bytes)
}
