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

// ---- Telegram @username (for prefilling the app's claim field) --------------------------------
// The metering id above is a stable NUMBER; for a prefilled handle we want the human @username.
// Web K doesn't put it in the DOM, but tweb caches user records — try localStorage first (cheap),
// then a bounded IndexedDB scan. Best-effort: returns null (no prefill) rather than ever throwing.
let unameTried = false
let unameCache: string | null = null

/** Pull a `username` string off the self user record, matched by our own account id. */
function usernameFromLocalStorage(selfId: string | null): string | null {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const raw = localStorage.getItem(localStorage.key(i) ?? '')
      if (!raw || raw[0] !== '{') continue
      let o: Record<string, unknown>
      try {
        o = JSON.parse(raw)
      } catch {
        continue
      }
      const uname = o.username
      const idMatches = selfId != null && String(o.id ?? '') === selfId
      if (typeof uname === 'string' && uname && (idMatches || 'dcID' in o || 'date' in o)) return uname
    }
  } catch {
    /* blocked */
  }
  return null
}

/** Bounded scan of one IndexedDB store for a record `{ id === selfId, username }`. */
function usernameFromStore(db: IDBDatabase, store: string, selfId: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const req = db.transaction(store, 'readonly').objectStore(store).openCursor()
      let seen = 0
      req.onsuccess = () => {
        const cur = req.result
        if (!cur || seen++ > 4000) return resolve(null)
        const v = cur.value as Record<string, unknown> | null
        if (v && typeof v.username === 'string' && v.username && String(v.id ?? '') === selfId) {
          return resolve(v.username)
        }
        cur.continue()
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function openDb(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(name)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** Best-effort Telegram @username of the logged-in account, or null. Cached per session. */
export async function getTelegramUsername(): Promise<string | null> {
  if (unameTried) return unameCache
  unameTried = true
  const selfId = telegramAccountId()
  const fromLs = usernameFromLocalStorage(selfId)
  if (fromLs) return (unameCache = fromLs)
  if (!selfId || !('databases' in indexedDB)) return unameCache
  try {
    const dbs = await indexedDB.databases()
    for (const info of dbs) {
      if (!info.name) continue
      const db = await openDb(info.name)
      if (!db) continue
      try {
        for (const store of Array.from(db.objectStoreNames)) {
          const u = await usernameFromStore(db, store, selfId)
          if (u) {
            db.close()
            return (unameCache = u)
          }
        }
      } finally {
        db.close()
      }
    }
  } catch {
    /* ignore — no prefill */
  }
  return unameCache
}
