// Service worker: the codec broker, and the two entry points — the keyboard shortcut (compose) and
// the right-click menu (reveal). Both inject the content script into ONE tab on demand; activeTab
// is granted by the user gesture itself, so the extension holds no standing access to any site.
import contentScript from '../content/index.ts?script'
import { DEFAULT_CODEC_URL, DEFAULT_GATE_URL, LOCAL, GATE_PATHS, RELAYER_URL } from '../shared/messages'
import type { SwRequest, SwResponse } from '../shared/messages'
import { fromB64 } from '../../../shared/keys.mjs'
import { platformOf, looksLikeReply, replyText } from '../../../shared/coverctx.mjs'
import { buySpace, buyState, spaceAvailable, checkCollection, spaceInfo, spacePrice } from './buy'
import { openCandidates, sealedGet, keyringView, addPassphrase, removePassphrase, forgetConnected, worldConnect, walletConnect, onWidgetMessage } from './sealed'

const TIMEOUT = 30_000 // gpt2 takes seconds; fail closed rather than hang
// codec2 sleeps between uses (door/): the first call after a nap waits for it to wake (~5-40 s)
const WAKE = 60_000

/** Demo passes (relayer POST /demo/mint): testnet NFTs so anyone can try a holders-only space. */
async function demoMint(to: string[]): Promise<SwResponse> {
  try {
    const r = await fetch(`${RELAYER_URL}/demo/mint`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to }), signal: AbortSignal.timeout(90_000) })
    const j = await r.json()
    return r.ok ? { ok: true, data: j } : { ok: false, error: j.error ?? `relayer ${r.status}` }
  } catch (e) {
    return { ok: false, error: `relayer unreachable: ${String(e)}` }
  }
}

async function codecBase(): Promise<string> {
  const got = await chrome.storage.local.get(LOCAL.codecUrl)
  return ((got[LOCAL.codecUrl] as string) || DEFAULT_CODEC_URL).replace(/\/+$/, '')
}

async function gateBase(): Promise<string> {
  const got = await chrome.storage.local.get(LOCAL.gateUrl)
  return ((got[LOCAL.gateUrl] as string) || DEFAULT_GATE_URL).replace(/\/+$/, '')
}


async function post(url: string, body: unknown, timeout = TIMEOUT): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
}

/**
 * codec2: the writer's reply (/hide → /drop) and the reader's way back (/reveal → GET /drop). The
 * store ALWAYS returns a frame — a decoy for a locator nobody stored — so only opening it with the
 * keyring tells a post from ordinary text, exactly as with sealed posts under the old codec.
 */
async function codec2(msg: Extract<SwRequest, { type: 'HIDE' | 'DROP' | 'REVEAL2' }>): Promise<SwResponse> {
  const base = await codecBase()
  try {
    if (msg.type === 'HIDE') {
      // best-of-3 on a CPU model: 15–25 s measured
      const r = await post(`${base}/hide`, { thread: msg.thread, platform: msg.platform, nbytes: 8, tries: 3 }, 120_000 + WAKE)
      return r.ok ? { ok: true, data: await r.json() } : { ok: false, status: r.status, error: `hide failed (${r.status})` }
    }
    if (msg.type === 'DROP') {
      const r = await post(`${base}/drop`, { locator: msg.locator, token: msg.token, frame: msg.frameB64 })
      return r.status === 201 ? { ok: true, data: {} } : { ok: false, status: r.status, error: `drop failed (${r.status})` }
    }
    // The reply and the platform are all reading needs (the opener is inside the reply). The server
    // tries each sentence boundary, so a reply can yield more than one locator: fetch them all and
    // let the keyring decide — a wrong split's locator gets a decoy that never opens.
    const r = await post(`${base}/reveal`, { text: msg.text, platform: msg.platform, nbits: 64 }, TIMEOUT + WAKE)
    if (!r.ok) return { ok: false, status: r.status, error: `reveal failed (${r.status})` }
    const { locators } = (await r.json()) as { locators: string[] }
    if (!locators?.length) return { ok: false, error: 'not-cover' }
    const frames: string[] = []
    for (const l of locators) {
      const d = await fetch(`${base}/drop/${l}`, { signal: AbortSignal.timeout(TIMEOUT) })
      if (d.ok) frames.push(((await d.json()) as { frame: string }).frame)
    }
    return frames.length ? { ok: true, data: { frames } } : { ok: false, error: 'drop unreachable' }
  } catch (e) {
    return { ok: false, error: `codec2 unreachable: ${String(e)}` }
  }
}

