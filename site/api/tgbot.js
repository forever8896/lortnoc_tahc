// POST /api/tgbot — Telegram webhook for the Lortnoc Tahc onboarding bot.
//
// Telegram delivers each update here; the conversation itself lives in _lib/bot.js. This file is
// only I/O: authenticate the caller, talk to the Bot API, read and write the bot_users table.
//
// Env:
//   TG_BOT_TOKEN        from @BotFather
//   TG_WEBHOOK_SECRET   random string; Telegram echoes it in X-Telegram-Bot-Api-Secret-Token.
//                       Without this check anyone could POST fake updates and write rows.
//   TG_ADMIN_CHAT_ID    optional — where "I'm stuck" messages get forwarded so a human sees them
//   X_EXT_RELEASE_URL   optional — the X extension's release page
import { timingSafeEqual } from 'node:crypto'
import { init, sql, json, readBody } from './_lib/db.js'
import { handleUpdate } from './_lib/bot.js'

export const config = { runtime: 'nodejs' }

const REPO = 'https://github.com/forever8896/lortnoc_tahc'
const cfg = {
  releaseUrl: process.env.X_EXT_RELEASE_URL || `${REPO}/releases/tag/x-v0.1.0`,
  repoUrl: REPO,
  siteUrl: 'https://www.lortnoctahc.com',
}

function secretOk(req) {
  const want = process.env.TG_WEBHOOK_SECRET || ''
  const got = String(req.headers['x-telegram-bot-api-secret-token'] || '')
  if (!want || got.length !== want.length) return false
  return timingSafeEqual(Buffer.from(got), Buffer.from(want))
}

async function api(method, params) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  const body = await r.json().catch(() => ({ ok: false }))
  // "message is not modified" is Telegram's answer to a double-tap on the same button — not an error.
  if (!body.ok && !/not modified/i.test(body.description || '')) {
    console.warn(`[tgbot] ${method} failed:`, body.description)
  }
  return body
}

const store = {
  // Username can change or be absent (not everyone sets one); the numeric id is the stable key.
  // `source` is only ever written once, so a later bare /start doesn't overwrite "site".
  async seen(u, source) {
    await sql`INSERT INTO bot_users (tg_id, username, source)
              VALUES (${u.id}, ${u.username || null}, ${source})
              ON CONFLICT (tg_id) DO UPDATE SET
                username  = EXCLUDED.username,
                source    = COALESCE(bot_users.source, EXCLUDED.source),
                last_seen = now()`
  },
  async step(id, step) {
    await sql`UPDATE bot_users SET step = ${step} WHERE tg_id = ${id}`
  },
  async forget(id) {
    await sql`DELETE FROM bot_users WHERE tg_id = ${id}`
  },
  async note(id, text) {
    const rows = await sql`UPDATE bot_users SET last_message = ${text} WHERE tg_id = ${id} RETURNING username`
    const admin = process.env.TG_ADMIN_CHAT_ID
    if (admin) {
      const who = rows[0]?.username ? `@${rows[0].username}` : `id ${id}`
      await api('sendMessage', { chat_id: admin, text: `Bot help request from ${who}:\n\n${text}` })
    }
  },
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
  if (!secretOk(req)) return json(res, 401, { error: 'unauthorised' })
  try {
    await init()
    await handleUpdate(readBody(req), { api, store, cfg })
  } catch (e) {
    // Still answer 200: a non-2xx makes Telegram redeliver the same update in a loop.
    console.error('[tgbot] update failed:', e)
  }
  return json(res, 200, { ok: true })
}
