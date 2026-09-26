// The gate — holds key shares for attested checks and releases them to readers who pass
// (docs/PRD-universal.md §5, §16.2). This file is the logic; server.mjs is only HTTP around it, so
// the tests exercise exactly this code with no network.
//
// It is GENERIC: it knows deposits and releases, and asks the check module (shared/checks/*) whether
// a release is allowed. A new attested check needs no change here.
//
// What it stores per deposit: the check id, the check's params AS DEPOSITED, the share, the policy
// hash. What it never stores: IP addresses, the post, the message, who read it (a check may keep
// its own per-post state, e.g. World ID nullifiers — that is the check's documented choice).
//
// THE DECISION IS MADE AGAINST WHAT WAS STORED, never against what the reader's copy of the post
// claims. A post can be edited to say "opens after 1970"; the gate still answers from its row.
import { DatabaseSync } from 'node:sqlite'
import { CHECKS } from '../shared/checks/index.mjs'
import { sealTo, openBox, publicKeyOf, CTX } from '../shared/gatebox.mjs'
import { genKeyPair, toHex, fromHex } from '../shared/keys.mjs'
import { signerFrom } from '../shared/member.mjs'
import { httpError } from './core-errors.mjs'
import { createSpaces } from './spaces.mjs'

export const REF_LEN = 8
const MAX_PARAMS_BYTES = 2048

export function createGate({ dbPath = ':memory:', keyHex, world = null } = {}) {
  const services = { world }
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE IF NOT EXISTS deposits (
    ref TEXT PRIMARY KEY, check_id TEXT NOT NULL, params TEXT NOT NULL,
    share TEXT NOT NULL, policy_hash TEXT NOT NULL, created_at INTEGER NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS gate_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS check_state (check_id TEXT, ref TEXT, k TEXT, v TEXT, PRIMARY KEY (check_id, ref, k))`)

  // The gate's own X25519 key: from the environment, else persisted in the database, else new.
  let priv = keyHex ? fromHex(keyHex) : null
  if (!priv) {
    const row = db.prepare('SELECT v FROM gate_state WHERE k = ?').get('priv')
    priv = row ? fromHex(row.v) : genKeyPair().priv
    if (!row) db.prepare('INSERT INTO gate_state (k, v) VALUES (?, ?)').run('priv', toHex(priv))
  }
  const pub = publicKeyOf(priv)
  const signer = signerFrom(priv)
  const spaces = createSpaces(db, { secret: signer.secret, signPriv: signer.priv })
  services.spaces = spaces

  /** Per-check durable state (e.g. spent nullifiers), namespaced so checks cannot collide. */
  const stateFor = (checkId, ref) => ({
    get: (k) => db.prepare('SELECT v FROM check_state WHERE check_id = ? AND ref = ? AND k = ?').get(checkId, ref, k)?.v,
    set: (k, v) => db.prepare('INSERT OR REPLACE INTO check_state (check_id, ref, k, v) VALUES (?, ?, ?, ?)').run(checkId, ref, k, String(v)),
    count: () => db.prepare('SELECT COUNT(*) AS n FROM check_state WHERE check_id = ? AND ref = ?').get(checkId, ref).n,
  })

  return {
    pub: toHex(pub),
    /** Ed25519 key readers use to verify "verified member" attestations. */
    signPub: signer.pub,
    spaces,
    checks: Object.values(CHECKS).filter((m) => m.kind === 'attested' && (m.id !== 'human' || world)).map((m) => m.id),
    world: world ? { env: world.env } : null,

    /**
     * @param {{check: string, params: object, box: {eph,ct}, policyHash: string}} req
     * @returns {{ref: string}} hex reference the post will carry
     */
    deposit(req) {
      const m = CHECKS[req?.check]
      if (!m || m.kind !== 'attested' || !m.gate) throw httpError(400, 'unknown attested check')
      if (JSON.stringify(req.params ?? {}).length > MAX_PARAMS_BYTES) throw httpError(400, 'params too large')
      if (!/^[0-9a-f]{64}$/.test(req.policyHash ?? '')) throw httpError(400, 'bad policyHash')
      m.validate?.(req.params)
      const share = openBox(priv, pub, req.box ?? {}, CTX.deposit)
      if (!share || share.length !== 16) throw httpError(400, 'share not sealed to this gate')
      const ref = toHex(crypto.getRandomValues(new Uint8Array(REF_LEN)))
      db.prepare('INSERT INTO deposits VALUES (?, ?, ?, ?, ?, ?)').run(
        ref, m.id, JSON.stringify(req.params), toHex(share), req.policyHash, Date.now())
      return { ref }
    },

    /**
     * @param {{ref: string, readerPub: string, policyHash: string, proof?: object}} req
     * @returns {Promise<{box: {eph,ct}} | {deny: string, retryAt?: number}>}
     */
    /**
     * Some attested checks need a round trip before the reader can prove anything — World ID must sign
     * a request bound to this post and reader first. Checks without `gate.challenge` do not use it.
     * @param {{ref: string, readerPub: string, policyHash: string}} req
     */
    challenge(req) {
      if (!/^[0-9a-f]{16}$/.test(req?.ref ?? '')) throw httpError(400, 'bad ref')
      if (!/^[0-9a-f]{64}$/.test(req.readerPub ?? '')) throw httpError(400, 'bad readerPub')
      const row = db.prepare('SELECT * FROM deposits WHERE ref = ?').get(req.ref)
      if (!row) return { deny: 'unknown reference' }
      if (row.policy_hash !== req.policyHash) return { deny: 'reference does not belong to this post' }
      const m = CHECKS[row.check_id]
      if (!m.gate.challenge) return { deny: 'this check needs no challenge' }
      const stored = { check: row.check_id, params: JSON.parse(row.params), ref: row.ref, policyHash: row.policy_hash }
      return m.gate.challenge(stored, req, stateFor(row.check_id, row.ref), services)
    },

    async release(req) {
      if (!/^[0-9a-f]{16}$/.test(req?.ref ?? '')) throw httpError(400, 'bad ref')
      if (!/^[0-9a-f]{64}$/.test(req.readerPub ?? '')) throw httpError(400, 'bad readerPub')
      const row = db.prepare('SELECT * FROM deposits WHERE ref = ?').get(req.ref)
      if (!row) return { deny: 'unknown reference' }
      // A reference only opens the post it was deposited for — pasting it into another post's shape
      // gets nothing (and the share would be useless there anyway: it is a share of THAT post's key).
      if (row.policy_hash !== req.policyHash) return { deny: 'reference does not belong to this post' }
      const m = CHECKS[row.check_id]
      const stored = { check: row.check_id, params: JSON.parse(row.params), ref: row.ref, policyHash: row.policy_hash }
      const verdict = await m.gate.release(stored, req, stateFor(row.check_id, row.ref), services)
      const ok = verdict === true || verdict?.ok === true
      if (!ok) return typeof verdict === 'object' ? verdict : { deny: 'refused' }
      return { box: sealTo(req.readerPub, fromHex(row.share), CTX.release), ...(verdict.member ? { member: verdict.member } : {}) }
    },

    stats() {
      return db.prepare('SELECT check_id, COUNT(*) AS n FROM deposits GROUP BY check_id').all()
    },
    close: () => db.close(),
  }
}

export { httpError }
