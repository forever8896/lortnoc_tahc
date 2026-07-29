// Client-side crypto — runs ONLY in the content script (in-page). Plaintext and key never
// leave here (invariant §4). AES-SIV's auth tag doubles as the "is this ours?" detector:
// decrypt returns null on tag mismatch.
//
// The implementation lives in shared/keys.mjs, imported by the extension, the web app, the
// CLI and the relayer. It used to be copy-pasted here and in app/src/lib/crypto.ts; the two
// happened to agree, and if they ever stopped, each surface would read only its own messages
// with no error anywhere — the exact failure the handshake code has fought repeatedly.
// CLAUDE.md §3 promises "three surfaces, ONE key set"; this is that promise as code.
//
// Keying is X25519 ECDH, exchanged in-band as cover text (§5.3 Tier 1). There is deliberately
// no passphrase path: a second way to key a chat meant the two sides could silently choose
// differently, and each would then read only its own messages.
export {
  genKeyPair,
  deriveConvKey,
  encrypt,
  tryDecrypt,
  toB64,
  fromB64,
  toHex,
  fromHex,
} from '../../../shared/keys.mjs'

export type { KeyPair } from '../../../shared/keys.mjs'
