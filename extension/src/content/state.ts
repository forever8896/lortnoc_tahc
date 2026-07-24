// Reactive-ish session state for the content script: enabled flag, codec URL, and the
// derived key (kept in memory only). Reads from chrome.storage and stays in sync.
import { LOCAL, SESSION, DEFAULT_CODEC_URL } from '../shared/config'
import { deriveKey } from './crypto'

type State = {
  enabled: boolean
  codecUrl: string
  key: Uint8Array | null // derived from the passphrase; null until set
}

const state: State = { enabled: false, codecUrl: DEFAULT_CODEC_URL, key: null }

export function get(): Readonly<State> {
  return state
}

async function refresh(): Promise<void> {
  const local = await chrome.storage.local.get([LOCAL.enabled, LOCAL.codecUrl])
  state.enabled = Boolean(local[LOCAL.enabled])
  state.codecUrl = (local[LOCAL.codecUrl] as string) || DEFAULT_CODEC_URL
  const session = await chrome.storage.session.get(SESSION.passphrase)
  const pass = session[SESSION.passphrase] as string | undefined
  state.key = pass ? deriveKey(pass) : null
}

/** Load initial state and keep it live as the popup changes settings. */
export async function initState(onChange?: () => void): Promise<void> {
  await refresh()
  chrome.storage.onChanged.addListener(async (_changes, _area) => {
    await refresh()
    onChange?.()
  })
}

export function ready(): boolean {
  return state.enabled && state.key !== null
}
