// Message contract between content script / popup (senders) and the service worker (broker).
// Mirrors the Telegram build's contract, minus the metering fields — the X build has no
// freemium gate yet (PRD §8 step 6 territory), so it does not pretend to carry one.

export type CodecRequest =
  | { type: 'HEALTH' }
  | { type: 'ENCODE'; ciphertextB64: string; fast?: boolean; handle?: string }
  | { type: 'DECODE'; coverText: string }
  // ENS lookups go through the SW for the same reason codec calls do: MV3 content scripts get no
  // host permissions for fetch, so a cross-origin request from one is subject to the page's CORS.
  | { type: 'RESOLVE'; handle: string }

/**
 * Which coder this build asks the codec for, on EVERY request.
 *
 * Named explicitly rather than left to the server's default, because both extensions call the
 * same codec instance (CLAUDE.md §6.2 — one warm process is what makes encode and decode
 * deterministic against each other). If this build relied on a global default, switching that
 * default would also switch the Telegram build, and every message already sitting in a Telegram
 * chat would stop decoding: encoded with `block`, read back with `arith`. Naming it per request
 * makes the two surfaces independent.
 *
 * `arith` measured ~25% shorter cover text than `block` at k=3 on gpt2 — and more natural, since
 * it follows the model's own distribution instead of forcing a fixed 3 bits into every token.
 */
export const CODER = 'arith'

/**
 * `paused` is why this type has three states, not two.
 *
 * A paused codec answers /health with 200 and `ready: true` ON PURPOSE — a non-200 would flip
 * every already-installed extension to "offline" and bury the actual reason. It then answers
 * /encode and /decode with 503. So `ready` alone is NOT enough to decide whether posting will
 * work, and treating it as enough shows a green light on a codec that will refuse every post.
 */
export type HealthData = {
  model: string
  digest: string
  ready: boolean
  paused?: boolean
  message?: string
  url?: string
}

// `select` and `model` are the codec's honest report of what actually produced this cover:
// which backend ran (the dispatcher falls back silently gpt2 -> markov -> wordmap) and whether 0G
// really judged it. The rule they exist for: report what happened, never assert what was hoped
// for — the Telegram build's stepper used to announce "GPT-2" whichever backend had run.
export type EncodeData = {
  coverText: string
  /** Free sends left on this bucket; -1 means unmetered or a member. */
  remaining?: number
  select?: string
  model?: string
}
export type DecodeData = { ciphertext: string }
/** null pubkey = the handle does not resolve, or has published no messaging key. */
export type ResolveData = { handle: string; pubkey: string | null }

export type CodecResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number }

export function sendToCodec<T>(msg: CodecRequest): Promise<CodecResponse<T>> {
  return chrome.runtime.sendMessage(msg) as Promise<CodecResponse<T>>
}
