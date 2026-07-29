// POST /api/waitlist  { email, company? }  -> 204
//
// Single opt-in by decision (docs/LAUNCH-PLAN.md §3.4): no confirmation step, no friction. The
// MX check in validEmail is the mitigation that keeps the list mailable.
import { init, rateLimited, validEmail, json, readBody, isBot } from './_lib/db.js'
import { sql } from '@vercel/postgres'

export const config = { runtime: 'nodejs' } // needs dns for the MX lookup

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  const body = readBody(req)

  // Honeypot: answer exactly as we would on success, so a bot cannot tell it was caught.
  if (isBot(body)) return json(res, 204)

  try {
    await init()

    if (await rateLimited(req, 'waitlist', 5, 10)) {
      return json(res, 429, { error: 'Too many signups from here — try again shortly.' })
    }

    const email = String(body.email || '').trim().toLowerCase()
    if (!(await validEmail(email))) {
      return json(res, 400, { error: 'That address does not look like it can receive mail.' })
    }

    const source = String(body.source || '').slice(0, 120) || null

    // Upsert, never error on duplicate. Telling someone "you are already on the list" leaks
    // membership of the list to anyone who can guess an address.
    await sql`INSERT INTO waitlist (email, source) VALUES (${email}, ${source})
              ON CONFLICT (email) DO NOTHING`

    return json(res, 204)
  } catch (e) {
    console.error('[waitlist]', e?.message)
    return json(res, 500, { error: 'Could not record that just now.' })
  }
}
