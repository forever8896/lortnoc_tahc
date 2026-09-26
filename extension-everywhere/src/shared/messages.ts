// Message contract. Three kinds of context talk here:
//   * the service worker — the only thing that fetches the codec (MV3 content scripts and pages
//     inside other sites' iframes get no CORS pass; the SW has host_permissions)
//   * the content script — injected on demand into ONE tab via activeTab; never sees plaintext
//   * the sheet / reveal iframes — extension-origin pages where plaintext lives and dies

export const DEFAULT_CODEC_URL = 'https://lortnoc-codec.fly.dev'
/** The gate holds shares for attested checks (time lock, World ID, tokens). Local until hosted. */
export const DEFAULT_GATE_URL = 'http://localhost:8790'
/** Turns a paid space purchase into its ENS name (relayer POST /space, PRD §23.2). */
export const RELAYER_URL = 'https://lortnoc-relayer.fly.dev'

/**
 * Named on EVERY request, never inherited (CLAUDE.md §4). Every extension calls the same codec
 * instance, so a server-side default would be shared state between surfaces.
 */
export const CODER = 'arith'

export const LOCAL = {
  codecUrl: 'codecUrl',
  gateUrl: 'gateUrl',
} as const

export type SwRequest =
  | { type: 'HEALTH' }
  | { type: 'ENCODE'; ciphertextB64: string }
  | { type: 'DECODE'; coverText: string }
  | { type: 'GATE_HEALTH' }
  | { type: 'GATE'; path: GatePath; body: unknown }
  | { type: 'WORLD_SIM'; connectUrl: string }
  | { type: 'FIND_POSTS'; texts: string[] }
  | { type: 'WALLET_SIGN'; message: string }
  | { type: 'BUY_SPACE'; label: string; token: string; chainId: 1 | 11155111; tabId: number }
  | { type: 'BUY_STATE' }
  | { type: 'SITE_STATE'; origin: string }
  | { type: 'SITE_SET'; origin: string; on: boolean }

/** Gate routes the extension may call (the service worker refuses anything else). */
export const GATE_PATHS = ['/deposit', '/challenge', '/release', '/space', '/member/sign', '/ban', '/dev/simulate'] as const
export type GatePath = (typeof GATE_PATHS)[number]

export type SwResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string; status?: number }

export type HealthData = { model: string; digest: string; ready: boolean; paused?: boolean; message?: string }
export type EncodeData = { coverText: string }
export type DecodeData = { ciphertext: string }
export type GateHealth = { ok: boolean; pub: string; signPub: string; checks: string[]; world?: { env: string } | null }

/** `post` for shared/gateclient.mjs, routed through the service worker (it has the host permission). */
export async function gatePost(path: string, body: unknown): Promise<any> {
  const r = await sw<unknown>({ type: 'GATE', path: path as GatePath, body })
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
