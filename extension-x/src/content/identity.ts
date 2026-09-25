// Your own messaging identity — the private half of Mode 3.
//
// Mode 3 is asymmetric: SENDING needs only the recipients' public keys (resolved from ENS), so it
// works with no identity at all. RECEIVING needs K_msg, which needs the master secret. This module
// is only about that second half.
//
// **Passphrase, not wallet signature — and that is a documented fallback, not the default.**
// CLAUDE.md §5.1 makes wallet-signature the default and passphrase the fallback for signers that
// cannot derive deterministically. The reason this surface takes the fallback is mechanical, not a
// preference: an MV3 content script runs in an ISOLATED world and cannot see the page's
// `window.ethereum`, so wallet access from x.com would mean injecting a script into the MAIN
// world — a real signing surface on a page we do not control. The passphrase path reaches the same
// MS through the same HKDF table, so an identity created here is the SAME identity the app
// derives from the same passphrase.
//
// KEY MATERIAL NEVER TOUCHES DISK. It lives in chrome.storage.session, which is memory-only and
// cleared when the browser closes (CLAUDE.md §4: key material stays ephemeral). Writing it to
// storage.local would persist a messaging private key in plaintext on disk — the invariants tier
// checks for exactly that.
import { argon2id } from '@noble/hashes/argon2.js'
import { deriveMasterSecret, deriveMessagingKey, toHex, fromHex } from './crypto'

/** storage.session key. Session-scoped by construction — see the note above. */
const SESSION_KEY = 'identity'

/**
 * Argon2id parameters. RFC 9106's second recommended profile (19 MiB, t=2, p=1), matching
 * `DEFAULT_KDF` in app/src/lib/live/knock.ts so the two surfaces agree.
 *
 * Unlike Mode 2 — where the ciphertext is public and permanent, so these would need raising a long
 * way (PRD §3 finding 4) — this derivation's output is never published in any form. Nothing on the
 * timeline is a commitment to it, so there is nothing to grind offline.
 */
const KDF = { t: 2, m: 19456, p: 1 }
const SALT = new TextEncoder().encode('lortnoc/x/identity/v1')

export type Identity = { priv: Uint8Array; pub: Uint8Array }

let cached: Identity | null = null

/** Derive MS from a passphrase, then K_msg. Slow on purpose (~1s). */
export async function unlock(passphrase: string): Promise<Identity> {
  const seed = argon2id(new TextEncoder().encode(passphrase), SALT, { ...KDF, dkLen: 32 })
  const id = deriveMessagingKey(deriveMasterSecret(seed))
  cached = id
  await chrome.storage.session.set({
    [SESSION_KEY]: { priv: toHex(id.priv), pub: toHex(id.pub) },
  })
  return id
}

/** The unlocked identity, or null. Reads back from storage.session across SW/page reloads. */
export async function current(): Promise<Identity | null> {
  if (cached) return cached
  try {
    const got = await chrome.storage.session.get(SESSION_KEY)
    const raw = got[SESSION_KEY] as { priv: string; pub: string } | undefined
    if (!raw) return null
    cached = { priv: fromHex(raw.priv), pub: fromHex(raw.pub) }
    return cached
  } catch {
    return null
  }
}

export async function lock(): Promise<void> {
  cached = null
  await chrome.storage.session.remove(SESSION_KEY)
}

/** The public key to publish as `eth.lortnoc.pubkey`, so others can address you. */
export async function publicKeyHex(): Promise<string | null> {
  const id = await current()
  return id ? toHex(id.pub) : null
}
