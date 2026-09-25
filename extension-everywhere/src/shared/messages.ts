// Message contract. Three kinds of context talk here:
//   * the service worker — the only thing that fetches the codec (MV3 content scripts and pages
//     inside other sites' iframes get no CORS pass; the SW has host_permissions)
//   * the content script — injected on demand into ONE tab via activeTab; never sees plaintext
//   * the sheet / reveal iframes — extension-origin pages where plaintext lives and dies

export const DEFAULT_CODEC_URL = 'https://lortnoc-codec.fly.dev'
/** The gate holds shares for attested checks (time lock, World ID, tokens). Local until hosted. */
export const DEFAULT_GATE_URL = 'http://localhost:8790'

/**
 * Named on EVERY request, never inherited (CLAUDE.md §4). Every extension calls the same codec
 * instance, so a server-side default would be shared state between surfaces.
 */
export const CODER = 'arith'

export const LOCAL = {
  codecUrl: 'codecUrl',
  gateUrl: 'gateUrl',
  marker: 'marker', // append #lortnoctahc — off in high-risk mode (PRD §18.3)
} as const

export type SwRequest =
  | { type: 'HEALTH' }
  | { type: 'ENCODE'; ciphertextB64: string }
  | { type: 'DECODE'; coverText: string }
  | { type: 'GATE_HEALTH' }
  | { type: 'GATE'; path: '/deposit' | '/release'; body: unknown }

export type SwResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string; status?: number }

export type HealthData = { model: string; digest: string; ready: boolean; paused?: boolean; message?: string }
export type EncodeData = { coverText: string }
export type DecodeData = { ciphertext: string }
export type GateHealth = { ok: boolean; pub: string; checks: string[] }

/** `post` for shared/gateclient.mjs, routed through the service worker (it has the host permission). */
export async function gatePost(path: string, body: unknown): Promise<any> {
  const r = await sw<unknown>({ type: 'GATE', path: path as '/deposit' | '/release', body })
  return r.ok ? r.data : { error: r.error }
}

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
