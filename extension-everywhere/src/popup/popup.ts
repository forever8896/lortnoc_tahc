import { sw, LOCAL, DEFAULT_CODEC_URL } from '../shared/messages'
import type { HealthData } from '../shared/messages'
import { createSpace, ownedSpaces, memberships, ensSpaces, addEnsSpace } from '../shared/spaces'
import { COUNTRIES } from '../shared/countries'
import type { GateHealth } from '../shared/messages'

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
  const address = $<HTMLInputElement>('nftAddress').value.trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return void ($('buyState').textContent = 'Enter the NFT contract address (0x + 40 hex characters).')
  const token = `eip155:${$<HTMLSelectElement>('nftChain').value}/erc721:${address.toLowerCase()}`
  const chainId = Number($<HTMLSelectElement>('buyChain').value) as 1 | 11155111
  $('buyState').textContent = 'Check your wallet…'
  // runs in the service worker — it keeps going when this popup closes for the wallet
  const r = await chrome.runtime.sendMessage({ type: 'BUY_SPACE', label, token, chainId, tabId: tab.id }).catch(() => null)
  if (r && !r.ok && /taken|bad space name|collection|contract/i.test(r.error ?? '')) $('buyState').textContent = r.error
}
$('useDemoPass').onclick = (e) => {
  e.preventDefault()
  $<HTMLSelectElement>('nftChain').value = '11155111'
  $<HTMLInputElement>('nftAddress').value = '0xc85460a6690f8b06fdafd1b7730bdfa6261243f0'
}
void renderBuy()
setInterval(() => void renderBuy(), 3000)

// ---------------------------------------------------------------------------
// Your keys — the keyring (background/sealed.ts does the work; it survives this popup closing)
// ---------------------------------------------------------------------------
type View = { passphrases: { id: string; label: string }[]; claims: { human: boolean; selfie: boolean; nationalities: string[]; wallets: string[] } | null }
const countryName = (a: string) => COUNTRIES.find(([c]) => c === a)?.[1] ?? a
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')

async function renderKeys() {
  const r = await sw<View>({ type: 'KEYRING_VIEW' })
  if (!r.ok) return
  const { passphrases, claims } = r.data
  $('passList').innerHTML = passphrases.map((p) => `<span class="chip ok">🔑 ${esc(p.label)}<button data-id="${p.id}" title="Remove">×</button></span>`).join('')
  $('passCount').textContent = passphrases.length ? '' : 'none yet'
  $('passList').querySelectorAll('button').forEach((b) => (b.onclick = async () => (await sw({ type: 'KEYRING_REMOVE_PASS', id: b.dataset.id! }), renderKeys())))
  const w = [claims?.human && 'verified human', claims?.selfie && 'selfie', ...(claims?.nationalities ?? []).map((n) => `${countryName(n)} passport`)].filter(Boolean)
  $('worldState').innerHTML = w.length ? `<span class="ok">✓ ${w.join(' · ')}</span>` : '<span class="muted">not connected</span>'
  $('walletState').innerHTML = claims?.wallets?.length ? `<span class="ok">✓ ${claims.wallets.map((a) => a.slice(0, 6) + '…' + a.slice(-4)).join(', ')}</span>` : '<span class="muted">none</span>'
  $('forget').hidden = !w.length && !claims?.wallets?.length
  // a connection that failed while this popup was closed (World ID opens in a tab, which closes it)
  const last = (await chrome.storage.local.get('keyringLastError')).keyringLastError as { at: number; error: string } | null
  if (last && Date.now() - last.at < 15 * 60_000 && !$('status').textContent) $('status').innerHTML = `<span style="color:var(--warn)">Last try: ${esc(last.error)}</span>`
}
$<HTMLSelectElement>('natSel').innerHTML = '<option value="">Nationality (passport)…</option>' + COUNTRIES.map(([a, n]) => `<option value="${a}">${n}</option>`).join('')
$('addPass').onclick = async () => {
  const i = $<HTMLInputElement>('passIn')
  if (!i.value.trim()) return
  $('status').textContent = 'Adding…'
  const r = await sw({ type: 'KEYRING_ADD_PASS', passphrase: i.value })
  i.value = ''
  $('status').textContent = r.ok ? 'Added. Press Find hidden posts to look again.' : r.error
  void renderKeys()
}
$<HTMLInputElement>('passIn').addEventListener('keydown', (e) => e.key === 'Enter' && $('addPass').click())
// World ID opens World's widget in a tab — this popup closes then; the service worker finishes it.
const connect = (kind: 'poh' | 'selfie' | 'nationality', country?: string, simulate = false) => {
  $('status').textContent = 'World ID opens in a new tab…'
  void chrome.runtime.sendMessage({ type: 'WORLD_CONNECT', kind, country, simulate })
}
$('wHuman').onclick = () => connect('poh')
$('wSelfie').onclick = () => connect('selfie')
$('wSim').onclick = () => connect('poh', undefined, true)
$('wNat').onclick = () => {
  const c = $<HTMLSelectElement>('natSel').value
  if (!c) return void ($('status').textContent = 'Choose the nationality on your passport first.')
  connect('nationality', c)
}
$('wallet').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || !/^https?:/.test(tab.url ?? '')) return void ($('status').textContent = 'Open any web page where your wallet works, then try again.')
  $('status').textContent = 'Sign the message in your wallet — it costs nothing and moves nothing.'
  const r = await sw({ type: 'WALLET_CONNECT', tabId: tab.id })
  $('status').textContent = r.ok ? 'Wallet connected. Press Find hidden posts to look again.' : r.error
  void renderKeys()
}
$('forget').onclick = async (e) => {
  e.preventDefault()
  await sw({ type: 'KEYRING_FORGET' })
  void renderKeys()
}
sw<GateHealth>({ type: 'GATE_HEALTH' }).then((g) => ($('wSim').hidden = !(g.ok && g.data.world?.envs?.includes('staging'))))
void renderKeys()
