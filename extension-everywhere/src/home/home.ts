// The full-page view (the popup's ⚙): keys, spaces, sites, connection. The popup keeps only what is
// used on a page — write hidden, find hidden posts, always on for this site.
import { sw, LOCAL, DEFAULT_CODEC_URL, DEFAULT_GATE_URL } from '../shared/messages'
import type { HealthData, GateHealth } from '../shared/messages'
import { createSpace, ownedSpaces, memberships, ensSpaces, addEnsSpace, ensKeys } from '../shared/spaces'
import { COUNTRIES } from '../shared/countries'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (t: string) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const say = (id: string, text: string, kind: '' | 'ok' | 'err' = '') => Object.assign($(id), { textContent: text, className: `msg ${kind}` })
const countryName = (a: string) => COUNTRIES.find(([c]) => c === a)?.[1] ?? a
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

// ---------------------------------------------------------------------------
// navigation (#keys, #spaces, … so the popup can link straight to a section)
// ---------------------------------------------------------------------------
function go(v: string) {
  const sec = document.getElementById(`v-${v}`) ?? $('v-keys')
  document.querySelectorAll('section.view').forEach((s) => s.classList.toggle('on', s === sec))
  document.querySelectorAll<HTMLElement>('.navlink').forEach((n) => n.classList.toggle('on', `v-${n.dataset.v}` === sec.id))
  $('title').textContent = sec.dataset.title ?? ''
  $('lede').textContent = sec.dataset.lede ?? ''
  history.replaceState(null, '', `#${sec.id.slice(2)}`)
}
document.querySelectorAll<HTMLElement>('.navlink').forEach((n) => (n.onclick = () => go(n.dataset.v!)))
go(location.hash.slice(1) || 'keys')
addEventListener('hashchange', () => go(location.hash.slice(1) || 'keys'))

// ---------------------------------------------------------------------------
// status pills + connection
// ---------------------------------------------------------------------------
let gateUrl = DEFAULT_GATE_URL
async function status() {
  const [c, g, st] = await Promise.all([sw<HealthData>({ type: 'HEALTH' }), sw<GateHealth>({ type: 'GATE_HEALTH' }), chrome.storage.local.get([LOCAL.codecUrl, LOCAL.gateUrl])])
  gateUrl = ((st[LOCAL.gateUrl] as string) || DEFAULT_GATE_URL).replace(/\/+$/, '')
  if (!$<HTMLInputElement>('codec').value) $<HTMLInputElement>('codec').value = (st[LOCAL.codecUrl] as string) || DEFAULT_CODEC_URL
  if (!$<HTMLInputElement>('gate').value) $<HTMLInputElement>('gate').value = gateUrl
  const cOk = c.ok && c.data.ready && !c.data.paused
  $('dCodec').className = `dot ${cOk ? 'ok' : 'bad'}`
  $('codecState').innerHTML = cOk ? `<span class="state ok">● ready · ${esc(c.data.model)}</span>` : '<span class="state" style="color:var(--bad)">● unreachable</span>'
  $('dGate').className = `dot ${g.ok ? 'ok' : 'bad'}`
  $('gateState').innerHTML = g.ok ? `<span class="state ok">● running · ${esc(g.data.checks.join(', '))}</span>` : '<span class="state" style="color:var(--bad)">● not running</span>'
  const env = g.ok ? g.data.world?.env : null
  $('dWorld').className = `dot ${env ? 'ok' : 'warn'}`
  $('tWorld').textContent = env ? `World ID · ${env}` : 'World ID · off'
  $('simRow').hidden = !(g.ok && g.data.world?.envs?.includes('staging'))
}
$('saveCodec').onclick = async () => {
  await chrome.storage.local.set({ [LOCAL.codecUrl]: $<HTMLInputElement>('codec').value.trim() || DEFAULT_CODEC_URL })
  say('connMsg', 'Saved.', 'ok'), void status()
}
$('saveGate').onclick = async () => {
  await chrome.storage.local.set({ [LOCAL.gateUrl]: $<HTMLInputElement>('gate').value.trim() || DEFAULT_GATE_URL })
  say('connMsg', 'Saved.', 'ok'), void status()
}

