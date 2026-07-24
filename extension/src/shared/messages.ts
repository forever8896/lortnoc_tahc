// Message contract between content script / popup (senders) and the service worker (broker).

export type CodecRequest =
  | { type: 'HEALTH' }
  | { type: 'ENCODE'; ciphertextB64: string }
  | { type: 'DECODE'; coverText: string }

export type HealthData = { model: string; digest: string; ready: boolean }
export type EncodeData = { coverText: string }
export type DecodeData = { ciphertext: string }

export type CodecResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string }

export function sendToCodec<T>(msg: CodecRequest): Promise<CodecResponse<T>> {
  return chrome.runtime.sendMessage(msg) as Promise<CodecResponse<T>>
}
