// Shared storage for the signup endpoints. Vercel Postgres (Neon under the hood).
//
// Files under api/ whose name starts with `_` are not routed as functions, so this is a private
// module rather than a public endpoint.
//
// Design notes worth keeping in mind when editing:
//
//   * NO RAW IP IS EVER STORED. The site publishes a gateway-hygiene claim (CLAUDE.md §8 Layer 4:
//     "structural: the gateway *can't* link; policy: it *doesn't* retain"). Logging IPs on the
//     signup form would contradict something we say in public. Rate limiting therefore keys on a
//     salted hash with a short window, and the rows are purged.
//   * The alpha table holds Telegram handles of people who publicly expressed interest in evading
//     chat surveillance. Treat it as sensitive: collect the minimum, delete on onboarding.
import { neon } from '@neondatabase/serverless'
import { createHash, timingSafeEqual } from 'node:crypto'
import { promises as dns } from 'node:dns'

/** Bumped whenever the alpha disclaimer text changes, so a record says what was agreed to. */
export const DISCLAIMER_VERSION = '2026-07-29.1'

/**
 * The one database handle, exported so the endpoints never build their own.
 *
 * Neon's driver, not `@vercel/postgres` — the latter is deprecated, and the store Vercel
 * provisions today IS Neon (it injects DATABASE_URL / POSTGRES_URL and a NEON_PROJECT_ID).
 *
 * ⚠️ Difference that will bite when editing: this tagged template resolves to the ROWS ARRAY
 * directly, where `@vercel/postgres` resolved to `{ rows }`. Destructuring `{ rows }` off it
 * yields undefined rather than an error.
 */
export const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL)

let ready = null

/** Create tables on first use. Cheap, idempotent, and avoids a separate migration step. */
export async function init() {
  if (ready) return ready
  ready = (async () => {
    await sql`CREATE TABLE IF NOT EXISTS waitlist (
      id          SERIAL PRIMARY KEY,
      email       TEXT NOT NULL UNIQUE,
      telegram    TEXT,
      source      TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`
    // The table shipped before the handle was collected, so CREATE TABLE IF NOT EXISTS alone
    // would leave existing deployments without the column.
    await sql`ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS telegram TEXT`
    await sql`CREATE TABLE IF NOT EXISTS alpha (
      id           SERIAL PRIMARY KEY,
      telegram     TEXT NOT NULL UNIQUE,
      message      TEXT,
      agreed_at    TIMESTAMPTZ NOT NULL,
      disclaimer   TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'new',
      source       TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`
    await sql`CREATE TABLE IF NOT EXISTS rate_limit (
      bucket       TEXT PRIMARY KEY,
      count        INT NOT NULL DEFAULT 1,
      window_start TIMESTAMPTZ NOT NULL DEFAULT now()
    )`
  })()
  return ready
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Salted, truncated hash of the caller — never the address itself.
 *
 * RATE_SALT should be set to a random value and rotated periodically; rotating it invalidates
 * every existing bucket, which is the point. Without it we fall back to a build-stable constant
 * so local dev works, but production should set one.
 */
function bucketOf(req, scope) {
  const fwd = req.headers['x-forwarded-for'] || ''
  const ip = String(fwd).split(',')[0].trim() || 'unknown'
  const salt = process.env.RATE_SALT || 'lortnoc-dev-salt'
  return createHash('sha256').update(`${salt}:${scope}:${ip}`).digest('hex').slice(0, 32)
}

/** True if this caller is over the limit. Window is fixed, not sliding — good enough here. */
export async function rateLimited(req, scope, max = 5, windowMinutes = 10) {
  const bucket = bucketOf(req, scope)
  const rows = await sql`
    INSERT INTO rate_limit (bucket, count, window_start)
    VALUES (${bucket}, 1, now())
    ON CONFLICT (bucket) DO UPDATE SET
      count        = CASE WHEN rate_limit.window_start < now() - (${windowMinutes} * INTERVAL '1 minute')
                          THEN 1 ELSE rate_limit.count + 1 END,
      window_start = CASE WHEN rate_limit.window_start < now() - (${windowMinutes} * INTERVAL '1 minute')
                          THEN now() ELSE rate_limit.window_start END
    RETURNING count`
  // Opportunistic cleanup: keeps the table from growing without a cron.
  if (Math.random() < 0.02) {
    await sql`DELETE FROM rate_limit WHERE window_start < now() - INTERVAL '1 day'`
  }
  return (rows[0]?.count ?? 1) > max
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Email validation with a real MX lookup.
 *
 * Single opt-in was a deliberate product decision (no confirmation step, no friction). The cost
 * of that is bounces and spam complaints on the first send, which is what burns a sending domain
 * — at which point the list is worthless because you cannot reach it. An MX check removes typos
 * and junk domains at submit time and costs the user nothing.
 */
export async function validEmail(email) {
  if (typeof email !== 'string') return false
  const e = email.trim()
  if (e.length < 6 || e.length > 254) return false
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return false
  try {
    const mx = await dns.resolveMx(e.split('@')[1])
    return Array.isArray(mx) && mx.length > 0
  } catch {
    return false // no MX -> cannot receive mail
  }
}

/** Telegram handles: 5–32 chars, letters/digits/underscore. Stored without the leading @. */
export function normaliseTelegram(handle) {
  if (typeof handle !== 'string') return null
  const h = handle.trim().replace(/^@+/, '')
  return /^[a-zA-Z0-9_]{5,32}$/.test(h) ? h.toLowerCase() : null
}

// ---------------------------------------------------------------------------
// Admin auth
// ---------------------------------------------------------------------------

/**
 * Bearer-token check against ADMIN_TOKEN, compared in constant time.
 *
 * Deliberately not "an unguessable URL": this route lists Telegram handles of people interested
 * in a surveillance-evasion tool, and obscurity is not a control. If ADMIN_TOKEN is unset the
 * route denies everything rather than defaulting open.
 */
export function authorised(req) {
  const expected = process.env.ADMIN_TOKEN || ''
  if (!expected) return false
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(got)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json')
  res.end(body === undefined ? '' : JSON.stringify(body))
}

/** Vercel parses JSON bodies already; this tolerates a string body too. */
export function readBody(req) {
  if (!req.body) return {}
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return {} }
  }
  return req.body
}

/** A filled honeypot means a bot. Answer 204 anyway so it learns nothing. */
export const isBot = (body) => Boolean(body && String(body.company || '').trim())
