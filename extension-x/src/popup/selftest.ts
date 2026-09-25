// Self-test: round-trip a real message through the whole stack, with no X page involved.
//
// WHY THIS EXISTS. When a post fails there are five candidate causes — the codec, the crypto, the
// frame, the split, or the DOM — and from inside a content script on x.com they are almost
// impossible to tell apart. This runs everything EXCEPT the DOM. A green run says the failure is
// in the page layer; a red one says exactly which stage below it broke, and never makes you guess.
//
// It deliberately imports the SAME modules the content script uses rather than re-implementing a
// simplified version. A self-test that passes against its own copy of the logic tells you nothing
// — that is the failure the whole suite is built to avoid (see the note at the top of keys.mjs).
import {
  encryptBytes,
  tryDecryptBytes,
  derivePublicChannelKey,
  deriveMessagingKey,
  deriveMasterSecret,
  toB64,
  fromB64,
  buildXFrames,
  parseXFrame,
  ThreadCollector,
  X_MODE,
  appendTag,
  stripTag,
  squeezeIfSmaller,
  unsqueezeMaybe,
  sealTo,
  openSealed,
} from '../content/crypto'
import { sendToCodec } from '../shared/messages'
import type { EncodeData, DecodeData, HealthData } from '../shared/messages'
import { POST_LIMIT, LOCAL } from '../shared/config'
import { resolvedBucket } from '../content/bucket'

export type Stage = { name: string; ok: boolean; detail: string }

const MESSAGE = 'meet at 8 by the usual place'

/**
 * The metering bucket to test under (§9).
 *
 * MUST be passed. Without it every self-test encode lands in auth.py's `_ANON` bucket — shared
 * with every caller that omits a handle — so the self-test reported "codec round trip failed"
 * the moment that shared allowance ran out, while real sends (which do pass a bucket) were fine.
 * A diagnostic that fails for a reason unrelated to the thing being diagnosed is worse than none.
 */
async function bucket(): Promise<string> {
  const resolved = await resolvedBucket()
  if (resolved) return resolved
  const got = await chrome.storage.local.get(LOCAL.bucket)
  const id = got[LOCAL.bucket] as string | undefined
  return id ? `inst:${id}` : 'inst:selftest'
}

/** Encode → hashtag → strip → decode, i.e. exactly what a post and a read do to one frame. */
async function throughCodec(frame: Uint8Array): Promise<{ bytes: Uint8Array | null; chars: number; why?: string }> {
  const enc = await sendToCodec<EncodeData>({
    type: 'ENCODE',
    ciphertextB64: toB64(frame),
    handle: await bucket(),
    // `fast` is exempt from metering (codec/server.py: `if auth.ENFORCE and not fast`) and skips
    // best-of-N selection. Both are right for a diagnostic: a self-test posts nothing, so it
    // should not spend the user's send allowance — this run makes ~7 encode calls against a free
    // limit of 10, so metering it would mean one diagnostic locks you out of actually posting.
    fast: true,
  })
  // 402 is the free limit, not a broken stack. Say so, or this reads as a codec fault.
  if (!enc.ok) return { bytes: null, chars: 0, why: enc.status === 402 ? 'free limit reached' : enc.error }
  const posted = appendTag(enc.data.coverText)
  const cover = stripTag(posted)
  if (cover === null) return { bytes: null, chars: posted.length }
  const dec = await sendToCodec<DecodeData>({ type: 'DECODE', coverText: cover })
  if (!dec.ok) return { bytes: null, chars: posted.length }
  return { bytes: fromB64(dec.data.ciphertext), chars: posted.length }
}

