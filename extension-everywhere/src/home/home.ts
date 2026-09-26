// The full page (the popup's ⚙): Keys, Spaces, Settings. The popup keeps only what is used on a
// page — write hidden, find hidden posts, always on for this site.
import { sw, LOCAL, DEFAULT_CODEC_URL, DEFAULT_GATE_URL } from '../shared/messages'
import type { HealthData, GateHealth } from '../shared/messages'
import { createSpace, ownedSpaces, memberships, ensSpaces, addEnsSpace, ensKeys } from '../shared/spaces'
import { COUNTRIES } from '../shared/countries'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (t: string) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const say = (id: string, text: string, kind: '' | 'ok' | 'err' = '') => Object.assign($(id), { textContent: text, className: `msg ${kind}` })
const countryName = (a: string) => COUNTRIES.find(([c]) => c === a)?.[1] ?? a
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const debounce = <A extends unknown[]>(fn: (...a: A) => void, ms: number) => {
  let t: ReturnType<typeof setTimeout> | undefined
  return (...a: A) => (clearTimeout(t), (t = setTimeout(() => fn(...a), ms)))
}

// ---------------------------------------------------------------------------
// navigation — #keys, #spaces, #settings (older links: #sites/#connection → settings)
// ---------------------------------------------------------------------------
const ALIAS: Record<string, string> = { sites: 'settings', connection: 'settings', about: 'keys' }
function go(v: string) {
  v = ALIAS[v] ?? v
  const sec = document.getElementById(`v-${v}`) ?? $('v-keys')
  document.querySelectorAll('section.view').forEach((s) => s.classList.toggle('on', s === sec))
  document.querySelectorAll<HTMLElement>('.navlink').forEach((n) => n.classList.toggle('on', `v-${n.dataset.v}` === sec.id))
  history.replaceState(null, '', `#${sec.id.slice(2)}`)
  scrollTo(0, 0)
}
document.querySelectorAll<HTMLElement>('.navlink').forEach((n) => (n.onclick = () => go(n.dataset.v!)))
go(location.hash.slice(1) || 'keys')
addEventListener('hashchange', () => go(location.hash.slice(1) || 'keys'))