async function handle(msg: SwRequest): Promise<SwResponse> {
  if (msg.type === 'SITE_LIST') {
    const all = await chrome.scripting.getRegisteredContentScripts()
    return { ok: true, data: all.filter((c) => c.id.startsWith('auto:')).map((c) => c.id.slice(5)) }
  }
  if (msg.type === 'SITE_STATE' || msg.type === 'SITE_SET') {
    // "Always on for this site": the permission is requested by the POPUP (it needs the click);
    // here we only (un)register the content script for that one origin.
    const id = `auto:${msg.origin}`
    if (msg.type === 'SITE_SET') {
      await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {})
      if (msg.on) {
        await chrome.scripting.registerContentScripts([{
          id, matches: [`${msg.origin}/*`], js: [contentScript], runAt: 'document_idle', persistAcrossSessions: true,
        }])
      } else {
        await chrome.permissions.remove({ origins: [`${msg.origin}/*`] }).catch(() => {})
      }
    }
    const on = (await chrome.scripting.getRegisteredContentScripts({ ids: [id] })).length > 0
    return { ok: true, data: { on } }
  }
  if (msg.type === 'FIND_POSTS') {
    // Deep scan: reply-shaped blocks (free shape check), then the codec, then the keyring. One at a
    // time — the server serialises model calls anyway, and each reply costs a few seconds.
    const platform = platformOf(msg.host ?? '')
    const replies = msg.texts.map((t, i) => ({ t: replyText(t), i })).filter(({ t }) => looksLikeReply(t)).slice(0, 10)
    const frames: { i: number; frame: Uint8Array }[] = []
    for (const c of replies) {
      const r = await codec2({ type: 'REVEAL2', text: c.t, platform }).catch(() => null)
      if (r?.ok) for (const f of (r.data as { frames: string[] }).frames) frames.push({ i: c.i, frame: fromB64(f) })
    }
    // Step 3: sealed posts open only with the keyring (nothing else can tell they are posts);
    // older posts that show their rule get a Reveal as before.
    const { opened, legacy } = await openCandidates(frames)
    return { ok: true, data: { found: legacy.sort((a, b) => a - b), opened } }
  }
  if (msg.type === 'HIDE' || msg.type === 'DROP' || msg.type === 'REVEAL2') return codec2(msg)
  if (msg.type === 'OPEN_FRAME') {
    // The reveal card read a reply: open its frame with the keyring, as a scan would.
    const { opened } = await openCandidates(msg.framesB64.map((f) => ({ i: 0, frame: fromB64(f) })))
    return opened.length ? { ok: true, data: { id: opened[0].id } } : { ok: false, error: 'not-opened' }
  }
  if (msg.type === 'WORLD_SIM') {
    // STAGING DEMO ONLY. World's simulator rejects calls with an extension Origin, so the gate —
    // which already talks to World — relays the request (gate/world.mjs simulate()).
    try {
      const r = await post(`${await gateBase()}/dev/simulate`, { connectUrl: msg.connectUrl })
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; deny?: string }
      return j.ok ? { ok: true, data: {} } : { ok: false, error: j.deny ?? `gate ${r.status}` }
    } catch (e) {
      return { ok: false, error: `gate unreachable: ${String(e)}` }
    }
  }
  if (msg.type === 'GATE_HEALTH' || msg.type === 'GATE') {
    try {
      if (msg.type === 'GATE' && !GATE_PATHS.includes(msg.path)) return { ok: false, error: 'unknown gate route' }
      const g = await gateBase()
      const r = msg.type === 'GATE_HEALTH'
        ? await fetch(`${g}/health`, { signal: AbortSignal.timeout(8_000) })
        : await post(`${g}${msg.path}`, msg.body)
      const data = await r.json().catch(() => ({}))
      return r.ok ? { ok: true, data } : { ok: false, status: r.status, error: (data as { error?: string }).error ?? `gate ${r.status}` }
    } catch (e) {
      return { ok: false, error: `gate unreachable: ${String(e)}` }
    }
  }
  const base = await codecBase()
  try {
    if (msg.type === 'HEALTH') {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(8_000) })
      return r.ok ? { ok: true, data: await r.json() } : { ok: false, error: `health ${r.status}` }
    }
    return { ok: false, error: 'unknown message' }
  } catch (e) {
    return { ok: false, error: `codec unreachable: ${String(e)}` }
  }
}

