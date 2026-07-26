// Best-effort stable identifier for the logged-in Telegram account — the freemium metering
// bucket (§9). Web K doesn't surface @username reliably in the DOM, but tweb persists the
// self account id in localStorage; a stable numeric account id is a *better* bucket key than
// a handle anyway (doesn't change, one per Telegram account → farming costs a new account).
//
// HONEST: this is client-asserted — a determined user can spoof or clear it. It raises the
// cost of cheating from "clear one counter" to "spin up Telegram accounts"; the real
// enforcement is server-side (the codec counts per bucket, §7). If no Telegram id is found
// we fall back to a persisted per-install id (weaker: clearing extension storage resets it).
import { LOCAL } from '../shared/config'

/** Scan localStorage for tweb's user_auth-shaped object: { id, dcID|date, ... }. */
function telegramAccountId(): string | null {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k) continue
      const raw = localStorage.getItem(k)
      if (!raw || raw[0] !== '{') continue
      let obj: unknown
      try {
        obj = JSON.parse(raw)
      } catch {
        continue
      }
      if (obj && typeof obj === 'object') {
        const o = obj as Record<string, unknown>
        const id = o.id ?? o.userId ?? o.user_id
        if ((typeof id === 'number' || typeof id === 'string') && ('dcID' in o || 'dc_id' in o || 'date' in o)) {
          return String(id)
        }
      }
    }
  } catch {
    // localStorage blocked — fall through to the per-install id
  }
  return null
}

let cached: string | null = null

/** Resolve the metering bucket key: `tg:<accountId>` when detectable, else a persisted
 *  `inst:<uuid>`. Cached for the session. */
export async function getSelfHandle(): Promise<string> {
  if (cached) return cached
  const tg = telegramAccountId()
  if (tg) {
    cached = `tg:${tg}`
    return cached
  }
  // Fallback: a stable per-install id, generated once and persisted.
  const got = await chrome.storage.local.get(LOCAL.bucket)
  let id = got[LOCAL.bucket] as string | undefined
  if (!id) {
    id = (crypto.randomUUID?.() ?? String(Date.now()) + Math.random().toString(36).slice(2)).slice(0, 24)
    await chrome.storage.local.set({ [LOCAL.bucket]: id })
  }
  cached = `inst:${id}`
  return cached
}
