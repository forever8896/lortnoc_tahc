// Keyring sessions — what a reader has CONNECTED, proven once, for sealed posts (shared/sealed.mjs).
//
// A sealed post says nothing about what it needs, so a reader cannot prove World ID "for this post":
// they connect what they have once — World ID (human / selfie / a nationality), wallets — and the
// gate answers every later unlock against that. The session is a bearer token the extension keeps;
// the gate keeps only sha256(token) → claims:
//   { poh?, selfie?: nullifier, nat?: { DNK: nullifier }, wallets?: [address], exp }
// Nullifiers are per-action pseudonyms, not identities; they are what space membership and bans key
// on. Nothing else about the reader is stored — no IP, no name, no document data.
//
// Honest limits: a stolen token reads what its owner can for up to TTL; the gate learns which of its
// posts a reader's page showed (unlock asks about every candidate on the page).
import { sha256 } from '@noble/hashes/sha2.js'
import { toHex } from '../shared/keys.mjs'
import { COUNTRY_RE } from './world.mjs'
import { connectText, walletSigned } from './holders.mjs'
import { httpError } from './core-errors.mjs'

export const TTL_MS = 24 * 3600_000
export const CONNECT_ACTION = 'lortnoc-connect'
const HEX64 = /^[0-9a-f]{64}$/
const hash = (token) => toHex(sha256(new TextEncoder().encode(String(token))))

export function createKeyring(db, { world = null, now = () => Date.now() } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, claims TEXT NOT NULL, expires_at INTEGER NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS connect_state (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL)`)
  const state = {
    get: (k) => db.prepare('SELECT v FROM connect_state WHERE k = ?').get(k)?.v,
    set: (k, v) => db.prepare('INSERT OR REPLACE INTO connect_state (k, v, at) VALUES (?, ?, ?)').run(k, String(v), now()),
  }

  /** Claims for a token, or {} (expired, unknown or none). */
  function claimsOf(token) {
    if (!token) return {}
    const row = db.prepare('SELECT claims, expires_at FROM sessions WHERE token_hash = ?').get(hash(token))
    return row && row.expires_at > now() ? JSON.parse(row.claims) : {}
  }
  /** Merge new claims into the session (creating it), return {token, claims}. */
  function grant(token, add) {
    const t = token && db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(hash(token)) ? token : toHex(crypto.getRandomValues(new Uint8Array(32)))
    const c = claimsOf(t)
    const merged = { ...c, ...add, nat: { ...(c.nat ?? {}), ...(add.nat ?? {}) }, wallets: [...new Set([...(c.wallets ?? []), ...(add.wallets ?? [])])] }
    db.prepare('INSERT OR REPLACE INTO sessions (token_hash, claims, expires_at) VALUES (?, ?, ?)').run(hash(t), JSON.stringify(merged), now() + TTL_MS)
    return { token: t, claims: summary(merged) }
  }
  /** What the extension may show: which credentials are connected — never a nullifier. */
  const summary = (c) => ({
    human: !!c.poh, selfie: !!c.selfie, nationalities: Object.keys(c.nat ?? {}), wallets: c.wallets ?? [],
  })

  return {
    claimsOf,
    session: ({ token }) => ({ claims: summary(claimsOf(token)) }),
    forget: ({ token }) => (db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token ?? '')), { ok: true }),

    /** World ID, once: a request for this reader's keyring key. kind = poh | selfie | nationality. */
    worldChallenge({ kind, country, env, readerPub }) {
      if (!world) return { deny: 'World ID is not configured on this gate' }
      if (!HEX64.test(readerPub ?? '')) throw httpError(400, 'bad readerPub')
      const preset = kind === 'nationality' ? 'identity' : kind
      if (!['poh', 'selfie', 'identity'].includes(preset)) throw httpError(400, 'bad kind')
      if (preset === 'identity' && !COUNTRY_RE.test(country ?? '')) throw httpError(400, 'nationality needs a 3-letter country code')
      const sid = toHex(crypto.getRandomValues(new Uint8Array(8)))
      state.set(`sid:${sid}`, JSON.stringify({ preset, country, readerPub }))
      return { sid, request: world.challenge(sid, readerPub, state, preset, CONNECT_ACTION, country, env) }
    },
    async worldConnect({ sid, readerPub, proof, token }) {
      if (!world) return { deny: 'World ID is not configured on this gate' }
      const s = state.get(`sid:${sid}`)
      if (!s) return { deny: 'unknown request' }
      const { preset, country, readerPub: want } = JSON.parse(s)
      if (want !== readerPub) return { deny: 'this request was made for another key' }
      const v = await world.verify(proof, { ref: sid, readerPub, preset, action: CONNECT_ACTION }, state)
      if (!v.ok) return v
      return grant(token, preset === 'identity' ? { nat: { [country]: v.nullifier } } : { [preset]: v.nullifier })
    },

    /** A wallet, once: sign a message naming this reader's keyring key and a single-use nonce. */
    walletChallenge({ readerPub }) {
      if (!HEX64.test(readerPub ?? '')) throw httpError(400, 'bad readerPub')
      const nonce = crypto.randomUUID()
      state.set(`wallet:${nonce}`, JSON.stringify({ readerPub, at: now() }))
      return { nonce, message: connectText(readerPub, nonce) }
    },
    async walletConnect({ nonce, address, sig, token }) {
      const s = state.get(`wallet:${nonce}`)
      if (!s) return { deny: 'challenge was not issued by this gate' }
      const n = JSON.parse(s)
      if (n.used) return { deny: 'challenge already used' }
      if (now() - n.at > 10 * 60_000) return { deny: 'challenge expired' }
      state.set(`wallet:${nonce}`, JSON.stringify({ ...n, used: true }))
      if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '')) return { deny: 'bad address' }
      if (!(await walletSigned({ message: connectText(n.readerPub, nonce), address, sig }))) return { deny: 'the signature is not from that wallet' }
      return grant(token, { wallets: [address.toLowerCase()] })
    },
  }
}
