// Test harness primitives. Deliberately dependency-free (node:test + node:assert are
// built in), matching the repo's no-deps posture — the codec is stdlib Python, the
// extension ships three noble packages and nothing else.
//
// The ONE rule these helpers exist to enforce: tests IMPORT THE REAL SOURCE. The previous
// suite re-implemented crypto.ts inside the test file, so it kept passing against a
// passphrase key-derivation that had been deleted from the product months earlier. A test
// that re-implements its subject cannot fail when the subject changes.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// ---------------------------------------------------------------------------
// chrome.* stub — enough of MV3 for the content-script modules that touch storage.
// storage.session and storage.local are separate namespaces on purpose: session.ts
// relies on `session` being wiped on browser close while metering.ts relies on `local`
// surviving it, and a stub that conflated them would hide a real regression.
// ---------------------------------------------------------------------------
export function installChromeStub() {
  const areas = { local: new Map(), session: new Map(), sync: new Map() }
  const listeners = []

  const mkArea = (name) => ({
    async get(keys) {
      const m = areas[name]
      if (keys == null) return Object.fromEntries(m)
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
      const out = {}
      for (const k of list) if (m.has(k)) out[k] = m.get(k)
      return out
    },
    async set(obj) {
      const m = areas[name]
      const changes = {}
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: m.get(k), newValue: v }
        // Structured-clone the value: chrome.storage serialises, so a test that mutates
        // the object it stored must not retroactively change what was persisted.
        m.set(k, structuredClone(v))
      }
      for (const fn of listeners) fn(changes, name)
    },
    async remove(key) {
      areas[name].delete(key)
    },
    async clear() {
      areas[name].clear()
    },
  })

  const chrome = {
    storage: {
      local: mkArea('local'),
      session: mkArea('session'),
      sync: mkArea('sync'),
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    runtime: {
      id: 'test-extension-id',
      lastError: undefined,
      onMessage: { addListener: () => {} },
      sendMessage: async () => ({ ok: false, error: 'no service worker in unit tests' }),
      getURL: (p) => `chrome-extension://test-extension-id/${p}`,
    },
  }

  globalThis.chrome = chrome
  return {
    chrome,
    /** Reset all storage between tests without re-importing modules (which cache state). */
    reset() {
      for (const a of Object.values(areas)) a.clear()
    },
    peek: (area, key) => areas[area].get(key),
  }
}

// ---------------------------------------------------------------------------
// Codec client — the same HTTP surface background/index.ts speaks.
// ---------------------------------------------------------------------------
export const CODEC = process.env.CODEC || 'http://127.0.0.1:8080'

/** Is a codec reachable? Integration tests skip (not fail) when it isn't, so `npm test`
 *  stays green on a laptop with no Python process running. CI runs it with one up. */
export async function codecUp(timeoutMs = 1500) {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    const r = await fetch(`${CODEC}/health`, { signal: ac.signal })
    clearTimeout(t)
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

export async function codecEncode(ciphertextB64, opts = {}) {
  const r = await fetch(`${CODEC}/encode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ciphertext: ciphertextB64, ...opts }),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

export async function codecDecode(coverText) {
  const r = await fetch(`${CODEC}/decode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coverText }),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
export const toB64 = (u) => Buffer.from(u).toString('base64')
export const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'))
export const hex = (u) => Buffer.from(u).toString('hex')
export const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b))

/** Read a source file as text — used by the invariant tests, which assert on the shape of
 *  the code itself (e.g. "no plaintext is ever POSTed") rather than its behaviour. */
export function source(relPath) {
  const p = resolve(ROOT, relPath)
  if (!existsSync(p)) throw new Error(`source() — no such file: ${relPath}`)
  return readFileSync(p, 'utf8')
}