// ---------------------------------------------------------------------------
// status (sidebar dots + settings)
// ---------------------------------------------------------------------------
let gateUrl = DEFAULT_GATE_URL
async function status() {
  const [c, g, st] = await Promise.all([sw<HealthData>({ type: 'HEALTH' }), sw<GateHealth>({ type: 'GATE_HEALTH' }), chrome.storage.local.get([LOCAL.codecUrl, LOCAL.gateUrl])])
  gateUrl = ((st[LOCAL.gateUrl] as string) || DEFAULT_GATE_URL).replace(/\/+$/, '')
  if (!$<HTMLInputElement>('codec').value) $<HTMLInputElement>('codec').value = (st[LOCAL.codecUrl] as string) || DEFAULT_CODEC_URL
  if (!$<HTMLInputElement>('gate').value) $<HTMLInputElement>('gate').value = gateUrl
  const cOk = c.ok && c.data.ready && !c.data.paused
  for (const id of ['dCodec', 'dCodec2']) $(id).className = `dot ${cOk ? 'ok' : 'bad'}`
  for (const id of ['dGate', 'dGate2']) $(id).className = `dot ${g.ok ? 'ok' : 'bad'}`
  $('codecState').textContent = cOk ? `Codec · ready` : 'Codec · unreachable'
  $('gateState').textContent = g.ok ? 'Gate · running' : 'Gate · not running'
  const env = g.ok ? g.data.world?.env : null
  $('dWorld').className = `dot ${env ? 'ok' : 'warn'}`
  $('tWorld').textContent = env ? `World ID · ${env}` : 'World ID · off'
  $('wSim').hidden = !(g.ok && g.data.world?.envs?.includes('staging'))
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
// keys
// ---------------------------------------------------------------------------
type View = { passphrases: { id: string; label: string }[]; claims: { human: boolean; selfie: boolean; nationalities: string[]; wallets: string[] } | null }
const none = (t: string) => `<span class="badge off">${t}</span>`
async function renderKeys() {
  const r = await sw<View>({ type: 'KEYRING_VIEW' })
  if (!r.ok) return
  const { passphrases, claims } = r.data
  $('passList').innerHTML = passphrases.map((p) => `<span class="badge">${esc(p.label)}<button data-id="${p.id}" title="Remove">×</button></span>`).join('') || none('None yet')
  $('passList').querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = async () => (await sw({ type: 'KEYRING_REMOVE_PASS', id: b.dataset.id! }), renderKeys())))
  const w = [claims?.human && 'Verified human', claims?.selfie && 'Selfie', ...(claims?.nationalities ?? []).map((n) => `${countryName(n)} passport`)].filter(Boolean) as string[]
  $('worldBadges').innerHTML = w.map((x) => `<span class="badge">✓ ${esc(x)}</span>`).join('') || none('Not connected')
  const wallets = claims?.wallets ?? []
  $('walletList').innerHTML = wallets.map((a) => `<span class="badge">✓ ${short(a)}</span>`).join('') || none('None yet')
  $('forget').hidden = !w.length && !wallets.length
  const last = (await chrome.storage.local.get('keyringLastError')).keyringLastError as { at: number; error: string } | null
  if (last && Date.now() - last.at < 15 * 60_000 && !$('worldMsg').textContent) say('worldMsg', last.error, 'err')
}
$<HTMLSelectElement>('natSel').innerHTML = '<option value="">Nationality…</option>' + COUNTRIES.map(([a, n]) => `<option value="${a}">${n}</option>`).join('')
$('addPass').onclick = async () => {
  const i = $<HTMLInputElement>('passIn')
  if (!i.value.trim()) return
  const r = await sw({ type: 'KEYRING_ADD_PASS', passphrase: i.value })
  i.value = ''
  r.ok ? say('passMsg', 'Added.', 'ok') : say('passMsg', r.error, 'err')
  void renderKeys()
}
$<HTMLInputElement>('passIn').addEventListener('keydown', (e) => e.key === 'Enter' && $('addPass').click())
async function connect(kind: 'poh' | 'selfie' | 'nationality', country?: string, simulate = false) {
  say('worldMsg', 'Continue in the World ID tab…')
  const r = await sw({ type: 'WORLD_CONNECT', kind, country, simulate })
  r.ok ? say('worldMsg', 'Connected.', 'ok') : say('worldMsg', r.error, 'err')
  void renderKeys()
}
$('wHuman').onclick = () => void connect('poh')
$('wSelfie').onclick = () => void connect('selfie')
$('wSim').onclick = (e) => (e.preventDefault(), void connect('poh', undefined, true))
$('wNat').onclick = () => {
  const c = $<HTMLSelectElement>('natSel').value
  if (!c) return void say('worldMsg', 'Pick a nationality first.', 'err')
  void connect('nationality', c)
}

/**
 * Wallets inject into web pages, never into extension pages — so wallet actions open the gate's
 * small /wallet page, run there, and close it. The permission request must be the FIRST await
 * after the click (Chrome only allows it inside the user's gesture).
 */
