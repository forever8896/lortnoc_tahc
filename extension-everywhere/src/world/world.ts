// World's own IDKit widget (IDKitRequestWidget, @worldcoin/idkit) in an extension tab.
//
// Why a tab and not the reveal card: the widget is a full-screen modal that switches to its phone
// layout (a deep-link button, no QR) below 1024 px — and the reveal card is a small frame inside
// someone else's page. So the card asks the service worker to open this page with the gate's signed
// request, the widget talks to World App, and the proof goes BACK to the card, which hands it to the
// gate exactly as before. The widget's handleVerify waits for the gate's verdict, so World's own
// success / failure screen reflects whether the post actually opened.
//
// Nothing here reaches the site: this is an extension-origin page, like the card.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { IDKitRequestWidget, proofOfHuman, selfieCheck, identityCheck } from '@worldcoin/idkit'
import type { IDKitResult } from '@worldcoin/idkit'
import type { WorldRequest } from '../shared/messages'

// #<id>[&sim] — `sim`: a staging demo; the simulator answers this widget's request as soon as it has one
const [id, simFlag] = location.hash.slice(1).split('&')
const $ = (x: string) => document.getElementById(x)!
const say = (t: string) => ($('status').textContent = t)
const broadcast = (m: object) => chrome.runtime.sendMessage(m).catch(() => {})
let finished = false
const finish = (after = 0) => {
  if (finished) return
  finished = true
  setTimeout(() => void chrome.runtime.sendMessage({ type: 'WORLD_WIDGET_DONE', id }), after)
}

/** The gate's verdict for our proof, relayed by the reveal card. */
const verdict = () =>
  new Promise<{ ok: boolean; deny?: string }>((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, deny: 'the post did not answer in time' }), 120_000)
    chrome.runtime.onMessage.addListener(function on(m) {
      if (m?.type !== 'WORLD_WIDGET_VERDICT' || m.id !== id) return
      clearTimeout(t)
      chrome.runtime.onMessage.removeListener(on)
      resolve(m)
    })
  })

// Staging demo: the reveal card's "Use World ID simulator" lands here. The widget keeps its connect
// link in the page (the phone layout's "Open World ID App" link, hidden on desktop); the gate hands it
// to World's simulator, which then answers THIS widget's request exactly as World App would.
const widgetLink = () =>
  [...document.querySelectorAll('[data-idkit-shadow-host]')]
    .map((h) => h.shadowRoot?.querySelector<HTMLAnchorElement>('a.idkit-deeplink-btn')?.href)
    .find((href) => href?.includes('/verify?'))
async function simulate() {
  let link = widgetLink()
  for (let i = 0; !link && i < 60; i++) (await new Promise((r) => setTimeout(r, 250)), (link = widgetLink()))
  if (!link) return say('The World ID widget has no request yet — try again in a moment.')
  say('World ID simulator is answering…')
  const r = await chrome.runtime.sendMessage({ type: 'WORLD_SIM', connectUrl: link })
  if (!r?.ok) say(`Simulator: ${r?.error ?? 'failed'}`)
}
chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === 'WORLD_WIDGET_SIMULATE' && m.id === id) void simulate()
})

// While this tab is open the service worker may be waiting on it (connecting the keyring): a ping
// every 10 s keeps an idle MV3 worker from being stopped mid-verification.
setInterval(() => void chrome.runtime.sendMessage({ type: 'WORLD_WIDGET_PING', id }).catch(() => {}), 10_000)

async function main() {
  const key = `world:${id}`
  const q = (await chrome.storage.session.get(key))[key] as WorldRequest | undefined
  if (!q) return say('This verification has expired — go back to the post and press Verify again.')
  if (q.preset === 'identity') $('what').textContent = `World ID checks your passport's nationality is ${q.attributes?.[0]?.value} — nothing else is shared.`
  const preset = q.preset === 'identity' ? identityCheck({ attributes: q.attributes as never, legacy_signal: q.signal })
    : q.preset === 'selfie' ? selfieCheck({ signal: q.signal }) : proofOfHuman({ signal: q.signal })

  const render = (open: boolean) =>
    root.render(createElement(IDKitRequestWidget, {
      open,
      app_id: q.app_id as `app_${string}`,
      action: q.action,
      rp_context: q.rp_context,
      allow_legacy_proofs: false,
      environment: q.environment as 'production' | 'staging',
      preset,
      autoClose: true,
      onOpenChange: (o: boolean) => {
        if (o) return
        render(false)
        if (!finished) {
          void broadcast({ type: 'WORLD_WIDGET_CLOSED', id })
          say('Closed.')
          finish(300)
        }
      },
      // Runs after World App returns a proof: the card sends it to the gate; we wait for the answer
      // so World's widget shows success only if the post really opened.
      handleVerify: async (result: IDKitResult) => {
        say('Checking with the gate…')
        const v = verdict()
        await broadcast({ type: 'WORLD_WIDGET_RESULT', id, result })
        const r = await v
        if (!r.ok) {
          say(r.deny ?? 'The gate refused the proof.')
          throw new Error(r.deny ?? 'refused')
        }
      },
      onSuccess: () => {
        say('Verified — back to the post.')
        finish(1200)
      },
      onError: (code: unknown) => void say(`World ID: ${String(code).replace(/_/g, ' ')}`),
    }))
  const root = createRoot($('root'))
  render(true)
  if (simFlag === 'sim' && q.environment === 'staging') void simulate()
}
void main()
