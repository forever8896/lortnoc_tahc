// Content-script entry: wires post interception and inbound decoding to the codec (via the SW)
// and the in-page crypto. Plaintext and keys never leave here (CLAUDE.md §4).
//
// Modes 1 and 3 (PRD §5). Which one a message uses is decided per message by whether recipients
// are configured, and it travels in the frame's mode nibble so a reader never has to guess.
//
//   Mode 1 (no recipients) — every install derives the same K_public from a public constant. That
//     is what makes the booth demo work between total strangers, and why it is OBFUSCATION rather
//     than encryption: the key ships in this bundle. Never show a lock for it.
//   Mode 3 (recipients set) — sealed to ENS-resolved X25519 keys. This is the product (§1.1): the
//     recipient set is invisible, so a post readable by four named people is indistinguishable
//     from one readable by nobody, and the readers cannot see each other either.
//
// Mode 2 (shared answer) is deliberately absent — see PRD §3 finding 4 on why it needs a generated
// passphrase rather than the trivia answer its UX invites.
import { onX, activeCompose } from './selectors'
import { injectStyles, toast, type Progress } from './ui'
import { initState, ready } from './state'
import { installPostInterceptor } from './compose'
import { startInbound, RETRY } from './inbound'
import {
  encryptBytes,
  tryDecryptBytes,
  derivePublicChannelKey,
  toB64,
  fromB64,
  buildXFrames,
  parseXFrame,
  ThreadCollector,
  X_MODE,
  MAX_PARTS,
  HASHTAG,
  appendTag,
  squeezeIfSmaller,
  unsqueezeMaybe,
  sealTo,
  openSealed,
  overheadFor,
  fromHex,
} from './crypto'
import * as identity from './identity'
import { meteringBucket } from './bucket'
import { sendToCodec } from '../shared/messages'
import type { EncodeData, DecodeData, ResolveData } from '../shared/messages'
import { POST_LIMIT, LOCAL } from '../shared/config'

// K_public is a pure function of a compile-time constant, so it is derived once and reused.
// Deliberately NOT cached in storage: there is nothing to protect (it ships in the bundle), and
// a stored copy would be one more place for it to go stale relative to shared/keys.mjs.
const K_PUBLIC = derivePublicChannelKey()

/** Characters the hashtag costs, including its leading space. */
const TAG_COST = HASHTAG.length + 1

/**
 * How much of the remaining budget we aim at when splitting.
 *
 * Cover length is NOT a deterministic function of payload length — it depends on the bit pattern
 * and the path the model walks, and the measured spread between a typical post and the worst one
 * of a batch is roughly 20-25%. Targeting the full budget would therefore overflow regularly, and
 * an overflowing post is one X simply rejects. We aim under and verify afterwards.
 */
const SAFETY = 0.78

let inbound: { reset: () => void } | null = null
/** Holds thread parts until every one has been seen. Long-lived: parts arrive out of order. */
const threads = new ThreadCollector()

/**
 * Resolve the configured recipient handles to X25519 pubkeys.
 *
 * Returns null if ANY handle fails to resolve. Fail-closed on purpose: silently dropping an
 * unresolvable recipient would post a message the sender believes reached five people and that
 * actually reached four, with no indication which one was missed. On a public, permanent channel
 * that is not a recoverable mistake.
 */
async function resolveRecipients(handles: string[]): Promise<{ pubs: Uint8Array[]; missing: string[] }> {
  const pubs: Uint8Array[] = []
  const missing: string[] = []
  for (const h of handles) {
    const res = await sendToCodec<ResolveData>({ type: 'RESOLVE', handle: h })
    if (!res.ok || !res.data.pubkey) {
      missing.push(h)
      continue
    }
    try {
      pubs.push(fromHex(res.data.pubkey))
    } catch {
      missing.push(h)
    }
  }
  return { pubs, missing }
}

/** The recipient handles the user configured in the popup; empty = Mode 1. */
async function configuredRecipients(): Promise<string[]> {
  const got = await chrome.storage.local.get(LOCAL.recipients)
  const raw = got[LOCAL.recipients]
  return Array.isArray(raw) ? (raw as string[]).filter(Boolean) : []
}

