// Service worker: the ONLY component that talks to the codec. Content script/popup send
// {ENCODE|DECODE|HEALTH}; the SW fetches the (user-configured) codec URL. Fetching here bypasses
// the page's CORS via host_permissions. Stateless — safe across SW cold starts.
import { LOCAL, DEFAULT_CODEC_URL } from '../shared/config'
import { CODER } from '../shared/messages'
import { resolvePubkey, fullHandle } from './ens'
import type { CodecRequest, CodecResponse } from '../shared/messages'

// The content script holds the unlocked identity in storage.session; by default that area is
// readable only from trusted contexts, so a content script would silently see nothing.
chrome.storage.session
  .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch(() => {})

async function codecBase(): Promise<string> {
  const got = await chrome.storage.local.get(LOCAL.codecUrl)
  const url = (got[LOCAL.codecUrl] as string) || DEFAULT_CODEC_URL
  return url.replace(/\/+$/, '')
}

// Toolbar icon reflects the on/off state.
function iconSet(on: boolean): Record<number, string> {
  const v = on ? 'on' : 'off'
  return { 16: `icons/${v}-16.png`, 32: `icons/${v}-32.png`, 48: `icons/${v}-48.png`, 128: `icons/${v}-128.png` }
}
async function reflectState(): Promise<void> {
  const got = await chrome.storage.local.get(LOCAL.enabled)
  const on = got[LOCAL.enabled] === true
  await chrome.action.setIcon({ path: iconSet(on) }).catch(() => {})
  await chrome.action
    .setTitle({ title: on ? 'lortnoc tahc for X — ON' : 'lortnoc tahc for X — off' })
    .catch(() => {})
}
chrome.runtime.onInstalled.addListener(() => void reflectState())
chrome.runtime.onStartup.addListener(() => void reflectState())
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && LOCAL.enabled in changes) void reflectState()
})
void reflectState()

// Bound every codec call so a slow/unreachable instance fails closed instead of hanging forever.
// GPT-2 takes seconds, so give it real headroom.
const ENCODE_TIMEOUT = 30_000
const HEALTH_TIMEOUT = 8_000

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ENCODE_TIMEOUT),
  })
}

async function handle(msg: CodecRequest): Promise<CodecResponse> {
  const base = await codecBase()
  try {
    if (msg.type === 'HEALTH') {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT) })
      return r.ok ? { ok: true, data: await r.json() } : { ok: false, error: `health ${r.status}` }
    }
    if (msg.type === 'ENCODE') {
      const r = await postJson(`${base}/encode`, {
        ciphertext: msg.ciphertextB64,
        fast: msg.fast === true,
        // Metering bucket (§9). WITHOUT this the hosted codec buckets us as anonymous, which
        // means every install shares one free allowance — see content/bucket.ts.
        handle: msg.handle,
        coder: CODER, // named per request, never inherited — see CODER in shared/messages.ts
      })
      return r.ok
        ? { ok: true, data: await r.json() }
        : { ok: false, error: `encode ${r.status}`, status: r.status }
    }
    if (msg.type === 'DECODE') {
      const r = await postJson(`${base}/decode`, { coverText: msg.coverText, coder: CODER })
      // 422 = "not codec cover text" → treated as not-ours downstream, not as an error.
      return r.ok ? { ok: true, data: await r.json() } : { ok: false, error: `decode ${r.status}` }
    }
    if (msg.type === 'RESOLVE') {
      const handle = fullHandle(msg.handle)
      return { ok: true, data: { handle, pubkey: await resolvePubkey(handle) } }
    }
    return { ok: false, error: 'unknown message type' }
  } catch (e) {
    return { ok: false, error: `codec unreachable: ${String(e)}` }
  }
}

chrome.runtime.onMessage.addListener((msg: CodecRequest, _sender, sendResponse) => {
  handle(msg).then(sendResponse)
  return true // keep the channel open for the async response
})
