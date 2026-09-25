// Two deterministic wallets for the DM tier.
//
// Derived from fixed seeds through shared/keys.mjs — the SAME derivation the app performs when a
// user signs in, so these are real identities, not test doubles. Deterministic so a failure is
// reproducible and so funding survives across runs: the addresses never change.
//
// Each wallet is the full §5.1 set from one master secret:
//   K_msg  X25519  → the messaging pubkey published as eth.lortnoc.pubkey, and the ECDH half
//   K_sui  Ed25519 → the Sui account that pays for Walrus blobs and signs Seal session keys
//
// That coupling is the point: a "wallet owning a handle" means one MS produces both the key the
// handle advertises and the account that writes to chain. Testing them separately would prove
// less than testing them together.
// Explicit dist path: @mysten's subpath exports only resolve from inside app/, and this tier
// lives in test/. Importing the real SDK the app ships beats vendoring a second copy.
import { Ed25519Keypair } from '../../app/node_modules/@mysten/sui/dist/esm/keypairs/ed25519/index.js'
import {
  deriveMasterSecret,
  deriveMessagingKey,
  deriveSuiKey,
  deriveConvKey,
  toHex,
} from '../../shared/keys.mjs'

const enc = new TextEncoder()

/** One wallet: messaging keypair + Sui signer, both from a single master secret. */
export function wallet(seedPhrase) {
  const ms = deriveMasterSecret(enc.encode(seedPhrase))
  const msg = deriveMessagingKey(ms)
  const suiKey = deriveSuiKey(ms)
  const keypair = Ed25519Keypair.fromSecretKey(suiKey)
  return {
    seedPhrase,
    ms,
    msg,
    pubHex: toHex(msg.pub),
    signer: keypair,
    address: keypair.getPublicKey().toSuiAddress(),
  }
}

/** The conversation key two wallets agree on, with NO handshake — pure ECDH (§5.3 Tier 2). */
export function convKeyBetween(a, b) {
  return deriveConvKey(a.msg.priv, b.msg.pub, a.msg.pub)
}

/** Fixed cast. Alice writes (needs funding); Bob and Mallory only ever read (free). */
export const ALICE = wallet('lortnoc-dm-test-alice-v1')
export const BOB = wallet('lortnoc-dm-test-bob-v1')
export const MALLORY = wallet('lortnoc-dm-test-mallory-v1')
