// Content-script entry: wires compose interception and inbound decoding to the codec
// (via the service worker) and the in-page crypto. Plaintext + key never leave here.
import { detectClient, selectorsFor, activeCompose } from './selectors'
import { injectStyles } from './ui'
import { initState, get, ready } from './state'
import { installSendInterceptor } from './compose'
import { startInbound } from './inbound'
import { encrypt, tryDecrypt, toB64, fromB64 } from './crypto'
import { sendToCodec } from '../shared/messages'
import type { EncodeData, DecodeData } from '../shared/messages'

async function main(): Promise<void> {
  injectStyles()
  await initState(() => {
    const s = get()
    console.debug('[lortnoc] state changed — enabled=%s hasKey=%s ready=%s', s.enabled, s.key !== null, ready())
  })

  const client = detectClient()
  console.info('[lortnoc] loaded on', location.pathname, '→ client:', client)
  if (client !== 'k') {
    console.warn(
      '[lortnoc] Unsupported Telegram Web client at',
      location.pathname,
      '— switch to the K version (web.telegram.org/k/). Popup status still works.',
    )
    return
  }

  const sel = selectorsFor(client)!
  const composeFound = !!activeCompose(sel)
  const s0 = get()
  console.info(
    '[lortnoc] compose found=%s · enabled=%s · hasKey=%s · ready=%s (set passphrase + toggle Stego on)',
    composeFound,
    s0.enabled,
    s0.key !== null,
    ready(),
  )

  // Outbound: real text → AES-SIV → /encode → cover text (or null to fail-closed).
  installSendInterceptor(client, ready, async (real) => {
    const s = get()
    if (!s.key) return null
    try {
      const ciphertextB64 = toB64(encrypt(s.key, real))
      const res = await sendToCodec<EncodeData>({ type: 'ENCODE', ciphertextB64 })
      if (!res.ok) {
        console.warn('[lortnoc] encode failed:', res.error)
        return null
      }
      return res.data.coverText
    } catch (e) {
      console.warn('[lortnoc] encrypt error:', e)
      return null
    }
  })

  // Inbound: cover text → /decode → AES-SIV verify → decoded (or null if not ours).
  startInbound(client, ready, async (cover) => {
    const s = get()
    if (!s.key) return null
    try {
      const res = await sendToCodec<DecodeData>({ type: 'DECODE', coverText: cover })
      if (!res.ok) return null
      return tryDecrypt(s.key, fromB64(res.data.ciphertext))
    } catch {
      return null
    }
  })

  console.info('[lortnoc] content script ready (Web K)')
}

void main()
