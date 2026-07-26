// App→extension bridge for the codec membership token.
//
// The token used to be posted exactly once, at the instant of a paid claim, and stored nowhere.
// If the extension was not installed and listening on that page in that moment it was gone for
// good — and the only "fix" was paying again. So we now keep it and re-offer it on every load.
const STORE = 'lortnoc.codecToken.v1'

/** Hand the token to the extension (if installed) and remember it for next time. */
export function deliverMembershipToExtension(token: string): void {
  try {
    localStorage.setItem(STORE, token)
  } catch {
    /* private mode — delivery below still works for this session */
  }
  post(token)
}

/** The token we last held, if any. */
export function storedMembershipToken(): string | null {
  try {
    return localStorage.getItem(STORE)
  } catch {
    return null
  }
}

/** Re-offer a stored token. Called on app load, so installing the extension AFTER claiming — or
 *  opening the app on a machine where it is installed — is enough to unlock it. */
export function redeliverMembershipToExtension(): boolean {
  const token = storedMembershipToken()
  if (!token) return false
  post(token)
  return true
}

/** Did the extension acknowledge? It replies MEMBERSHIP_OK, so we can tell "unlocked" from
 *  "nothing was listening" instead of claiming success either way. */
export function deliverAndConfirm(token: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { source?: string; type?: string } | null
      if (d?.source === 'lortnoc-ext' && d.type === 'MEMBERSHIP_OK') {
        done = true
        window.removeEventListener('message', onMsg)
        resolve(true)
      }
    }
    window.addEventListener('message', onMsg)
    deliverMembershipToExtension(token)
    setTimeout(() => {
      if (done) return
      window.removeEventListener('message', onMsg)
      resolve(false)
    }, timeoutMs)
  })
}

function post(token: string): void {
  try {
    window.postMessage({ source: 'lortnoc-app', type: 'MEMBERSHIP', token }, window.location.origin)
  } catch {
    // no extension / postMessage blocked — the caller still has the token to show
  }
}