/** Encode one frame to cover text, hashtag appended. Null on any codec failure. */
async function coverFor(frame: Uint8Array): Promise<string | null> {
  const res = await sendToCodec<EncodeData>({
    type: 'ENCODE',
    ciphertextB64: toB64(frame),
    handle: await meteringBucket(),
  })
  if (!res.ok) {
    console.warn('[lortnoc] encode failed:', res.error)
    // 402 is not a failure of ours — it is the free limit (§9). Say so, because "codec
    // unreachable" sends someone debugging their network for a quota message.
    if (res.status === 402) lastError = 'Free limit reached — become a member to keep posting'
    else lastError = 'Codec unreachable — not posted'
    return null
  }
  return appendTag(res.data.coverText)
}

/** Set by coverFor so the progress stepper can report WHY, not just that it failed. */
let lastError = 'Codec unreachable — not posted'

/**
 * Outbound: real text → squeeze → AES-SIV → frame(s) → codec → cover text + hashtag.
 *
 * Returns the posts to publish, or null to ABORT. Every failure path returns null, because the
 * alternative is posting the user's plaintext to a public timeline — the one mistake on this
 * surface that cannot be walked back.
 *
 * The split is MEASURED, not predicted. We encode the whole thing as one post first; if it fits
 * we are done, and if it does not, that attempt has just told us this payload's real
 * characters-per-byte ratio, which is what sizes the parts. Guessing the ratio up front would be
 * wrong in both directions — it varies by roughly 2x across codec backends (block vs arithmetic
 * coder) and the extension does not know which one the codec is running.
 */
async function swap(real: string, progress: Progress): Promise<string[] | null> {
  progress.set(0)
  const { bytes, compressed } = squeezeIfSmaller(real)

  // Mode 3 when recipients are configured, Mode 1 otherwise. The mode is a property of the
  // MESSAGE, not of the install, and it travels in the frame — so a reader never has to guess.
  const handles = await configuredRecipients()
  let mode: number = X_MODE.PUBLIC // widened: X_MODE.* are literal types, and this is reassigned
  let cipher: Uint8Array
  if (handles.length) {
    const { pubs, missing } = await resolveRecipients(handles)
    if (missing.length) {
      // Fail closed. See resolveRecipients: a partially-addressed post is worse than none.
      console.warn('[lortnoc] unresolved recipients:', missing)
      progress.fail(`Could not resolve ${missing.join(', ')} — not posted`)
      return null
    }
    mode = X_MODE.RECIPIENTS
    cipher = sealTo(pubs, bytes)
    console.debug('[lortnoc] mode 3: sealed to %d recipients (+%d bytes)', pubs.length, overheadFor(pubs.length))
  } else {
    cipher = encryptBytes(K_PUBLIC, bytes)
  }

  progress.set(1, 'weaving the first post')
  const single = buildXFrames(mode, cipher, { squeezed: compressed })[0]
  const firstCover = await coverFor(single)
  if (firstCover == null) {
    progress.fail(lastError)
    return null
  }
  if (firstCover.length <= POST_LIMIT) {
    progress.set(2, `${firstCover.length}/${POST_LIMIT} characters`)
    console.debug('[lortnoc] swap: %o -> 1 post, %d chars', real, firstCover.length)
    return [firstCover]
  }

  // Too long for one post. That attempt measured the ratio for THIS payload, so size the parts
  // from it rather than from a constant.
  const charsPerByte = (firstCover.length - TAG_COST) / single.length
  const budget = (POST_LIMIT - TAG_COST) * SAFETY
  const THREADED_HEADER = 4

  for (let attempt = 0; attempt < 3; attempt++) {
    const shrink = SAFETY ** attempt // each retry aims lower still
    const chunk = Math.max(2, Math.floor((budget * shrink) / charsPerByte) - THREADED_HEADER)
    const parts = Math.ceil(cipher.length / chunk)
    if (parts > MAX_PARTS) {
      console.warn(`[lortnoc] message needs ${parts} posts, max ${MAX_PARTS}`)
      progress.fail(`Too long — needs ${parts} posts, max ${MAX_PARTS}`)
      return null
    }

    progress.set(1, `weaving ${parts} posts`)
    const frames = buildXFrames(mode, cipher, { squeezed: compressed, chunkBytes: chunk })
    const covers: string[] = []
    let overflow = false
    for (const [i, f] of frames.entries()) {
      progress.set(1, `weaving post ${i + 1} of ${frames.length}`)
      const c = await coverFor(f)
      if (c == null) {
        progress.fail(lastError)
        return null
      }
      if (c.length > POST_LIMIT) {
        overflow = true
        break // this chunk size is too big; retry smaller rather than post something X rejects
      }
      covers.push(c)
    }
    if (!overflow) {
      progress.set(2, `${covers.length} posts, longest ${Math.max(...covers.map((c) => c.length))}/${POST_LIMIT}`)
      console.debug('[lortnoc] swap: %o -> %d posts', real, covers.length)
      return covers
    }
    console.debug('[lortnoc] a part overflowed at chunk=%d, retrying smaller', chunk)
  }

  progress.fail('Could not fit this message — try a shorter one')
  return null
}