async function withWalletTab<T>(run: (tabId: number) => Promise<T>): Promise<T> {
  const granted = await chrome.permissions.request({ origins: [`${new URL(gateUrl).origin}/*`] })
  if (!granted) throw new Error('Allow the wallet page to continue.')
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
  say('walletMsg', 'Sign in your wallet — free, nothing moves.')
  try {
    const r = await withWalletTab((tabId) => sw({ type: 'WALLET_CONNECT', tabId }))
    r.ok ? say('walletMsg', 'Connected.', 'ok') : say('walletMsg', r.error, 'err')
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
// spaces — the product: name → collection → create
// ---------------------------------------------------------------------------
const DEMO_PASS = '0xc85460a6690f8b06fdafd1b7730bdfa6261243f0'
const CHAIN_NAME: Record<string, string> = { '1': 'Ethereum', '8453': 'Base', '11155111': 'Sepolia', '84532': 'Base Sepolia' }
const ok = { name: false, col: false }
let payOn: 1 | 11155111 = 11155111
const label = () => $<HTMLInputElement>('buyName').value.trim().toLowerCase()
const token = () => `eip155:${$<HTMLSelectElement>('nftChain').value}/erc721:${$<HTMLInputElement>('nftAddress').value.trim().toLowerCase()}`
function mark(id: 's1' | 's2', done: boolean) {
  $(id).classList.toggle('done', done)
  const l = label()
  $<HTMLButtonElement>('buy').disabled = !(ok.name && ok.col)
  $('buy').textContent = ok.name ? `Create ${l}.space · 0.005 ETH` : 'Create space · 0.005 ETH'
}
const check = (id: string, text: string, kind: 'ok' | 'bad' | '' = '') => Object.assign($(id), { textContent: text, className: `check ${kind}` })

const checkName = debounce(async () => {
  const l = label()
  $('ncName').innerHTML = `${esc(l || 'yourspace')}<span>.space.lortnoctahc.eth</span>`
  $('ncMark').textContent = (l[0] ?? '◆').toUpperCase()
  ok.name = false
  mark('s1', false)
  if (!l) return void check('nameCheck', '')
  check('nameCheck', 'Checking…')
  const r = await sw<{ valid: boolean; available?: boolean }>({ type: 'SPACE_AVAILABLE', label: l })
  if (l !== label()) return // typed on meanwhile
  if (!r.ok) return void check('nameCheck', 'Could not check — try again.', 'bad')
  if (!r.data.valid) return void check('nameCheck', '3–32 letters, numbers or -', 'bad')
  ok.name = !!r.data.available
  check('nameCheck', ok.name ? `✓ ${l}.space.lortnoctahc.eth is available` : '✗ Taken — try another name', ok.name ? 'ok' : 'bad')
  mark('s1', ok.name)
}, 400)
$('buyName').addEventListener('input', () => void checkName())

const checkCol = debounce(async () => {
  const addr = $<HTMLInputElement>('nftAddress').value.trim()
  const chain = CHAIN_NAME[$<HTMLSelectElement>('nftChain').value]
  ok.col = false
  mark('s2', false)
  $('ncCol').textContent = addr ? `holders of ${short(addr)}` : 'holders of your collection'
  if (!addr) return void check('colCheck', '')
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return void check('colCheck', 'A contract address is 0x + 40 characters', 'bad')
  check('colCheck', 'Checking the contract…')
  const r = await sw({ type: 'COLLECTION_CHECK', token: token() })
  ok.col = r.ok
  check('colCheck', r.ok ? `✓ NFT collection on ${chain}` : r.error, r.ok ? 'ok' : 'bad')
  mark('s2', ok.col)
}, 500)
$('nftAddress').addEventListener('input', () => void checkCol())
$('nftChain').addEventListener('change', () => void checkCol())
$('useDemoPass').onclick = (e) => {
  e.preventDefault()
  $<HTMLSelectElement>('nftChain').value = '11155111'
  $<HTMLInputElement>('nftAddress').value = DEMO_PASS
  void checkCol()
}
document.querySelectorAll<HTMLButtonElement>('#net button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('#net button').forEach((x) => x.classList.toggle('on', x === b))
  payOn = Number(b.dataset.c) as 1 | 11155111
}))

