// Content-script entry: wires compose interception, inbound decoding, and the Tier-1
// in-band handshake (§5.3) to the codec (via the SW) and the in-page crypto. Plaintext
// and keys never leave here.
import { detectClient, selectorsFor, activeCompose } from './selectors'
import { injectStyles, toast, showAcceptBanner, showPaywall } from './ui'
import { initState, get } from './state'
import { installSendInterceptor, sendCoverText } from './compose'
import { startInbound, RETRY } from './inbound'
import { encrypt, tryDecrypt, toB64, fromB64 } from './crypto'
import {
  loadMeter,
  isBlocked,
  isRunningLow,
  increment,
  remaining,
  sends,
  syncFromServer,
  markBlocked,
  getMembershipToken,
} from './metering'
import { getSelfHandle, getTelegramUsername } from './identity'
import { UPGRADE_URL, LOCAL, appUrlWithHandle } from '../shared/config'

const toHex = (u: Uint8Array): string => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')
import { parseFrame, FRAME } from './handshake'
import * as session from './session'
import { sendToCodec } from '../shared/messages'
import type { EncodeData, DecodeData } from '../shared/messages'

// The ONE messaging key: the handshake's ECDH key. There is no passphrase fallback —
// having two ways to key a chat meant the two sides could silently pick different ones, and
// each would then decode only its own messages while the peer's stayed cover text. If there is
// no session there is no key, and that is now a visible state rather than a silent wrong answer.
function activeKey(): Uint8Array | null {
  return session.convKey()
}
function haveKey(): boolean {
  return activeKey() !== null
}

/** Encode arbitrary bytes to cover text via the codec. `fast` skips best-of-N (used for
 *  handshake frames — they carry only public keys, so cover polish isn't worth ~11s). */
async function bytesToCover(bytes: Uint8Array, fast = false): Promise<string | null> {
  const res = await sendToCodec<EncodeData>({ type: 'ENCODE', ciphertextB64: toB64(bytes), fast })
  return res.ok ? res.data.coverText : null
}

async function sendOffer(): Promise<void> {
  // Don't break a working session, and NEVER regenerate the keypair mid-handshake — that
  // was the decrypt bug: a second Connect click changed our pubkey, so the key each side
  // derived no longer matched. startOffer() reuses the existing keypair (stable pubkey).
  if (session.status() === 'established') {
    toast('Already connected — you can just type.')
    return
  }
  const frame = await session.startOffer()
  const cover = await bytesToCover(frame, true) // fast: handshake frame, skip best-of-N
  if (cover && (await sendCoverText(cover))) {
    toast('Invite sent. Waiting for the other side to accept…')
    watchForAnswer()
  } else {
    toast('Could not send the invite — is Stego on and the codec reachable?')
  }
}

/**
 * An offer can go unanswered for boring reasons: the other side had the extension reloaded and
 * their content script was orphaned, or their tab was not on the chat when it landed. Silence for
 * 25s used to look identical to a broken handshake, so say something and offer a way forward.
 */
let answerWatch: ReturnType<typeof setTimeout> | null = null

function watchForAnswer(): void {
  if (answerWatch) clearTimeout(answerWatch)
  answerWatch = setTimeout(() => {
    if (session.status() === 'established') return
    console.warn('[lortnoc] no answer 25s after the invite — the other side may not have it')
    toast('Still waiting. Make sure the other side has PrivacyMaxxing on and this chat open, then click Connect there too.')
  }, 25_000)
}

let inbound: { reset: () => void } | null = null
let selfHandle = '' // metering bucket key (§9), resolved in main()
let tgUsername: string | null = null // Telegram @username, for prefilling the app claim field

/** Short fingerprint of the conversation key — BOTH users should see the SAME value once
 *  the handshake is established. If they differ, the ECDH keys crossed (retry the connect). */
function logKeyFingerprint(): void {
  const k = session.convKey()
  console.info('[lortnoc] convKey fingerprint:', k ? toHex(k.slice(0, 6)) : '(none)', '— must MATCH the other side')
}