// ---------------------------------------------------------------------------
// your keys
// ---------------------------------------------------------------------------
type View = { passphrases: { id: string; label: string }[]; claims: { human: boolean; selfie: boolean; nationalities: string[]; wallets: string[] } | null }
async function renderKeys() {
  const r = await sw<View>({ type: 'KEYRING_VIEW' })
  if (!r.ok) return
  const { passphrases, claims } = r.data
  $('passList').innerHTML = passphrases.map((p) => `<div class="item"><span>🔑 ${esc(p.label)}</span><button class="x" data-id="${p.id}" title="Remove">×</button></div>`).join('') || '<div class="empty">None yet.</div>'
  $('passState').textContent = passphrases.length ? `${passphrases.length} added` : ''
  $('passList').querySelectorAll<HTMLButtonElement>('button.x').forEach((b) => (b.onclick = async () => (await sw({ type: 'KEYRING_REMOVE_PASS', id: b.dataset.id! }), renderKeys())))
  const w = [claims?.human && 'Verified human', claims?.selfie && 'Selfie Check', ...(claims?.nationalities ?? []).map((n) => `${countryName(n)} passport`)].filter(Boolean) as string[]
  $('worldState').innerHTML = w.length ? `<span class="state ok">✓ ${esc(w.join(' · '))}</span>` : '<span class="state muted">not connected</span>'
  const wallets = claims?.wallets ?? []
  $('walletList').innerHTML = wallets.map((a) => `<div class="item"><span>👛 ${short(a)}</span><span class="meta">connected</span></div>`).join('') || '<div class="empty">None yet.</div>'
  $('walletState').innerHTML = wallets.length ? `<span class="state ok">✓ ${wallets.length}</span>` : '<span class="state muted">none</span>'
  // a connection that failed while this page was in the background
  const last = (await chrome.storage.local.get('keyringLastError')).keyringLastError as { at: number; error: string } | null
  if (last && Date.now() - last.at < 15 * 60_000 && !$('worldMsg').textContent) say('worldMsg', `Last try: ${last.error}`, 'err')
}
$<HTMLSelectElement>('natSel').innerHTML = '<option value="">Choose the nationality on your passport…</option>' + COUNTRIES.map(([a, n]) => `<option value="${a}">${n}</option>`).join('')
$('addPass').onclick = async () => {
  const i = $<HTMLInputElement>('passIn')
  if (!i.value.trim()) return
  say('passMsg', 'Adding…')
  const r = await sw({ type: 'KEYRING_ADD_PASS', passphrase: i.value })
  i.value = ''
  r.ok ? say('passMsg', 'Added. Posts it opens will appear next time a page is checked.', 'ok') : say('passMsg', r.error, 'err')
  void renderKeys()
}
$<HTMLInputElement>('passIn').addEventListener('keydown', (e) => e.key === 'Enter' && $('addPass').click())
// World ID opens World's own widget in a tab; the service worker finishes it and this page refreshes.
async function connect(kind: 'poh' | 'selfie' | 'nationality', country?: string, simulate = false) {
  say('worldMsg', "World's widget opens in a new tab — come back here when it's done.")
  const r = await sw({ type: 'WORLD_CONNECT', kind, country, simulate })
  r.ok ? say('worldMsg', 'Connected.', 'ok') : say('worldMsg', r.error, 'err')
  void renderKeys()
}
$('wHuman').onclick = () => void connect('poh')
$('wSelfie').onclick = () => void connect('selfie')
$('wSim').onclick = (e) => (e.preventDefault(), void connect('poh', undefined, true))
$('wNat').onclick = () => {
  const c = $<HTMLSelectElement>('natSel').value
  if (!c) return void say('worldMsg', 'Choose the nationality on your passport first.', 'err')
  void connect('nationality', c)
}

/**
 * Wallets inject into web pages, never into extension pages. So wallet actions open the gate's small
 * /wallet page, run there, and close it again. The permission request must be the FIRST await after
 * the click (Chrome only allows it inside the user's gesture).
 */
async function withWalletTab<T>(run: (tabId: number) => Promise<T>): Promise<T> {
  const origin = new URL(gateUrl).origin
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] })
  if (!granted) throw new Error('The extension needs to open the wallet page on your gate.')
  const me = await chrome.tabs.getCurrent()
  const tab = await chrome.tabs.create({ url: `${gateUrl}/wallet`, active: true })
  await new Promise<void>((resolve) => {
    const on = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tab.id && info.status === 'complete') (chrome.tabs.onUpdated.removeListener(on), resolve())
    }
    chrome.tabs.onUpdated.addListener(on)
  })
  await new Promise((r) => setTimeout(r, 600)) // let the wallet inject window.ethereum
  try {
    return await run(tab.id!)
  } finally {
    await chrome.tabs.remove(tab.id!).catch(() => {})
    if (me?.id) await chrome.tabs.update(me.id, { active: true }).catch(() => {})
  }
}
$('wallet').onclick = async () => {
  say('walletMsg', 'Sign the message in your wallet — it costs nothing and moves nothing.')
  try {
    const r = await withWalletTab((tabId) => sw({ type: 'WALLET_CONNECT', tabId }))
    r.ok ? say('walletMsg', 'Wallet connected.', 'ok') : say('walletMsg', r.error, 'err')
  } catch (e) {
    say('walletMsg', e instanceof Error ? e.message : String(e), 'err')
  }
  void renderKeys()
}
$('forget').onclick = async (e) => {
  e.preventDefault()
  await sw({ type: 'KEYRING_FORGET' })
  void renderKeys()
}

