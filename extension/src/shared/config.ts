// Storage keys and defaults shared across content script, background, and popup.

// Hosted codec (fly.io): GPT-2 stego + 0G best-of-N selection. Default so a fresh install
// works with zero config; override in the popup for local dev.
export const DEFAULT_CODEC_URL = 'https://lortnoc-codec.fly.dev'

// storage.local (persisted): non-secret config + toggle state.
export const LOCAL = {
  codecUrl: 'codecUrl',
  enabled: 'enabled', // global stego on/off for the demo (per-chat is a fast-follow)
  meter: 'meter', // freemium counter + paid flag ({ sends: number, paid: boolean })
  membership: 'membership', // x402 membership bearer token (set by the unlock flow)
  bucket: 'bucket', // stable per-install metering-bucket id (fallback when no TG id)
} as const

// Freemium gate (§9). Honor-system, client-side, bypassable by design — a conversion
// nudge, not DRM. Gates SENDING only; reading/decoding is always free (§7).
export const FREE_LIMIT = 10 // hidden sends before the paywall
export const WARN_AT = 8 // soft "running low" warning kicks in here
// Where the paywall funnels users to pay + upgrade to a wallet-derived identity key.
export const UPGRADE_URL = 'https://app.lortnoctahc.com/upgrade'

// storage.session (memory only, cleared when the browser closes) holds the handshake session:
// our ephemeral keypair and the derived conversation key. Never written to disk (invariant §4 —
// key material stays ephemeral). Written by content/session.ts under the key `hs`.
