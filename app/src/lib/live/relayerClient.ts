// Client for the relayer (relayer/server.mjs).
//
// The relayer carries a burned ticket from 0G to a handle on Sepolia. It is a trust assumption
// about *liveness* only — it cannot forge a claim, cannot redirect one, and after the pubkey
// binding cannot read your messages either. If it is down, the app falls back to the free path.
import type { Ticket } from './proof'

const BASE = ((import.meta.env.VITE_RELAYER_URL as string) || 'https://lortnoc-relayer.fly.dev').replace(/\/$/, '')

export type GroupSnapshot = { members: string[]; root: string; memberCount: number; groupId: string }
export type ClaimResult = {
  handle: string
  spendTx: string | null
  claimTx: string | null
  stipendTx: string | null
  // Codec membership bearer token, minted from the same nullifier — unlocks unlimited codec
  // use in the extension (no second payment). Null if the relayer has no CODEC_SECRET.
  codecToken?: string | null
}

async function call<T>(path: string, init?: RequestInit, timeoutMs = 90_000): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(body.detail ? `${body.error}: ${body.detail}` : (body.error ?? `relayer ${res.status}`))
    }
    return body as T
  } finally {
    clearTimeout(timer)
  }
}

/** Is the relayer up and actually able to do its job? Drives the paid/free path decision. */
export async function relayerReady(): Promise<boolean> {
  try {
    const h = await call<{ ok: boolean }>('/health', {}, 8_000)
    return h.ok === true
  } catch {
    return false
  }
}

/** The member set. The caller MUST verify `root` against the chain before proving against it. */
export const fetchGroup = (): Promise<GroupSnapshot> => call<GroupSnapshot>('/group', {}, 20_000)

/** Re-issue the codec capability for a membership that was already spent. Used when the token
 *  never reached the extension — the alternative was paying again, which is not an answer. */
export const reissueCodecToken = (body: {
  label: string; evmAddr: string; suiAddr: string; pubkey: string; signature: string
}): Promise<{ codecToken: string | null }> =>
  call('/codec-token', { method: 'POST', body: JSON.stringify(body) }, 30_000)

/** Deliver a sealed knock (§6.8). The relay stores an opaque blob — it cannot read one, and
 *  cannot distinguish a correct knock from a wrong-answer one. */
export const sendKnock = (toHandle: string, sealed: string): Promise<{ ok: boolean; pending: number }> =>
  call('/knock', { method: 'POST', body: JSON.stringify({ toHandle, sealed }) }, 20_000)

/** Every sealed knock waiting for a handle. Public on purpose: unreadable without the answer. */
export const fetchKnocks = (handle: string): Promise<{ knocks: { id: string; sealed: string; ts: number }[] }> =>
  call(`/knocks/${encodeURIComponent(handle)}`, {}, 20_000)

/** Hand over the ticket. Idempotent server-side: a retry after a partial failure resumes. */
export const submitClaim = (body: {
  label: string
  evmAddr: string
  suiAddr: string
  pubkey: string
  ticket: Ticket
}): Promise<ClaimResult> =>
  call<ClaimResult>('/claim', { method: 'POST', body: JSON.stringify(body) }, 180_000)
