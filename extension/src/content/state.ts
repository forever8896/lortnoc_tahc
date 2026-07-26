// Reactive-ish session state for the content script: enabled flag, codec URL, and the
// derived key (kept in memory only). Reads from chrome.storage and stays in sync.
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
  chrome.storage.onChanged.addListener(async (_changes, _area) => {
    await refresh()
    onChange?.()
  })
}

/** Stego is usable when it is switched on. Whether we hold a conversation key is a separate
 *  question, answered by the session — see haveKey() in index.ts. */
export function ready(): boolean {
  return state.enabled
}
