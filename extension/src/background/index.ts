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

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function handle(msg: CodecRequest): Promise<CodecResponse> {
  const base = await codecBase()
  try {
    if (msg.type === 'HEALTH') {
      const r = await fetch(`${base}/health`)
      return r.ok ? { ok: true, data: await r.json() } : { ok: false, error: `health ${r.status}` }
    }
    if (msg.type === 'ENCODE') {
      const r = await postJson(`${base}/encode`, { ciphertext: msg.ciphertextB64 })
      return r.ok ? { ok: true, data: await r.json() } : { ok: false, error: `encode ${r.status}` }
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