/**
 * Inbound: cover text → codec → frame → reassemble → AES-SIV decrypt → unsqueeze.
 *
 * The AES-SIV auth tag is the detector. A tweet carrying the hashtag but not ours fails the tag
 * and is left exactly as posted.
 *
 * A thread part that does not complete a thread returns null — "nothing to render here" — which
 * the scanner caches so the post is never decoded twice. The parts stay in the collector, so
 * whichever post completes the thread is where the message appears. An incomplete thread renders
 * nothing at all, ever: the ciphertext cannot be decrypted without every part, so failing closed
 * is structural rather than a check that might be forgotten (PRD §6).
 */
async function decode(cover: string): Promise<string | null | typeof RETRY> {
  const res = await sendToCodec<DecodeData>({ type: 'DECODE', coverText: cover })
  if (!res.ok) {
    // 422 = "not codec cover text" → a definitive not-ours. Anything else (offline, 5xx) is
    // transient and must NOT be cached as a verdict, or the post never decodes again.
    return res.error.includes('422') ? null : RETRY
  }

  const frame = parseXFrame(fromB64(res.data.ciphertext))
  if (!frame) return null // not one of ours, or a newer build's mode
  if (frame.mode !== X_MODE.PUBLIC && frame.mode !== X_MODE.RECIPIENTS) return null // mode 2 unbuilt

  const cipher = threads.offer(frame)
  if (!cipher) return null // a thread part, still waiting on its siblings

  let plain: Uint8Array | null
  if (frame.mode === X_MODE.RECIPIENTS) {
    // Mode 3 needs OUR private key. No identity unlocked means we simply are not a reader of this
    // post — which is indistinguishable, from here, from not being a named recipient. That is the
    // property working as intended, not an error to surface.
    const me = await identity.current()
    if (!me) return RETRY // locked now; a later unlock should re-try this post rather than cache it
    plain = openSealed(me.priv, me.pub, cipher)
  } else {
    plain = tryDecryptBytes(K_PUBLIC, cipher)
  }
  if (!plain) return null // tag failed: not addressed to us, someone else's post, or corrupted
  return unsqueezeMaybe(plain, frame.squeezed)
}

async function main(): Promise<void> {
  if (!onX()) return
  injectStyles()

  await initState(() => {
    // The popup toggled something: re-scan so posts skipped while off now decode.
    inbound?.reset()
  })

  installPostInterceptor(ready, swap)
  inbound = startInbound(ready, decode)

  // Fail loudly when the composer selector stops matching — X ships new markup without notice,
  // and the failure mode otherwise is a silently inert extension.
  window.setTimeout(() => {
    if (ready() && !activeCompose()) {
      console.warn('[lortnoc] composer not found — X may have changed its markup')
      toast('Could not find the composer. X may have changed — the overlay is inactive.', 6000)
    }
  }, 4000)

  console.info('[lortnoc] X overlay ready (mode 1 — public channel, threading on)')
}

void main()
