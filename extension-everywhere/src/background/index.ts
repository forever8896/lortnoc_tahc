// Service worker: the codec broker, and the two entry points — the keyboard shortcut (compose) and
// the right-click menu (reveal). Both inject the content script into ONE tab on demand; activeTab
// is granted by the user gesture itself, so the extension holds no standing access to any site.
import contentScript from '../content/index.ts?script'
import { CODER, DEFAULT_CODEC_URL, DEFAULT_GATE_URL, LOCAL, GATE_PATHS } from '../shared/messages'
import type { SwRequest, SwResponse } from '../shared/messages'
import { looksLikeCover, canonicalCover, inspect } from '../../../shared/webframe.mjs'
import { fromB64 } from '../../../shared/keys.mjs'
import { buySpace, buyState } from './buy'

const TIMEOUT = 30_000 // gpt2 takes seconds; fail closed rather than hang

async function codecBase(): Promise<string> {
  const got = await chrome.storage.local.get(LOCAL.codecUrl)
  return ((got[LOCAL.codecUrl] as string) || DEFAULT_CODEC_URL).replace(/\/+$/, '')
}

async function gateBase(): Promise<string> {
  const got = await chrome.storage.local.get(LOCAL.gateUrl)
  return ((got[LOCAL.gateUrl] as string) || DEFAULT_GATE_URL).replace(/\/+$/, '')
}

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  })
}

async function handle(msg: SwRequest): Promise<SwResponse> {
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
    // Deep scan, step 1 (shape, free) then step 2 (codec + frame check), a few at a time.
    const candidates = msg.texts.map((t, i) => ({ t, i })).filter(({ t }) => looksLikeCover(t)).slice(0, 40)
    const found: number[] = []
    const queue = [...candidates]
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const r = await handle({ type: 'DECODE', coverText: canonicalCover(c.t) }).catch(() => null)
        if (r?.ok && inspect(fromB64((r.data as { ciphertext: string }).ciphertext))) found.push(c.i)
      }
    }
    await Promise.all([worker(), worker(), worker()])
    return { ok: true, data: { found: found.sort((a, b) => a - b) } }
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
    if (msg.type === 'ENCODE') {
      const r = await post(`${base}/encode`, { ciphertext: msg.ciphertextB64, coder: CODER })
      if (r.ok) return { ok: true, data: await r.json() }
      return { ok: false, status: r.status, error: r.status === 503 ? 'the codec is paused' : `encode failed (${r.status})` }
    }
    if (msg.type === 'DECODE') {
      const r = await post(`${base}/decode`, { coverText: msg.coverText, coder: CODER })
      if (r.ok) return { ok: true, data: await r.json() }
      // 422 = not cover text. 400 is ALSO "not ours" today: arith answers 400 for prose made only of
      // vocabulary words (codec/arith.py, research-tokyo/normalization.md flag 2).
      return { ok: false, status: r.status, error: r.status === 422 || r.status === 400 ? 'not-cover' : `decode failed (${r.status})` }
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
  if (msg.type === 'BUY_STATE') {
    buyState().then(sendResponse)
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
