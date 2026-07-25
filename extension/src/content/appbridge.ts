// App→extension bridge (runs ONLY on the app origin). The app posts the codec membership token
// after a paid claim; we store it so the Telegram content script sends it to the codec and gets
// unlimited use. One 0G membership unlocks the handle AND the codec — no second payment (§7/§8).
//
// Trust: this script is injected only on the app origin (manifest match), and we require the
// message to come from this same window. The token is a bearer capability the codec verifies;
// a bogus one simply fails verify_membership server-side, so a hostile page gains nothing.
import { LOCAL } from '../shared/config'

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return
  const d = e.data as { source?: string; type?: string; token?: unknown } | null
  if (!d || d.source !== 'lortnoc-app' || d.type !== 'MEMBERSHIP' || typeof d.token !== 'string') return
  const token = d.token
  void (async () => {
    const cur = (await chrome.storage.local.get(LOCAL.meter))[LOCAL.meter] as { sends?: number } | undefined
    await chrome.storage.local.set({
      [LOCAL.membership]: token,
      [LOCAL.meter]: { sends: cur?.sends ?? 0, paid: true },
    })
    console.info('[lortnoc] membership token received from app — codec unlocked')
    window.postMessage({ source: 'lortnoc-ext', type: 'MEMBERSHIP_OK' }, e.origin)
  })()
})