/** Payment → ENS name → Ready, from the service worker's purchase state. */
async function renderBuy() {
  const r = await chrome.runtime.sendMessage({ type: 'BUY_STATE' })
  const st = r?.data as { label: string; step: string; error?: string; name?: string } | null
  const cells = [...$('track').children] as HTMLElement[]
  const stage = !st ? -1 : st.step === 'done' ? 3 : st.step.startsWith('paid') ? 1 : st.step === 'failed' ? -2 : 0
  cells.forEach((c, i) => (c.className = stage === 3 || i < stage ? 'done' : i === stage ? 'on' : ''))
  if (!st) return
  if (st.step === 'done') say('buyState', `✓ ${st.name} is yours. Lock posts to "NFT holders of ${st.label}.space".`, 'ok')
  else if (st.step === 'failed') say('buyState', `${st.label}: ${st.error ?? 'failed'}`, 'err')
  else say('buyState', `${st.label}: ${st.step}`)
}
$('buy').onclick = async () => {
  if (!(ok.name && ok.col)) return
  say('buyState', 'Confirm the payment in your wallet…')
  try {
    // the service worker carries on (relayer, ENS) after the wallet tab closes
    const r = await withWalletTab((tabId) => chrome.runtime.sendMessage({ type: 'BUY_SPACE', label: label(), token: token(), chainId: payOn, tabId }).catch(() => null))
    if (r && !r.ok) say('buyState', r.error, 'err')
  } catch (e) {
    say('buyState', e instanceof Error ? e.message : String(e), 'err')
  }
  void renderBuy(), void renderSpaces()
}

async function renderSpaces() {
  const [own, mem, ens, keys] = await Promise.all([ownedSpaces(), memberships(), ensSpaces(), ensKeys()])
  const card = (name: string, suffix: string, role: string, owner: boolean, extra = '') =>
    `<div class="sp"><div class="n"><b>${esc(name)}</b><span>${suffix}</span></div><div class="role ${owner ? '' : 'm'}">${role}</div>${extra}</div>`
  const cards = [
    ...ens.map((l) => card(l, '.space', keys[l] ? (keys[l].role === 'owner' ? 'Owner · NFT space' : 'Moderator') : mem[`@${l}`]?.memberId ? 'Member' : 'Added', !!keys[l],
      mem[`@${l}`]?.memberId ? `<div class="mono">${esc(mem[`@${l}`].memberId!)}</div>` : '')),
    ...Object.keys(own).map((s) => card(s, '', 'Owner · free space', true)),
    ...Object.entries(mem).filter(([s, m]) => m.memberId && !own[s] && !(s.startsWith('@') && ens.includes(s.slice(1))))
      .map(([s, m]) => card(s.replace(/^@/, ''), s.startsWith('@') ? '.space' : '', 'Member', false, `<div class="mono">${esc(m.memberId!)}</div>`)),
  ]
  $('spaceList').innerHTML = cards.join('') || '<div class="empty">No spaces yet. Create one above — or add one you were told about.</div>'
}
$('createSpace').onclick = async () => {
  const name = $<HTMLInputElement>('spaceName').value.trim().toLowerCase()
  if (!/^[a-z0-9-]{3,32}$/.test(name)) return void say('spaceMsg', '3–32 letters, numbers or -', 'err')
  try {
    await createSpace(name)
    $<HTMLInputElement>('spaceName').value = ''
    say('spaceMsg', `Created ${name}.`, 'ok')
    void renderSpaces()
  } catch (e) {
    say('spaceMsg', e instanceof Error ? e.message : String(e), 'err')
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

// ---------------------------------------------------------------------------
// settings — always-on sites
// ---------------------------------------------------------------------------
async function renderSites() {
  const r = await sw<string[]>({ type: 'SITE_LIST' })
  const sites = r.ok ? r.data : []
  $('siteList').innerHTML = sites.map((o) => `<div class="item"><span>${esc(new URL(o).host)}</span><button data-o="${esc(o)}" title="Turn off">×</button></div>`).join('')
    || '<div class="quiet">No sites yet.</div>'
  $('siteList').querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = async () => (await sw({ type: 'SITE_SET', origin: b.dataset.o!, on: false }), renderSites())))
}

void status(), void renderKeys(), void renderSpaces(), void renderSites(), void renderBuy()
setInterval(() => void renderBuy(), 3000)
setInterval(() => void status(), 10_000)
chrome.storage.onChanged.addListener((c) => {
  if (c.keyring || c.keyringLastError) void renderKeys()
  if (c.spaceMemberships || c.spaceOwnerKeys || c.ensSpaces || c.ensSpaceKeys) void renderSpaces()
})
