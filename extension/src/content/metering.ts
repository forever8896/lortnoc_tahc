// Freemium metering (§9) — the conversion engine. Counts hidden SENDS and, past the free
// limit, blocks sending so the user is funnelled to the pay page (where they buy 0G
// membership and upgrade from the throwaway handshake key to a wallet-derived identity).
//
// HONEST BY DESIGN: there is no server account (§5.5), so this is client-side and trivially
// bypassable (clear storage). It's a nudge, not DRM — never claim it's enforced. Reading /
// decoding inbound is ALWAYS free (§7); only outbound is gated.
//
// State is cached in memory and mirrored to storage.local. Metering is per-installation for
// now; keying by the logged-in Telegram handle is a drop-in refinement (own-handle detection
// on Web K is fragile, so it's deferred).
import { LOCAL, FREE_LIMIT, WARN_AT } from '../shared/config'

type Meter = { sends: number; paid: boolean }
let state: Meter = { sends: 0, paid: false }

/** Load persisted counter + paid flag once at content-script boot. */
export async function loadMeter(): Promise<void> {
  const got = (await chrome.storage.local.get(LOCAL.meter))[LOCAL.meter] as Meter | undefined
  if (got) state = { sends: got.sends ?? 0, paid: Boolean(got.paid) }
}

async function persist(): Promise<void> {
  await chrome.storage.local.set({ [LOCAL.meter]: state })
}

export function isPaid(): boolean {
  return state.paid
}

export function sends(): number {
  return state.sends
}

export function remaining(): number {
  return Math.max(0, FREE_LIMIT - state.sends)
}

/** True when the free quota is spent and the user hasn't paid → block the send. */
export function isBlocked(): boolean {
  return !state.paid && state.sends >= FREE_LIMIT
}

/** True on the last few free sends → surface the soft "running low" nudge. */
export function isRunningLow(): boolean {
  return !state.paid && state.sends >= WARN_AT && state.sends < FREE_LIMIT
}

/** Record one successful hidden send. Returns the new count. */
export async function increment(): Promise<number> {
  state.sends += 1
  await persist()
  return state.sends
}

/** Flip to unlimited once membership is verified (set by the unlock flow). */
export async function setPaid(paid: boolean): Promise<void> {
  state.paid = paid
  await persist()
}
