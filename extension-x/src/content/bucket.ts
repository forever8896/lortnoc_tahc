// The metering bucket key (CLAUDE.md §9) — who the codec counts free sends against.
//
// This exists because leaving it out is not "no metering", it is metering EVERYONE TOGETHER. The
// hosted codec enforces a free limit and buckets by the `handle` field; a request that omits it
// lands in `auth.py`'s `_ANON` bucket, so every install on earth would share one 10-send
// allowance and the eleventh send by anyone would 402 for everybody.
//
// §9 says meter by the logged-in handle, and X actually surfaces it in the DOM — unlike Telegram
// Web K, where the Telegram build had to fall back to a persisted per-install id. We use the
// handle when we can read it and that same per-install fallback when we cannot.
//
// HONEST: this is client-asserted, exactly as §9 says. It raises the cost of cheating from
// "clear a counter" to "make another X account"; it is not an enforcement boundary.
import { LOCAL } from '../shared/config'

/** The logged-in X username from the profile link, or null. */
function xUsername(): string | null {
  const link = document.querySelector<HTMLAnchorElement>('[data-testid="AppTabBar_Profile_Link"]')
  const href = link?.getAttribute('href') ?? ''
  const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/)
  return m ? m[1].toLowerCase() : null
}

let cached: string | null = null

/** Where the RESOLVED bucket is stored, so contexts without the X DOM can reuse it.
 *  The popup's self-test runs in the extension popup, where there is no timeline to read a
 *  username from — without this it would meter against a different bucket than real sends and
 *  report a quota that is not the one that matters. */
const RESOLVED = 'bucketResolved'

/** The bucket the content script last resolved, or null. Safe to call from the popup. */
export async function resolvedBucket(): Promise<string | null> {
  const got = await chrome.storage.local.get(RESOLVED)
  return (got[RESOLVED] as string) ?? null
}

/** `x:<username>` when detectable, else a persisted `inst:<id>`. Cached for the session. */
export async function meteringBucket(): Promise<string> {
  if (cached) return cached
  const user = xUsername()
  if (user) {
    cached = `x:${user}`
    await chrome.storage.local.set({ [RESOLVED]: cached })
    return cached
  }
  const got = await chrome.storage.local.get(LOCAL.bucket)
  let id = got[LOCAL.bucket] as string | undefined
  if (!id) {
    id = (crypto.randomUUID?.() ?? `${Date.now()}${Math.random().toString(36).slice(2)}`).slice(0, 24)
    await chrome.storage.local.set({ [LOCAL.bucket]: id })
  }
  cached = `inst:${id}`
  await chrome.storage.local.set({ [RESOLVED]: cached })
  return cached
}
