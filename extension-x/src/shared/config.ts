// Storage keys and defaults shared across content script, background, and popup.

// Hosted codec (fly.io) — the SAME instance the Telegram build calls. This is not incidental:
// reversibility requires encode and decode to hit one deterministic process (CLAUDE.md §6.2), and
// a second instance is how "the codec is broken" bugs are born.
export const DEFAULT_CODEC_URL = 'https://lortnoc-codec.fly.dev'

// storage.local (persisted): non-secret config + toggle state.
export const LOCAL = {
  codecUrl: 'codecUrl',
  enabled: 'enabled', // global stego on/off
  // Mode 3 recipient handles. EMPTY = Mode 1 (public channel). Stored in storage.local because
  // handles are not secret — the pubkeys they resolve to are published ENS text records. The
  // private half never goes here; see content/identity.ts.
  recipients: 'recipients',
  // Stable per-install metering-bucket id, used only when the X username is unreadable.
  bucket: 'bucket',
} as const

/** X's hard post limit. Cover text plus the hashtag must fit, or the post is rejected. */
export const POST_LIMIT = 280
