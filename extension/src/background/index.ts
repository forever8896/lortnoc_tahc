// Service worker: the ONLY component that talks to the codec. Content script/popup send
// {ENCODE|DECODE|HEALTH}; the SW fetches the (user-configured) codec URL. Fetching here
// bypasses the page's CORS via host_permissions. Stateless — safe across SW cold starts.
import { LOCAL, DEFAULT_CODEC_URL } from '../shared/config'
import type { CodecRequest, CodecResponse } from '../shared/messages'

// Let the content script read the in-memory passphrase from storage.session
// (default access is trusted-contexts only). Passphrase is never in storage.local/disk.
chrome.storage.session
  .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch(() => {})

async function codecBase(): Promise<string> {
  const got = await chrome.storage.local.get(LOCAL.codecUrl)
  const url = (got[LOCAL.codecUrl] as string) || DEFAULT_CODEC_URL
  return url.replace(/\/+$/, '')
}

// Toolbar icon reflects the on/off state: the mark lights up green when Stego is active.
function iconSet(on: boolean): Record<number, string> {
  const v = on ? 'on' : 'off'
  return {
    16: `icons/${v}-16.png`,
    32: `icons/${v}-32.png`,
    48: `icons/${v}-48.png`,
    128: `icons/${v}-128.png`,
  }
}
async function reflectState(): Promise<void> {
  const got = await chrome.storage.local.get(LOCAL.enabled)
  const on = got[LOCAL.enabled] === true
  await chrome.action.setIcon({ path: iconSet(on) }).catch(() => {})
  await chrome.action.setTitle({ title: on ? 'lortnoc tahc — PrivacyMaxxing ON' : 'lortnoc tahc — PrivacyMaxxing off' }).catch(() => {})
}
chrome.runtime.onInstalled.addListener(() => void reflectState())
chrome.runtime.onStartup.addListener(() => void reflectState())
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && LOCAL.enabled in changes) void reflectState()
})
void reflectState()

// Bound every codec call so a slow/unreachable fly instance fails closed (pulse clears)
// instead of hanging forever. GPT-2 can take several seconds, so give it real headroom.
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
        handle: msg.handle, // metering bucket (§9); server ignores it for fast frames
        membership: msg.membership, // x402 bearer token → unlimited when present + valid
      })
      // 402 = free limit reached (x402 payment required) → distinct status for the paywall.
      return r.ok ? { ok: true, data: await r.json() } : { ok: false, error: `encode ${r.status}`, status: r.status }
    }
    if (msg.type === 'DECODE') {
      const r = await postJson(`${base}/decode`, { coverText: msg.coverText })
      // 422 = "not codec cover text" → treated as not-ours downstream
      return r.ok ? { ok: true, data: await r.json() } : { ok: false, error: `decode ${r.status}` }
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
