// The reveal card — an extension-origin iframe. The page hands it COVER text (public); the message
// it recovers is rendered only here, never written into the page's DOM where the site's scripts
// could read it.
import { canonicalCover, inspect, openMessage } from '../../../shared/webframe.mjs'
import { fromB64 } from '../../../shared/keys.mjs'
import { sw } from '../shared/messages'
import type { DecodeData, FrameToContent } from '../shared/messages'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const toParent = (m: FrameToContent) => parent.postMessage(m, '*')

function setStatus(text: string, kind: '' | 'ok' | 'err' = '') {
  const s = $('status')
  s.textContent = text
  s.className = `status ${kind}`
}
function fit() {
  toParent({ lortnoc: 'resize', height: document.body.scrollHeight + 2 })
}

/** Passphrases typed in this card, in memory only — gone when the card closes. */
const tried: string[] = []
let frame: Uint8Array | null = null

function show(text: string, obfuscationOnly: boolean) {
  $('needs').hidden = true
  $('out').hidden = false
  $('plain').textContent = text
  $('note').textContent = obfuscationOnly
    ? 'Anyone with the extension can read this one — it was hidden, not locked.'
    : 'Only readers who meet the author’s checks can see this.'
  setStatus('')
  fit()
}

async function attempt() {
  if (!frame) return
  const info = inspect(frame)!
  const text = await openMessage(frame, { passphrases: tried })
  if (text !== null) return show(text, !!(info.honesty as { obfuscationOnly?: boolean } | undefined)?.obfuscationOnly)
  if (tried.length) setStatus('That didn’t open it.', 'err')
  fit()
}

async function main() {
  const hash = location.hash
  if (hash === '#none') return setStatus('No tagged posts found on this page. Select a post and right-click → Reveal.'), fit()
  const raw = hash.startsWith('#t=') ? decodeURIComponent(hash.slice(3)) : ''
  const cover = canonicalCover(raw)
  if (!cover) return setStatus('Nothing to reveal here.', 'err'), fit()

  const r = await sw<DecodeData>({ type: 'DECODE', coverText: cover })
  if (!r.ok) {
    return setStatus(
      r.error === 'not-cover'
        ? 'This isn’t a lortnoc message — or the site changed it.'
        : `Couldn’t reach the codec: ${r.error}`,
      'err',
    ), fit()
  }
  frame = fromB64(r.data.ciphertext)
  const info = inspect(frame)
  if (!info) return setStatus('This is a lortnoc message from another surface (X or Telegram) — open it there.', 'err'), fit()
  if (info.unsupported) return setStatus('This message needs a newer version of the extension.', 'err'), fit()

  const checks = $('checks')
  for (const c of info.checks ?? []) checks.append(Object.assign(document.createElement('span'), { className: 'chip', textContent: c }))
  $('needs').hidden = false
  $('pass').hidden = !info.needs?.includes('passphrase')
  $('identity').hidden = !info.needs?.includes('recipients')
  setStatus('')
  await attempt() // a public post, or a passphrase already typed in this card, opens straight away
  if ($('out').hidden && !$('pass').hidden) $<HTMLInputElement>('pw').focus()
}

async function tryPassphrase() {
  const pw = $<HTMLInputElement>('pw')
  if (!pw.value.trim()) return
  tried.push(pw.value)
  pw.value = ''
  setStatus('Checking…')
  await attempt()
}

$('try').onclick = () => void tryPassphrase()
$<HTMLInputElement>('pw').addEventListener('keydown', (e) => e.key === 'Enter' && void tryPassphrase())
$('close').onclick = () => toParent({ lortnoc: 'close' })
document.addEventListener('keydown', (e) => e.key === 'Escape' && toParent({ lortnoc: 'close' }))
void main()
