// Content-script settings, kept in sync with chrome.storage.
//
// Deliberately simpler than the Telegram build's state.ts: there is no per-chat toggle, because
// on a broadcast surface there is no "chat" to scope one to. Stego is on or off globally, and
// the hashtag decides which posts are candidates (PRD §7).
import { LOCAL, DEFAULT_CODEC_URL } from '../shared/config'

type State = {
  enabled: boolean
  codecUrl: string
}

const state: State = { enabled: false, codecUrl: DEFAULT_CODEC_URL }

export function get(): Readonly<State> {
  return state
}

async function refresh(): Promise<void> {
  const local = await chrome.storage.local.get([LOCAL.enabled, LOCAL.codecUrl])
  state.enabled = Boolean(local[LOCAL.enabled])
  state.codecUrl = (local[LOCAL.codecUrl] as string) || DEFAULT_CODEC_URL
}

/** Load initial state and keep it live as the popup changes settings. */
export async function initState(onChange?: () => void): Promise<void> {
  await refresh()
  chrome.storage.onChanged.addListener(async () => {
    await refresh()
    onChange?.()
  })
}

/** Mode 1 needs no key exchange, so "switched on" is the whole readiness question here — unlike
 *  the Telegram build, where a session may exist without a conversation key. */
export function ready(): boolean {
  return state.enabled
}
