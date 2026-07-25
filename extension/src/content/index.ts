// Content-script entry: wires compose interception, inbound decoding, and the Tier-1
// in-band handshake (§5.3) to the codec (via the SW) and the in-page crypto. Plaintext
// and keys never leave here.
import { detectClient, selectorsFor, activeCompose } from './selectors'
import { injectStyles, toast, showAcceptBanner } from './ui'
import { initState, get } from './state'
import { installSendInterceptor, sendCoverText } from './compose'
import { startInbound } from './inbound'
import { encrypt, tryDecrypt, toB64, fromB64 } from './crypto'
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
  if (cover && (await sendCoverText(cover))) toast('🤝 Invite sent. Waiting for the other side to accept…')
  else toast('Could not send the invite — is Stego on and the codec reachable?')
}

async function handleFrame(type: number, pubkey: Uint8Array): Promise<void> {
  if (session.isMine(pubkey)) return // our own frame echoed back into the chat — ignore
  if (type === FRAME.OFFER) {
    showAcceptBanner(async () => {
      const ack = await session.acceptOffer(pubkey)
      const cover = await bytesToCover(ack, true) // fast: handshake frame, skip best-of-N
      if (cover) await sendCoverText(cover)
      toast('🔒 Private session established — no passphrase needed.')
    })
  } else if (type === FRAME.ACK) {
    await session.onAck(pubkey)
    toast('🔒 They accepted — private session established.')
  }
}

async function main(): Promise<void> {
  injectStyles()
  await session.loadSession()
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

  // Popup → content-script commands (start handshake, query status, reset).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'START_HANDSHAKE') {
      void sendOffer().then(() => sendResponse({ ok: true }))
      return true
    }
    if (msg?.type === 'HS_STATUS') {
      sendResponse({ status: session.status(), hasKey: haveKey() })
      return true
    }
    if (msg?.type === 'HS_RESET') {
      void session.reset().then(() => sendResponse({ ok: true }))
      return true
    }
    return false
  })

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
  startInbound(client, () => get().enabled, async (cover) => {
    try {
      const res = await sendToCodec<DecodeData>({ type: 'DECODE', coverText: cover })
      if (!res.ok) return null
      const bytes = fromB64(res.data.ciphertext)
      const frame = parseFrame(bytes)
      if (frame) {
        await handleFrame(frame.type, frame.pubkey)
        return null // handled as handshake — not rendered as a message
      }
      const key = activeKey()
      return key ? tryDecrypt(key, bytes) : null
    } catch {
      return null
    }
  })

  console.info('[lortnoc] content script ready (Web K)')
}

void main()