/**
 * A bubble that decodes as cover text but fails the AES-SIV tag is ambiguous: it is either
 * someone else's stego, or ours with the wrong key. One is nothing; several in a row is a key
 * mismatch, and silently leaving garble on screen is how that used to go unnoticed for a whole
 * conversation. So we count them and say so.
 */
let tagFailures = 0
let mismatchWarned = false

function noteTagFailure(): void {
  tagFailures += 1
  console.debug('[lortnoc] inbound: decoded, but the AES-SIV tag failed — not ours, or wrong key')
  if (tagFailures >= 3 && !mismatchWarned && session.status() === 'established') {
    mismatchWarned = true
    console.warn('[lortnoc] repeated tag failures with an established session — keys do not match')
    toast('Key mismatch — their messages will not open. Both hit Disconnect, then Connect again.')
  }
}

// Every handshake frame is acted on AT MOST ONCE (by type+pubkey). Without this, the
// inbound.reset() re-scan after a session establishes re-decodes the OFFER/ACK bubbles and
// re-fires the accept banner / onAck → an infinite handshake loop that resends frames.
const handledFrames = new Set<string>()

/** Establish from a received offer: derive K_conv, send our ack, re-scan. */
async function establishFromOffer(pubkey: Uint8Array): Promise<void> {
  const ack = await session.acceptOffer(pubkey) // derives K_conv, status → established
  const cover = await bytesToCover(ack, true) // fast: handshake frame, skip best-of-N
  if (cover) await sendCoverText(cover)
  console.info('[lortnoc] session established; re-scanning inbound')
  if (answerWatch) clearTimeout(answerWatch)
  tagFailures = 0
  mismatchWarned = false
  inbound?.reset() // decode any messages that arrived before the key
  logKeyFingerprint()
  toast('Private session established.')
}

async function handleFrame(type: number, pubkey: Uint8Array): Promise<void> {
  if (session.isMine(pubkey)) return // our own frame echoed back into the chat — ignore

  // A peer who resets (or reinstalls) comes back with a NEW pubkey and offers again. Ignoring
  // that because we think we are "already connected" left the two sides holding different keys
  // forever — the exact symptom where each side can read only its own messages. So: an offer
  // from a pubkey that is not our current peer means they restarted, and we re-establish.
  if (session.status() === 'established') {
    if (type === FRAME.OFFER && !session.isPeer(pubkey)) {
      console.info('[lortnoc] peer re-offered with a new key — re-establishing')
      handledFrames.clear()
      await establishFromOffer(pubkey)
    }
    return
  }
  const fkey = `${type}:${toHex(pubkey)}`
  if (handledFrames.has(fkey)) return // already processed (e.g. re-scanned after reset)
  handledFrames.add(fkey)
  console.info('[lortnoc] handshake frame received:', type === FRAME.OFFER ? 'offer' : 'ack')
  if (type === FRAME.OFFER) {
    if (session.status() === 'offered') {
      // GLARE: we also clicked Connect → we already have each other's pubkey, so just
      // connect (no second click). This is why "both click Connect" now just works.
      await establishFromOffer(pubkey)
    } else {
      // fresh invite → consent with one tap
      showAcceptBanner(() => void establishFromOffer(pubkey))
    }
  } else if (type === FRAME.ACK) {
    await session.onAck(pubkey)
    console.info('[lortnoc] session established (ack); re-scanning inbound')
    if (answerWatch) clearTimeout(answerWatch)
    tagFailures = 0
    mismatchWarned = false
    inbound?.reset()
    logKeyFingerprint()
    toast('They accepted — private session established.')
  }
}

// Idempotency guard: the popup can re-inject this script to self-heal after an extension
// reload (which orphans the previous instance). Run the side effects (listener + main)
// only once per frame, so a second injection is a no-op.
declare global {
  interface Window {
    __lortnocLoaded?: boolean
  }
}
if (window.__lortnocLoaded) {
  console.debug('[lortnoc] already loaded in this frame — skipping re-init')
} else {
  window.__lortnocLoaded = true
  boot()
}

