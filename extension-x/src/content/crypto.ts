// Client-side crypto — runs ONLY in the content script (in-page). Plaintext and key never leave
// here (CLAUDE.md §4). AES-SIV's auth tag doubles as the "is this ours?" detector: decrypt
// returns null on tag mismatch.
//
// Every implementation lives in shared/, imported by this extension, the Telegram extension, the
// web app, the CLI and the relayer. Nothing is re-implemented here, and the parity test enforces
// that: this extension is a SEPARATE build from the Telegram one (PRD §10 Q2), which makes a
// hand-inlined copy the single most likely way the two surfaces silently stop agreeing.
//
// Note `encryptBytes`, not `encrypt`: the payload is squeezed before encryption, and the string
// form UTF-8 encodes its input, which inflates compressed bytes by ~50% and eats the entire
// saving. See the comment on encryptBytes in shared/keys.mjs.
export {
  encryptBytes,
  tryDecryptBytes,
  derivePublicChannelKey,
  deriveMasterSecret,
  deriveMessagingKey,
  toB64,
  fromB64,
  toHex,
  fromHex,
} from '../../../shared/keys.mjs'

export {
  buildXFrame,
  buildXFrames,
  parseXFrame,
  ThreadCollector,
  X_MODE,
  MAX_PARTS,
  HASHTAG,
  appendTag,
  stripTag,
} from '../../../shared/xframe.mjs'

export { squeezeIfSmaller, unsqueezeMaybe } from '../../../shared/squeeze.mjs'

export { sealTo, openSealed, overheadFor, MAX_RECIPIENTS } from '../../../shared/envelope.mjs'
