// Space membership, verified authors and bans (docs/PRD-universal.md §22.5).
//
// A SPACE is a named circle (e.g. "lentil-club"). Joining it takes one World ID proof, made in the
// reader's Reveal card, never in the writing sheet — World ID is never needed to write. The gate
// then knows this person as a stable pseudonym, `member-xxxxxx`, derived from their World ID
// nullifier for THAT space:
//
//   * the same human always gets the same pseudonym in a space (measured: re-proving one World ID
//     action yields the same nullifier) — so a BAN on the pseudonym sticks, even across new World
//     App accounts;
//   * pseudonyms in different spaces cannot be linked (different actions → unlinkable nullifiers).
//
// A member may OPTIONALLY post as that pseudonym: the sheet asks the gate to countersign the post's
// content hash using the member's key (the gate never sees the text). Readers verify the gate's
// Ed25519 signature and show "verified member member-7f3a". A post without it reads "unverified
// writer" — still allowed; the space creator decides what to trust.
//
// Honest limit: inside ONE space the gate can tell a member's posts and reads apart from others'
// — that is what a ban needs. It never learns who the person is.
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { toHex, fromHex } from './keys.mjs'

const enc = new TextEncoder()
/** A gate space (`lentil-club`) or an ENS space (`@lentil-club` = lentil-club.space.lortnoctahc.eth). */
export const SPACE_RE = /^@?[a-z0-9-]{3,32}$/

/** An Ed25519 keypair — member keys and space-owner keys. */
export function genSigner() {
  const priv = ed25519.utils.randomSecretKey()
  return { priv: toHex(priv), pub: toHex(ed25519.getPublicKey(priv)) }
}
/** A deterministic Ed25519 signer + HMAC secret derived from the gate's long-lived X25519 key, so
 *  a gate restart keeps the same signing identity (readers pin it) without a second secret to store. */
export function signerFrom(gatePriv) {
  const seed = hkdf(sha256, gatePriv, undefined, enc.encode('lortnoc/gate/sign/v1'), 32)
  const secret = hkdf(sha256, gatePriv, undefined, enc.encode('lortnoc/gate/member/v1'), 32)
  return { priv: toHex(seed), pub: toHex(ed25519.getPublicKey(seed)), secret }
}
export const sign = (privHex, msg) => toHex(ed25519.sign(msg, fromHex(privHex)))
export const verifySig = (pubHex, msg, sigHex) => {
  try {
    return ed25519.verify(fromHex(sigHex), msg, fromHex(pubHex))
  } catch {
    return false
  }
}

/** Domain-separated messages — a signature for one purpose never verifies as another. */
export const MSG = {
  /** member asks the gate to countersign a post */
  authorRequest: (space, memberId, contentHash) => enc.encode(`lortnoc/member/request/v1|${space}|${memberId}|${contentHash}`),
  /** the gate's attestation readers verify */
  attestation: (space, memberId, contentHash) => enc.encode(`lortnoc/member/attest/v1|${space}|${memberId}|${contentHash}`),
  /** a space owner registers the space / bans a member */
  register: (space, ownerPub) => enc.encode(`lortnoc/space/register/v1|${space}|${ownerPub}`),
  ban: (space, memberId, unban = false) => enc.encode(`lortnoc/space/${unban ? 'unban' : 'ban'}/v1|${space}|${memberId}`),
}

export const contentHash = (text) => toHex(sha256(enc.encode(text)))

/** Gate-side pseudonym: keyed, so only the gate can map a nullifier to it; stable, so bans stick. */
export const memberIdFor = (secret, space, nullifier) =>
  'member-' + toHex(hmac(sha256, secret, enc.encode(`${space}|${nullifier}`))).slice(0, 12)

// ---------------------------------------------------------------------------
// The author block that rides INSIDE the encrypted message (so it is as private as the text)
//   JSON line: {"s":space,"m":memberId,"g":gateSig}\n then the text
// ---------------------------------------------------------------------------
export function withAuthor(text, { space, memberId, sig }) {
  return `${JSON.stringify({ s: space, m: memberId, g: sig })}\n${text}`
}

/** @returns {{text: string, author: null | {space, memberId, verified: boolean}}} */
export function readAuthor(plain, gateSignPub) {
  if (!plain.startsWith('{"s":')) return { text: plain, author: null }
  const nl = plain.indexOf('\n')
  try {
    const a = JSON.parse(plain.slice(0, nl))
    const text = plain.slice(nl + 1)
    const ok = !!gateSignPub && SPACE_RE.test(a.s) &&
      verifySig(gateSignPub, MSG.attestation(a.s, a.m, contentHash(text)), a.g)
    return { text, author: { space: a.s, memberId: a.m, verified: ok } }
  } catch {
    return { text: plain, author: null }
  }
}
