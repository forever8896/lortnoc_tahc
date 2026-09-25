// Service worker: the codec broker, and the two entry points — the keyboard shortcut (compose) and
// the right-click menu (reveal). Both inject the content script into ONE tab on demand; activeTab
// is granted by the user gesture itself, so the extension holds no standing access to any site.
import contentScript from '../content/index.ts?script'
import { CODER, DEFAULT_CODEC_URL, LOCAL } from '../shared/messages'
import type { SwRequest, SwResponse } from '../shared/messages'

const TIMEOUT = 30_000 // gpt2 takes seconds; fail closed rather than hang

async function codecBase(): Promise<string> {
  const got = await chrome.storage.local.get(LOCAL.codecUrl)
  return ((got[LOCAL.codecUrl] as string) || DEFAULT_CODEC_URL).replace(/\/+$/, '')
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

chrome.runtime.onMessage.addListener((msg: SwRequest, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || !('type' in msg)) return false
  handle(msg).then(sendResponse)
  return true
})

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
