import { sw } from '../shared/messages'
import type { HealthData } from '../shared/messages'

// The popup is for what happens ON a page: write hidden, find hidden posts, always on here.
// Keys, spaces, sites and connection live in the full page (⚙ → src/home/).
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

async function health() {
  const h = $('health')
  const r = await sw<HealthData>({ type: 'HEALTH' })
  if (r.ok && r.data.ready && !r.data.paused) (h.textContent = 'ready'), (h.className = 'chip ok')
  else (h.textContent = r.ok && r.data.paused ? 'codec paused' : 'codec offline'), (h.className = 'chip warn')
}

async function act(popup: 'compose' | 'scan') {
  const r = await chrome.runtime.sendMessage({ popup })
  if (r?.ok) window.close()
  else $('status').textContent = 'This page can’t be used (browser pages and the Web Store are off-limits).'
}

const openHome = (section = 'keys') => {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`src/home/index.html#${section}`) })
  window.close()
}
$('compose').onclick = () => void act('compose')
$('scan').onclick = () => void act('scan')
$('settings').onclick = () => openHome('keys')
$('keys').onclick = (e) => (e.preventDefault(), openHome('keys'))
chrome.commands.getAll().then((cs) => {
  const k = cs.find((c) => c.name === 'compose')?.shortcut
  if (k) $('key').textContent = k
})
void health()

// One line: what this keyring can open — the details are one click away.
sw<{ passphrases: unknown[]; claims: { human: boolean; selfie: boolean; nationalities: string[]; wallets: string[] } | null }>({ type: 'KEYRING_VIEW' }).then((r) => {
  if (!r.ok) return
  const { passphrases, claims } = r.data
  const parts = [
    passphrases.length && `🔑 ${passphrases.length}`,
    (claims?.human || claims?.selfie) && '✓ World ID',
    claims?.nationalities?.length && `🛂 ${claims.nationalities.join(', ')}`,
    claims?.wallets?.length && `👛 ${claims.wallets.length}`,
  ].filter(Boolean)
  $('keySummary').textContent = parts.length ? `Your keys · ${parts.join(' · ')}` : 'Your keys · none yet — add some'
})

// "Always on for this site": Chrome asks for THIS origin only, from this click.
chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
  let origin = ''
  try {
    const u = new URL(tab?.url ?? '')
    if (u.protocol === 'https:' || u.protocol === 'http:') origin = u.origin
  } catch {}
  if (!origin) return
  $('siteName').textContent = new URL(origin).host
  $('siteRow').hidden = false
  const box = $<HTMLInputElement>('site')
  const st = await chrome.runtime.sendMessage({ type: 'SITE_STATE', origin })
  box.checked = !!st?.data?.on
  box.onchange = async () => {
    if (box.checked) {
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] })
      if (!granted) return void (box.checked = false)
    }
    const r = await chrome.runtime.sendMessage({ type: 'SITE_SET', origin, on: box.checked })
    box.checked = !!r?.data?.on
    $('status').textContent = box.checked ? 'On. Reload the page, then click a text box.' : 'Off for this site.'
  }
})
