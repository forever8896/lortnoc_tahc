// Message contract. Three kinds of context talk here:
//   * the service worker — the only thing that fetches the codec (MV3 content scripts and pages
//     inside other sites' iframes get no CORS pass; the SW has host_permissions)
//   * the content script — injected on demand into ONE tab via activeTab; never sees plaintext
//   * the sheet / reveal iframes — extension-origin pages where plaintext lives and dies

export const DEFAULT_CODEC_URL = 'https://lortnoc-codec.fly.dev'

/**
 * Named on EVERY request, never inherited (CLAUDE.md §4). Every extension calls the same codec
 * instance, so a server-side default would be shared state between surfaces.
 */
export const CODER = 'arith'

export const LOCAL = {
  codecUrl: 'codecUrl',
  marker: 'marker', // append #lortnoctahc — off in high-risk mode (PRD §18.3)
} as const

export type SwRequest =
  | { type: 'HEALTH' }
  | { type: 'ENCODE'; ciphertextB64: string }
  | { type: 'DECODE'; coverText: string }

export type SwResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string; status?: number }

export type HealthData = { model: string; digest: string; ready: boolean; paused?: boolean; message?: string }
export type EncodeData = { coverText: string }
export type DecodeData = { ciphertext: string }

/** Frame ⇄ content script, over window.postMessage. ONLY cover text ever crosses this boundary —
 *  it is public by construction; the page may observe these messages and learns nothing. */
export type FrameToContent =
  | { lortnoc: 'insert'; text: string }
  | { lortnoc: 'close' }
  | { lortnoc: 'resize'; height: number }
export type ContentToFrame = { lortnoc: 'inserted'; how: 'field' | 'clipboard' | 'failed' }

export async function sw<T>(req: SwRequest): Promise<SwResponse<T>> {
  try {
    return (await chrome.runtime.sendMessage(req)) as SwResponse<T>
  } catch (e) {
    return { ok: false, error: `extension error: ${String(e)}` }
  }
}
