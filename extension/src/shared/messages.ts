// Message contract between content script / popup (senders) and the service worker (broker).

export type CodecRequest =
  | { type: 'HEALTH' }
  | { type: 'ENCODE'; ciphertextB64: string; fast?: boolean; handle?: string; membership?: string }
  | { type: 'DECODE'; coverText: string }

export type HealthData = { model: string; digest: string; ready: boolean }
// remaining: free sends left (-1 = unmetered/member); member: on a paid token.
// `select` is the codec's honest report of whether 0G actually judged this cover:
// '0g-testnet' | '0g-router' = it did, 'fallback' = 0G was unreachable and the first cover
// was used, 'single' = selection skipped (handshake frames). 0G selection fails silently by
// design, so without this the UI can only guess — and it used to guess on a timer.
export type EncodeData = { coverText: string; remaining?: number; member?: boolean; select?: string }
export type DecodeData = { ciphertext: string }

export type CodecResponse<T = unknown> =
  // status carries the HTTP code on failure (402 = payment required → paywall).
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number }

export function sendToCodec<T>(msg: CodecRequest): Promise<CodecResponse<T>> {
  return chrome.runtime.sendMessage(msg) as Promise<CodecResponse<T>>
}