chrome.runtime.onMessage.addListener((msg: SwRequest, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || !('type' in msg)) return false
  if (msg.type === 'BUY_SPACE') {
    buySpace(msg).then(sendResponse)
    return true
  }
  if (msg.type === 'SPACE_PRICE') return void spacePrice(msg.chainId).then(sendResponse), true
  if (msg.type === 'DEMO_MINT') return void demoMint(msg.to).then(sendResponse), true
  if (msg.type === 'SPACE_INFO') return void spaceInfo(msg.label).then(sendResponse), true
  if (msg.type === 'SPACE_AVAILABLE') return void spaceAvailable(msg.label).then(sendResponse), true
  if (msg.type === 'COLLECTION_CHECK') return void checkCollection(msg.token).then((bad) => sendResponse({ ok: !bad, error: bad ?? undefined })), true
  if (msg.type === 'BUY_STATE') {
    buyState().then(sendResponse)
    return true
  }
  // Card ↔ World ID tab traffic is not for the service worker: stay silent so it reaches them.
  if (msg.type === 'WORLD_WIDGET_RESULT' || msg.type === 'WORLD_WIDGET_CLOSED' || msg.type === 'WORLD_WIDGET_VERDICT' || msg.type === 'WORLD_WIDGET_SIMULATE' || msg.type === 'WORLD_WIDGET_PING') {
    onWidgetMessage(msg) // a keyring connection waiting in this worker (the reveal card listens too)
    return false
  }
  if (msg.type === 'SEALED_GET') return void sealedGet(msg.id).then(sendResponse), true
  if (msg.type === 'KEYRING_VIEW') return void keyringView().then(sendResponse), true
  if (msg.type === 'KEYRING_ADD_PASS') return void addPassphrase(msg.passphrase).then(sendResponse), true
  if (msg.type === 'KEYRING_REMOVE_PASS') return void removePassphrase(msg.id).then(sendResponse), true
  if (msg.type === 'KEYRING_FORGET') return void forgetConnected().then(sendResponse), true
  if (msg.type === 'WORLD_CONNECT') {
    worldConnect(msg.kind, msg.country, !!msg.simulate, (id, request, simulate) => openWorldTab(id, request, undefined, simulate)).then(sendResponse)
    return true
  }
  if (msg.type === 'WALLET_CONNECT') {
    walletConnect((message) => walletSign(msg.tabId, message)).then(sendResponse)
    return true
  }
  if (msg.type === 'WORLD_WIDGET_OPEN') {
    openWorldTab(msg.id, msg.request, sender.tab?.id, msg.simulate).then(sendResponse)
    return true
  }
  if (msg.type === 'WORLD_WIDGET_DONE') {
    closeWorldTab(msg.id).then(sendResponse)
    return true
  }
  if (msg.type === 'WALLET_SIGN') {
    walletSign(sender.tab?.id, msg.message).then(sendResponse)
    return true
  }
  handle(msg).then(sendResponse)
  return true
})

/**
 * World's IDKit widget needs a full-size page (it drops the QR below 1024 px), so it runs in its own
 * extension tab. The gate's signed request is handed over in storage.session (extension-only, gone
 * when the browser closes); the tab that asked is refocused when the widget is done.
 */