// ---------------------------------------------------------------------------
// spaces
// ---------------------------------------------------------------------------
async function renderSpaces() {
  const [own, mem, ens, keys] = await Promise.all([ownedSpaces(), memberships(), ensSpaces(), ensKeys()])
  const rows = [
    ...Object.keys(own).map((s) => `<div class="item"><span>👑 <b>${esc(s)}</b></span><span class="meta">you own it · free</span></div>`),
    ...ens.map((l) => `<div class="item"><span>${keys[l] ? '👑' : '◆'} <b>${esc(l)}</b><span class="meta">.space.lortnoctahc.eth</span></span><span class="meta">${keys[l] ? `you ${keys[l].role === 'owner' ? 'own' : 'moderate'} it` : 'following'}${mem[`@${l}`]?.memberId ? ` · ${mem[`@${l}`].memberId}` : ''}</span></div>`),
    ...Object.entries(mem).filter(([s, m]) => m.memberId && !own[s] && !(s.startsWith('@') && ens.includes(s.slice(1))))
      .map(([s, m]) => `<div class="item"><span>✓ <b>${esc(s.replace(/^@/, ''))}</b>${s.startsWith('@') ? '<span class="meta">.space.lortnoctahc.eth</span>' : ''}</span><span class="meta">member · ${esc(m.memberId!)}</span></div>`),
  ]
  $('spaceList').innerHTML = rows.join('') || '<div class="empty">None yet — create one, follow one, or buy one below.</div>'
}
$('createSpace').onclick = async () => {
  const name = $<HTMLInputElement>('spaceName').value.trim().toLowerCase()
  if (!/^[a-z0-9-]{3,32}$/.test(name)) return void say('spaceMsg', 'Space names are 3–32 of a-z, 0-9 and -.', 'err')
  try {
    await createSpace(name)
    $<HTMLInputElement>('spaceName').value = ''
    say('spaceMsg', `Created ${name}. Lock posts to "Members of ${name}" to use it.`, 'ok')
    void renderSpaces()
  } catch (e) {
    say('spaceMsg', `Couldn't create it: ${e instanceof Error ? e.message : e}`, 'err')
  }
}
$('addEns').onclick = async () => {
  try {
    await addEnsSpace($<HTMLInputElement>('ensName').value)
    $<HTMLInputElement>('ensName').value = ''
    say('ensMsg', 'Added.', 'ok')
    void renderSpaces()
  } catch (e) {
    say('ensMsg', e instanceof Error ? e.message : String(e), 'err')
  }
}
$('useDemoPass').onclick = (e) => {
  e.preventDefault()
  $<HTMLSelectElement>('nftChain').value = '11155111'
  $<HTMLInputElement>('nftAddress').value = '0xc85460a6690f8b06fdafd1b7730bdfa6261243f0'
}
async function renderBuy() {
  const r = await chrome.runtime.sendMessage({ type: 'BUY_STATE' })
  const st = r?.data
  if (st) say('buyState', `${st.label}: ${st.step}${st.error ? ` — ${st.error}` : ''}${st.name ? ` → ${st.name}` : ''}`, st.step === 'failed' ? 'err' : st.step === 'done' ? 'ok' : '')
}
$('buy').onclick = async () => {
  const label = $<HTMLInputElement>('buyName').value.trim().toLowerCase()
  const address = $<HTMLInputElement>('nftAddress').value.trim()
  if (!/^[a-z0-9-]{3,32}$/.test(label)) return void say('buyState', 'Names are 3–32 of a-z, 0-9 and -.', 'err')
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return void say('buyState', 'Enter the NFT contract address (0x + 40 hex characters).', 'err')
  const token = `eip155:${$<HTMLSelectElement>('nftChain').value}/erc721:${address.toLowerCase()}`
  const chainId = Number($<HTMLSelectElement>('buyChain').value) as 1 | 11155111
  say('buyState', 'Confirm the payment in your wallet…')
  try {
    // the service worker keeps going (relayer, ENS) after the wallet tab closes
    const r = await withWalletTab((tabId) => chrome.runtime.sendMessage({ type: 'BUY_SPACE', label, token, chainId, tabId }).catch(() => null))
    if (r && !r.ok) say('buyState', r.error, 'err')
  } catch (e) {
    say('buyState', e instanceof Error ? e.message : String(e), 'err')
  }
  void renderBuy(), void renderSpaces()
}

// ---------------------------------------------------------------------------
// sites
// ---------------------------------------------------------------------------
async function renderSites() {
  const r = await sw<string[]>({ type: 'SITE_LIST' })
  const sites = r.ok ? r.data : []
  $('siteList').innerHTML = sites.map((o) => `<div class="item"><span>◎ ${esc(new URL(o).host)}</span><button class="x" data-o="${esc(o)}" title="Turn off">×</button></div>`).join('')
    || '<div class="empty">None yet. On a site, open the extension and switch on “Always on”.</div>'
  $('siteList').querySelectorAll<HTMLButtonElement>('button.x').forEach((b) => (b.onclick = async () => (await sw({ type: 'SITE_SET', origin: b.dataset.o!, on: false }), renderSites())))
}

void status(), void renderKeys(), void renderSpaces(), void renderSites(), void renderBuy()
setInterval(() => void renderBuy(), 3000)
setInterval(() => void status(), 10_000)
// the keyring changes from other places too (a World ID tab, the popup) — stay current
chrome.storage.onChanged.addListener((c) => {
  if (c.keyring || c.keyringLastError) void renderKeys()
  if (c.spaceMemberships || c.spaceOwnerKeys || c.ensSpaces || c.ensSpaceKeys) void renderSpaces()
})
