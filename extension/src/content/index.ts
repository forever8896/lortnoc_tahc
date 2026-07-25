// Content-script entry: wires compose interception, inbound decoding, and the Tier-1
// in-band handshake (§5.3) to the codec (via the SW) and the in-page crypto. Plaintext
// and keys never leave here.
import { detectClient, selectorsFor, activeCompose } from './selectors'
import { injectStyles, toast, showAcceptBanner } from './ui'
import { initState, get } from './state'
import { installSendInterceptor, sendCoverText } from './compose'
import { startInbound } from './inbound'
import { encrypt, tryDecrypt, toB64, fromB64 } from './crypto'

const toHex = (u: Uint8Array): string => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')
import { parseFrame, FRAME } from './handshake'
import * as session from './session'
import { sendToCodec } from '../shared/messages'
import type { EncodeData, DecodeData } from '../shared/messages'

// The active messaging key: the handshake's ECDH key once established, else the
// passphrase-derived key (fallback). Handshake means no shared passphrase is needed.
function activeKey(): Uint8Array | null {
  return session.convKey() ?? get().key
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
  const frame = await session.startOffer()
  const cover = await bytesToCover(frame, true) // fast: handshake frame, skip best-of-N
  if (cover && (await sendCoverText(cover))) toast('Invite sent. Waiting for the other side to accept…')
  else toast('Could not send the invite — is Stego on and the codec reachable?')
}

let inbound: { reset: () => void } | null = null

/** Short fingerprint of the conversation key — BOTH users should see the SAME value once
 *  the handshake is established. If they differ, the ECDH keys crossed (retry the connect). */
function logKeyFingerprint(): void {
  const k = session.convKey()
  console.info('[lortnoc] convKey fingerprint:', k ? toHex(k.slice(0, 6)) : '(none)', '— must MATCH the other side')
}

async function handleFrame(type: number, pubkey: Uint8Array): Promise<void> {
  if (session.isMine(pubkey)) return // our own frame echoed back into the chat — ignore
  if (type === FRAME.OFFER) {
    showAcceptBanner(async () => {
      const ack = await session.acceptOffer(pubkey)
      const cover = await bytesToCover(ack, true) // fast: handshake frame, skip best-of-N
      if (cover) await sendCoverText(cover)
      console.info('[lortnoc] session established (accepted); re-scanning inbound')
      inbound?.reset() // decode any messages that arrived before the key
      logKeyFingerprint()
      toast('Private session established — no passphrase needed.')
    })
  } else if (type === FRAME.ACK) {
    await session.onAck(pubkey)
    console.info('[lortnoc] session established (ack); re-scanning inbound')
    inbound?.reset() // KEY FIX: re-decode messages that arrived before the key was set
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
    sendResponse({ status: session.status(), hasKey: haveKey(), client: detectClient() })
    return true
  }
  if (msg?.type === 'HS_RESET') {
    void session.reset().then(() => sendResponse({ ok: true }))
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
  installSendInterceptor(client, haveKey, async (real) => {
    const key = activeKey()
    if (!key) return null
    try {
      const cover = await bytesToCover(encrypt(key, real))
      if (!cover) console.warn('[lortnoc] encode failed')
      return cover
    } catch (e) {
      console.warn('[lortnoc] encrypt error:', e)
      return null
    }
  })

  // Inbound: cover → /decode → bytes → handshake frame? handle it : AES-SIV decrypt.
  // Returns 'retry' on transient failure (no key yet / codec error) so the bubble is
  // re-tried later — never permanently cached as "not ours" (the asymmetric-decode bug).
  inbound = startInbound(client, () => get().enabled, async (cover) => {
    let res
    try {
      res = await sendToCodec<DecodeData>({ type: 'DECODE', coverText: cover })
    } catch {
      return 'retry' // network glitch — try again
    }
    if (!res.ok) {
      // 422 = genuinely not codec cover text (normal chatter) → cache; else transient
      return res.error?.includes('422') ? null : 'retry'
    }
    const bytes = fromB64(res.data.ciphertext)
    const frame = parseFrame(bytes)
    if (frame) {
      await handleFrame(frame.type, frame.pubkey)
      return null // handled as handshake — not a message
    }
    const key = activeKey()
    if (!key) return 'retry' // no key yet — don't poison the cache; decode after handshake
    const pt = tryDecrypt(key, bytes)
    if (pt === null) console.debug('[lortnoc] inbound: had key but AES-SIV tag failed (not ours or key mismatch)')
    return pt
  })

  console.info('[lortnoc] content script ready (Web K)')
}

  void main()
} // end boot()