async function openWorldTab(id: string, request: unknown, openerTabId?: number, simulate?: boolean): Promise<SwResponse> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return { ok: false, error: 'bad id' }
  await chrome.storage.session.set({ [`world:${id}`]: request, [`worldOpener:${id}`]: openerTabId ?? null })
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`src/world/index.html#${id}${simulate ? '&sim' : ''}`), active: true, openerTabId })
  await chrome.storage.session.set({ [`worldTab:${id}`]: tab.id })
  return { ok: true, data: { tabId: tab.id } }
}
// A World ID tab closed with the browser's × (not the widget's own): the widget cannot say so — tell
// whoever waits (a keyring connection here, a reveal card) that it ended without a proof.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const all = await chrome.storage.session.get(null)
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('worldTab:') || v !== tabId) continue
    const m = { type: 'WORLD_WIDGET_CLOSED' as const, id: k.slice('worldTab:'.length) }
    await chrome.storage.session.remove(k)
    onWidgetMessage(m)
    void chrome.runtime.sendMessage(m).catch(() => {})
  }
})

/** Close THE widget tab recorded at open (never the sender's tab — the card's sender is the site). */
async function closeWorldTab(id: string): Promise<SwResponse> {
  const keys = [`worldOpener:${id}`, `worldTab:${id}`, `world:${id}`]
  const got = await chrome.storage.session.get(keys)
  await chrome.storage.session.remove(keys)
  const opener = got[keys[0]] as number | null | undefined
  const worldTabId = got[keys[1]] as number | undefined
  if (opener) await chrome.tabs.update(opener, { active: true }).catch(() => {})
  if (worldTabId) await chrome.tabs.remove(worldTabId).catch(() => {})
  return { ok: true, data: null }
}

/**
 * Ask the reader's OWN wallet (injected by MetaMask & co. into the page they are reading) to sign
 * the gate's challenge. Wallets inject window.ethereum into web pages, not into extension pages,
 * so this runs in the page's MAIN world for one call. The message is the gate's challenge — public,
 * bound to this reader's one-time key — and signing moves nothing.
 */
export async function walletSign(tabId: number | undefined, message: string): Promise<SwResponse> {
  if (!tabId) return { ok: false, error: 'no page to ask the wallet from' }
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [message],
      func: async (m: string) => {
        const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum
        if (!eth) return { error: 'No wallet found in this browser (MetaMask, Rabby, …).' }
        try {
          const [address] = (await eth.request({ method: 'eth_requestAccounts' })) as string[]
          const sig = (await eth.request({ method: 'personal_sign', params: [m, address] })) as string
          return { address, sig }
        } catch (e) {
          return { error: (e as { message?: string })?.message ?? 'The wallet declined.' }
        }
      },
    })
    const v = r?.result as { address?: string; sig?: string; error?: string } | undefined
    return v?.sig ? { ok: true, data: v } : { ok: false, error: v?.error ?? 'no answer from the wallet' }
  } catch (e) {
    return { ok: false, error: `could not reach the page: ${String(e)}` }
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------
async function inject(tabId: number, action: { action: 'compose' } | { action: 'reveal'; text: string } | { action: 'scan' }) {
  await chrome.scripting.executeScript({ target: { tabId }, files: [contentScript] })
  await chrome.tabs.sendMessage(tabId, { lortnocAction: action })
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'compose' && tab?.id) await inject(tab.id, { action: 'compose' }).catch(console.warn)
})

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'reveal', title: 'Reveal with lortnoc tahc', contexts: ['selection'] })
  chrome.contextMenus.create({ id: 'compose', title: 'Write a hidden message here', contexts: ['editable'] })
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return
  if (info.menuItemId === 'reveal' && info.selectionText) await inject(tab.id, { action: 'reveal', text: info.selectionText }).catch(console.warn)
  if (info.menuItemId === 'compose') await inject(tab.id, { action: 'compose' }).catch(console.warn)
})

/** From the popup: the user clicked "Compose" or "Scan this page" — a gesture, so activeTab holds. */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.popup !== 'compose' && msg?.popup !== 'scan') return false
  chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
    if (!tab?.id) return sendResponse({ ok: false })
    try {
      await inject(tab.id, { action: msg.popup })
      sendResponse({ ok: true })
    } catch (e) {
      sendResponse({ ok: false, error: String(e) })
    }
  })
  return true
})
