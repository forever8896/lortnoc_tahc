// Tier-1 in-band handshake framing (§5.3). Pubkeys are smuggled as cover text through
// the SAME codec as messages — but NOT encrypted (they're public, and there's no shared
// key yet). A MAGIC prefix + CRC32 lets the receiver tell a handshake frame apart from
// an AES-SIV message and from ordinary chatter (which would otherwise decode to noise).
//
// Frame bytes:  MAGIC(4) · type(1) · x25519_pubkey(32) · crc32(4)   = 41 bytes

const MAGIC = Uint8Array.from([0x4c, 0x54, 0x4e, 0x43]) // "LTNC"

export const FRAME = { OFFER: 0x01, ACK: 0x02 } as const
export type FrameType = (typeof FRAME)[keyof typeof FRAME]

const PUBKEY_LEN = 32
const FRAME_LEN = 4 + 1 + PUBKEY_LEN + 4

// CRC32 (IEEE) — small, no deps.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Build an offer/ack frame carrying our pubkey. */
export function buildFrame(type: FrameType, pubkey: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + 1 + PUBKEY_LEN)
  body.set(MAGIC, 0)
  body[4] = type
  body.set(pubkey, 5)
  const crc = crc32(body)
  const out = new Uint8Array(FRAME_LEN)
  out.set(body, 0)
  out[body.length] = (crc >>> 24) & 0xff
  out[body.length + 1] = (crc >>> 16) & 0xff
  out[body.length + 2] = (crc >>> 8) & 0xff
  out[body.length + 3] = crc & 0xff
  return out
}

/** Parse bytes as a handshake frame, or null if not one (MAGIC/CRC/length mismatch). */
export function parseFrame(bytes: Uint8Array): { type: FrameType; pubkey: Uint8Array } | null {
  if (bytes.length !== FRAME_LEN) return null
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) return null
  const body = bytes.subarray(0, 4 + 1 + PUBKEY_LEN)
  const want =
    ((bytes[FRAME_LEN - 4] << 24) |
      (bytes[FRAME_LEN - 3] << 16) |
      (bytes[FRAME_LEN - 2] << 8) |
      bytes[FRAME_LEN - 1]) >>>
    0
  if (crc32(body) !== want) return null
  const type = bytes[4]
  if (type !== FRAME.OFFER && type !== FRAME.ACK) return null
  return { type: type as FrameType, pubkey: bytes.slice(5, 5 + PUBKEY_LEN) }
}
