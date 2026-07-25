// Storage keys and defaults shared across content script, background, and popup.

// Hosted codec (fly.io): GPT-2 stego + 0G best-of-N selection. Default so a fresh install
// works with zero config; override in the popup for local dev.
export const DEFAULT_CODEC_URL = 'https://lortnoc-codec.fly.dev'

// storage.local (persisted): non-secret config + toggle state.
export const LOCAL = {
  codecUrl: 'codecUrl',
  enabled: 'enabled', // global stego on/off for the demo (per-chat is a fast-follow)
} as const

// storage.session (memory only, cleared when the browser closes): the passphrase.
// Never written to disk (invariant §4: key material stays ephemeral).
export const SESSION = {
  passphrase: 'passphrase',
} as const
