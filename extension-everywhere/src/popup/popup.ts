import { sw, LOCAL, DEFAULT_CODEC_URL } from '../shared/messages'
import type { HealthData } from '../shared/messages'
import { createSpace, ownedSpaces, memberships, ensSpaces, addEnsSpace } from '../shared/spaces'

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

$('compose').onclick = () => void act('compose')
$('scan').onclick = () => void act('scan')
$('save').onclick = async () => {
  const v = $<HTMLInputElement>('codec').value.trim()
  await chrome.storage.local.set({ [LOCAL.codecUrl]: v || DEFAULT_CODEC_URL })
  void health()
}
chrome.storage.local.get(LOCAL.codecUrl).then((g) => ($<HTMLInputElement>('codec').value = (g[LOCAL.codecUrl] as string) || DEFAULT_CODEC_URL))
chrome.commands.getAll().then((cs) => {
  const k = cs.find((c) => c.name === 'compose')?.shortcut
  if (k) $('key').textContent = k
})
void health()

async function renderSpaces() {
  const [own, mem] = await Promise.all([ownedSpaces(), memberships()])
  const rows = [
    ...Object.keys(own).map((s) => `<div>👑 <b>${s}</b> <span class="muted">— you own it</span></div>`),
    ...Object.entries(mem).filter(([s, m]) => m.memberId && !own[s]).map(([s, m]) => `<div>✓ <b>${s}</b> <span class="muted">— ${m.memberId}</span></div>`),
  ]
  $('spaceList').innerHTML = rows.join('') || '<span class="muted">none yet</span>'
}
$('createSpace').onclick = async () => {
  const name = $<HTMLInputElement>('spaceName').value.trim().toLowerCase()
  if (!/^[a-z0-9-]{3,32}$/.test(name)) return void ($('status').textContent = 'Space names are 3–32 of a-z, 0-9 and -.')
  try {
    await createSpace(name)
    $<HTMLInputElement>('spaceName').value = ''
    $('status').textContent = `Created ${name}. Lock posts to "Members of a space" to use it.`
    void renderSpaces()
  } catch (e) {
    $('status').textContent = `Couldn’t create it: ${e instanceof Error ? e.message : e}`
  }
}
void renderSpaces()

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

async function renderEns() {
  const l = await ensSpaces()
  $('ensList').innerHTML = l.map((x) => `<div>◆ <b>${x}</b><span class="muted">.space.lortnoctahc.eth</span></div>`).join('') || '<span class="muted">none yet</span>'
}
$('addEns').onclick = async () => {
  try {
    await addEnsSpace($<HTMLInputElement>('ensName').value)
    $<HTMLInputElement>('ensName').value = ''
    void renderEns()
  } catch (e) {
    $('status').textContent = e instanceof Error ? e.message : String(e)
  }
}
void renderEns()

async function renderBuy() {
  const r = await chrome.runtime.sendMessage({ type: 'BUY_STATE' })
  const st = r?.data
  $('buyState').textContent = st ? `${st.label}: ${st.step}${st.error ? ` — ${st.error}` : ''}${st.name ? ` → ${st.name}` : ''}` : ''
}
$('buy').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || !/^https?:/.test(tab.url ?? '')) return void ($('buyState').textContent = 'Open any web page (where your wallet works) first.')
  const label = $<HTMLInputElement>('buyName').value.trim().toLowerCase()
  const token = $<HTMLInputElement>('buyToken').value.trim()
  const chainId = Number($<HTMLSelectElement>('buyChain').value) as 1 | 11155111
  $('buyState').textContent = 'Check your wallet…'
  // runs in the service worker — it keeps going when this popup closes for the wallet
  const r = await chrome.runtime.sendMessage({ type: 'BUY_SPACE', label, token, chainId, tabId: tab.id }).catch(() => null)
  if (r && !r.ok && /taken|bad space name/.test(r.error ?? '')) $('buyState').textContent = r.error
}
void renderBuy()
setInterval(() => void renderBuy(), 3000)