export async function runSelfTest(): Promise<Stage[]> {
  const out: Stage[] = []
  const add = (name: string, ok: boolean, detail: string): boolean => {
    out.push({ name, ok, detail })
    return ok
  }

  // 1. codec reachable AND usable. Paused is its own answer: healthy, and refuses every post.
  const health = await sendToCodec<HealthData>({ type: 'HEALTH' })
  if (!health.ok) {
    add('codec', false, 'unreachable')
    return out
  }
  if (health.data.paused) {
    add('codec', false, 'paused — point at a local one')
    return out
  }
  add('codec', true, health.data.model)

  // 2. compression — local, so a failure here is never the network.
  const { bytes: squeezed, compressed } = squeezeIfSmaller(MESSAGE)
  if (!add('squeeze', unsqueezeMaybe(squeezed, compressed) === MESSAGE,
      `${MESSAGE.length}B → ${squeezed.length}B`)) return out

  // 3. Mode 1, single post: the booth path.
  const kPublic = derivePublicChannelKey()
  const frame1 = buildXFrames(X_MODE.PUBLIC, encryptBytes(kPublic, squeezed), { squeezed: compressed })[0]
  const r1 = await throughCodec(frame1)
  if (!r1.bytes) return (add('mode 1', false, r1.why ?? 'codec round trip failed'), out)
  const p1 = parseXFrame(r1.bytes)
  const m1 = p1 && tryDecryptBytes(kPublic, p1.payload)
  add('mode 1', !!m1 && unsqueezeMaybe(m1, p1!.squeezed) === MESSAGE,
      `${r1.chars}/${POST_LIMIT} chars`)

  // 4. Threading: force a split, deliver the parts BACKWARDS, reassemble. Out-of-order is the
  //    real case — a virtualised feed does not hand parts over in sequence.
  const cipher = encryptBytes(kPublic, squeezed)
  const parts = buildXFrames(X_MODE.PUBLIC, cipher, { squeezed: compressed, chunkBytes: 8 })
  const collector = new ThreadCollector()
  let joined: Uint8Array | null = null
  let lastSqueezed = compressed
  for (const f of [...parts].reverse()) {
    const r = await throughCodec(f)
    if (!r.bytes) break
    const parsed = parseXFrame(r.bytes)
    if (!parsed) break
    lastSqueezed = parsed.squeezed
    joined = collector.offer(parsed) ?? joined
  }
  const mThread = joined && tryDecryptBytes(kPublic, joined)
  add('threading', !!mThread && unsqueezeMaybe(mThread, lastSqueezed) === MESSAGE,
      `${parts.length} parts, reversed`)

  // 5. Mode 3 with a LOCAL recipient — proves seal/open and the invisible-recipient property
  //    without needing a published handle or a second person.
  const me = deriveMessagingKey(deriveMasterSecret(new TextEncoder().encode('selftest-reader')))
  const other = deriveMessagingKey(deriveMasterSecret(new TextEncoder().encode('selftest-stranger')))
  const sealed = sealTo([me.pub], squeezed)
  const frame3 = buildXFrames(X_MODE.RECIPIENTS, sealed, { squeezed: compressed })[0]
  const r3 = await throughCodec(frame3)
  if (!r3.bytes) return (add('mode 3', false, r3.why ?? 'codec round trip failed'), out)
  const p3 = parseXFrame(r3.bytes)
  const mine = p3 && openSealed(me.priv, me.pub, p3.payload)
  add('mode 3', !!mine && unsqueezeMaybe(mine, p3!.squeezed) === MESSAGE, `${r3.chars} chars`)
  // The negative half matters as much: a non-recipient must get nothing, not a partial read.
  add('stranger blind', !!p3 && openSealed(other.priv, other.pub, p3.payload) === null, 'not a recipient')

  return out
}

/** Resolve the configured recipients, so a Mode 3 failure separates "ENS" from "crypto". */
export async function checkRecipients(handles: string[]): Promise<Stage[]> {
  const out: Stage[] = []
  for (const h of handles) {
    const res = await sendToCodec<{ handle: string; pubkey: string | null }>({ type: 'RESOLVE', handle: h })
    out.push({
      name: h,
      ok: res.ok && !!res.data.pubkey,
      detail: res.ok ? (res.data.pubkey ? `${res.data.pubkey.slice(0, 12)}…` : 'no pubkey published') : 'lookup failed',
    })
  }
  return out
}