function boot(): void {
// Register the popup ↔ content-script listener IMMEDIATELY (before any awaits or the
// client check) so the popup can always reach us — otherwise a slow init or an
// unsupported client would make the popup report "open a telegram tab" wrongly.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'START_HANDSHAKE') {
    void sendOffer().then(() => sendResponse({ ok: true }))
    return true
  }
  if (msg?.type === 'HS_STATUS') {
    // The fingerprint goes to the popup, not just the console. A key mismatch is the one
    // failure that looks exactly like "the codec is broken", and the only way to tell them
    // apart is for the two people to compare six bytes — so put it where they can read it.
    const k = session.convKey()
    sendResponse({
      status: session.status(),
      hasKey: haveKey(),
      client: detectClient(),
      fingerprint: k ? toHex(k.slice(0, 6)) : null,
    })
    return true
  }
  if (msg?.type === 'HS_RESET') {
    void session.reset().then(() => sendResponse({ ok: true }))
    return true
  }
  if (msg?.type === 'GET_TG_HANDLE') {
    // The popup's conversion banner asks for this to prefill the app's claim field.
    void getTelegramUsername().then((handle) => sendResponse({ handle }))
    return true
  }
  return false
})

async function main(): Promise<void> {
  injectStyles()
  try {
    await session.loadSession()
  } catch (e) {
    console.warn('[lortnoc] loadSession failed (continuing):', e)
  }
  await initState()
  await loadMeter() // freemium counter + paid flag (§9)
  selfHandle = await getSelfHandle() // stable metering bucket (§9), resolved once
  void getTelegramUsername().then((u) => (tgUsername = u)) // best-effort, for claim prefill
  // React instantly when the app delivers a membership token (paid claim) — no reload needed.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (LOCAL.meter in changes || LOCAL.membership in changes)) void loadMeter()
  })

  const client = detectClient()
  console.info('[lortnoc] loaded on', location.pathname, '→ client:', client)
  if (client !== 'k') {
    console.warn('[lortnoc] Unsupported Telegram Web client — use web.telegram.org/k/.')
    return
  }
  const sel = selectorsFor(client)!
  console.info(
    '[lortnoc] compose=%s · enabled=%s · session=%s · hasKey=%s',
    !!activeCompose(sel),
    get().enabled,
    session.status(),
    haveKey(),
  )

  // Outbound: real text → AES-SIV(activeKey) → /encode → cover text (or null = fail-closed).
  // Reports each real stage to the progress stepper so the ~10s send is legible.
  installSendInterceptor(client, haveKey, async (real, progress) => {
    // Freemium gate (§9): out of free sends and not a member → fail-closed + funnel to pay.
    // Reading/decoding stays free; only sending is metered.
    // A membership token (from a paid claim) skips the local block — let the server confirm it.
    const token = await getMembershipToken()
    if (!token && isBlocked()) {
      // fast local pre-gate to skip a doomed round-trip; the codec is the real authority
      progress.fail('Free trial used up — unlock to keep sending')
      showPaywall(appUrlWithHandle(UPGRADE_URL, tgUsername), sends())
      return null
    }
    const key = activeKey()
    if (!key) {
      // Fail-closed is right — never send plaintext because a handshake did not finish. But
      // this returned null in silence, and compose reports a null cover as "Encoding failed",
      // so an unkeyed chat looked like a codec/0G outage. It is neither: there is no session.
      progress.fail('No private session yet — click Connect first')
      toast('Not sent. This chat has no private session yet — open the popup and click Connect.')
      return null
    }
    try {
      progress.set(0, 'AES-SIV · never leaves this page')
      const ct = encrypt(key, real)
      progress.set(1, 'GPT-2 · hiding it as chatter')
      // Best-of-N runs at the tail of /encode. This label used to CLAIM "0G · judging 2 covers"
      // on a blind 4.5s timer, which meant any send that stalled past 4.5s sat there accusing
      // 0G of a failure that belonged to something else — and, worse, still claimed 0G had
      // judged when 0G was down (selection falls back silently). Stay neutral here; the codec
      // reports what actually happened and we say so below.
      const tSelect = window.setTimeout(() => progress.set(2, 'Choosing the most natural of 2'), 4500)
      try {
        const res = await sendToCodec<EncodeData>({
          type: 'ENCODE',
          ciphertextB64: toB64(ct),
          handle: selfHandle, // server meters per handle (§9)
          membership: token, // membership token → unlimited when valid
        })
        if (!res.ok) {
          if (res.status === 402) {
            // x402: free limit reached server-side → paywall, funnel to pay
            await markBlocked()
            progress.fail('Free trial used up — unlock to keep sending')
            showPaywall(appUrlWithHandle(UPGRADE_URL, tgUsername), sends())
          } else {
            console.warn('[lortnoc] encode failed:', res.error)
          }
          return null
        }
        const { coverText, remaining: left, member, select } = res.data
        // Say what actually happened, now that we know. A silent 0G fallback used to be
        // indistinguishable from a successful 0G judgement — which matters, because "proof of
        // 0G inference" is the one thing we are meant to be able to demonstrate.
        if (select?.startsWith('0g')) {
          progress.set(2, '0G · judged 2 covers, picked the most natural')
        } else if (select === 'fallback') {
          progress.set(2, '0G unreachable — sent the first cover')
          console.warn('[lortnoc] 0G selection fell back: the cover was NOT judged by 0G')
        }
        if (typeof left === 'number' && (left >= 0 || member === true)) {
          await syncFromServer(left, member === true) // server enforcing → mirror its count
        } else {
          await increment() // server not enforcing → local metering (pre-flip behaviour)
          if (isRunningLow()) {
            const n = remaining()
            toast(`${n} free message${n === 1 ? '' : 's'} left — members send unlimited.`, 5000)
          }
        }
        return coverText
      } finally {
        window.clearTimeout(tSelect)
      }
    } catch (e) {
      console.warn('[lortnoc] encrypt error:', e)
      return null
    }
  })

  // Inbound: cover → /decode → bytes → handshake frame? handle it : AES-SIV decrypt.
  // Returns RETRY on transient failure (no key yet / codec error) so the bubble is
  // re-tried later — never permanently cached as "not ours" (the asymmetric-decode bug).
  inbound = startInbound(client, () => get().enabled, async (cover, fromHistory) => {
    let res
    try {
      res = await sendToCodec<DecodeData>({ type: 'DECODE', coverText: cover })
    } catch {
      return RETRY // network glitch — try again
    }
    if (!res.ok) {
      // 422 = genuinely not codec cover text (normal chatter) → cache; else transient
      return res.error?.includes('422') ? null : RETRY
    }
    const bytes = fromB64(res.data.ciphertext)
    const frame = parseFrame(bytes)
    if (frame) {
      // A frame already in the chat when we loaded is a FOSSIL of an earlier session, and the
      // keypair behind it is long gone. Acting on it derived a key against a pubkey the peer no
      // longer holds, announced "Private session established", then reset the decode cache —
      // which rescanned and found the next fossil, and the next. That loop is why both sides
      // ended up established on DIFFERENT keys, each able to read only its own messages.
      // Fossils still decode as messages below; they just never drive the handshake.
      if (fromHistory) {
        console.info('[lortnoc] ignoring a handshake frame from chat history (not a live invite)')
      } else {
        console.info('[lortnoc] inbound frame:', frame.type === FRAME.OFFER ? 'OFFER' : 'ACK',
          'from', toHex(frame.pubkey.slice(0, 6)), '· our status:', session.status())
        await handleFrame(frame.type, frame.pubkey)
      }
      return null // handled as handshake — not a message
    }
    const key = activeKey()
    if (!key) {
      // Decoded as stego but we hold no key and it was not a frame. Before, this returned RETRY
      // in silence — so a handshake that never completed looked identical to nothing happening.
      console.info('[lortnoc] inbound: decoded', bytes.length, 'bytes but no session yet — waiting for the handshake')
      return RETRY
    }
    const pt = tryDecrypt(key, bytes)
    if (pt === null) noteTagFailure()
    else tagFailures = 0
    return pt
  })

  console.info('[lortnoc] content script ready (Web K)')
}

  void main()
} // end boot()
