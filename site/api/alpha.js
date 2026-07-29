// POST /api/alpha  { telegram, message?, agreedAt, company? }  -> 204
//
// Stores the Telegram handle of someone who wants early access, plus which version of the
// disclaimer they agreed to and when. Nothing else: no email, no wallet, no name.
//
// This table is the sensitive one. It is a list of people who publicly expressed interest in
// evading chat surveillance, indexed by an identifier that resolves to a real person, in the
// jurisdiction that produced Chat Control. Collect the minimum and delete on onboarding.
import { init, rateLimited, normaliseTelegram, json, readBody, isBot, DISCLAIMER_VERSION, sql } from './_lib/db.js'

export const config = { runtime: 'nodejs' }

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })

  const body = readBody(req)
  if (isBot(body)) return json(res, 204)

  try {
    await init()

    if (await rateLimited(req, 'alpha', 3, 10)) {
      return json(res, 429, { error: 'Too many signups from here — try again shortly.' })
    }

    const telegram = normaliseTelegram(body.telegram)
    if (!telegram) {
      return json(res, 400, { error: 'Telegram handles are 5–32 characters: letters, numbers and underscores.' })
    }

    // The consent record. agreedAt comes from the client so it reflects when they actually ticked
    // the box; an implausible value falls back to now() rather than being trusted.
    const t = Date.parse(body.agreedAt)
    const agreedAt = Number.isFinite(t) && Math.abs(Date.now() - t) < 86_400_000
      ? new Date(t).toISOString()
      : new Date().toISOString()

    const message = String(body.message || '').trim().slice(0, 500) || null
    const source = String(body.source || '').slice(0, 120) || null

    // Re-signup updates the message rather than erroring — same reasoning as the waitlist, and it
    // lets someone add context later. Status is left alone so an invite is not undone.
    await sql`
      INSERT INTO alpha (telegram, message, agreed_at, disclaimer, source)
      VALUES (${telegram}, ${message}, ${agreedAt}, ${DISCLAIMER_VERSION}, ${source})
      ON CONFLICT (telegram) DO UPDATE
        SET message    = COALESCE(EXCLUDED.message, alpha.message),
            agreed_at  = EXCLUDED.agreed_at,
            disclaimer = EXCLUDED.disclaimer`

    return json(res, 204)
  } catch (e) {
    console.error('[alpha]', e?.message)
    return json(res, 500, { error: 'Could not record that just now.' })
  }
}
