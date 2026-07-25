// Message contract between content script / popup (senders) and the service worker (broker).

export type CodecRequest =
  | { type: 'HEALTH' }
  | { type: 'ENCODE'; ciphertextB64: string; fast?: boolean; handle?: string; membership?: string }
  | { type: 'DECODE'; coverText: string }

export type HealthData = { model: string; digest: string; ready: boolean }
// remaining: free sends left (-1 = unmetered/member); member: on a paid token.
export type EncodeData = { coverText: string; remaining?: number; member?: boolean }
export type DecodeData = { ciphertext: string }

export type CodecResponse<T = unknown> =
  // status carries the HTTP code on failure (402 = payment required → paywall).
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number }

export function sendToCodec<T>(msg: CodecRequest): Promise<CodecResponse<T>> {
  return chrome.runtime.sendMessage(msg) as Promise<CodecResponse<T>>
}
