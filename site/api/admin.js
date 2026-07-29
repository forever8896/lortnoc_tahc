// Admin API. Everything here is behind a constant-time bearer check against ADMIN_TOKEN.
//
//   GET    /api/admin                      -> { waitlist: [...], alpha: [...], counts }
//   GET    /api/admin?export=waitlist      -> CSV
//   GET    /api/admin?export=alpha         -> CSV
//   PATCH  /api/admin  { table:'alpha', id, status }   -> 204
//   DELETE /api/admin  { table, id }                   -> 204
//
// One route rather than four files: the surface is small, and fewer entry points to a sensitive
// dataset is easier to reason about than a tidy REST tree.
import { init, authorised, json, readBody } from './_lib/db.js'
import { sql } from '@vercel/postgres'

export const config = { runtime: 'nodejs' }

const ALPHA_STATUSES = ['new', 'invited', 'onboarded']

function csv(rows) {
  if (!rows.length) return ''
  const cols = Object.keys(rows[0])
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n')
}

export default async function handler(req, res) {
  // Deny before touching the database, and never hint at why.
  if (!authorised(req)) return json(res, 401, { error: 'unauthorised' })

  try {
    await init()

    if (req.method === 'GET') {
      const which = String(req.query?.export || '')
      if (which === 'waitlist' || which === 'alpha') {
        const { rows } = which === 'waitlist'
          ? await sql`SELECT email, source, created_at FROM waitlist ORDER BY created_at DESC`
          : await sql`SELECT telegram, status, message, agreed_at, disclaimer, source, created_at
                      FROM alpha ORDER BY created_at DESC`
        res.status(200)
        res.setHeader('Content-Type', 'text/csv; charset=utf-8')
        res.setHeader('Content-Disposition', `attachment; filename="${which}.csv"`)
        return res.end(csv(rows))
      }

      const [w, a] = await Promise.all([
        sql`SELECT id, email, source, created_at FROM waitlist ORDER BY created_at DESC LIMIT 1000`,
        sql`SELECT id, telegram, status, message, agreed_at, disclaimer, source, created_at
            FROM alpha ORDER BY created_at DESC LIMIT 1000`,
      ])
      return json(res, 200, {
        waitlist: w.rows,
        alpha: a.rows,
        counts: {
          waitlist: w.rows.length,
          alpha: a.rows.length,
          new: a.rows.filter((r) => r.status === 'new').length,
          invited: a.rows.filter((r) => r.status === 'invited').length,
          onboarded: a.rows.filter((r) => r.status === 'onboarded').length,
        },
      })
    }

    if (req.method === 'PATCH') {
      const { id, status } = readBody(req)
      if (!Number.isInteger(id) || !ALPHA_STATUSES.includes(status)) {
        return json(res, 400, { error: 'bad request' })
      }
      await sql`UPDATE alpha SET status = ${status} WHERE id = ${id}`
      return json(res, 204)
    }

    if (req.method === 'DELETE') {
      // Honours both "delete my data" requests and the retention rule: purge onboarded records
      // rather than accumulating a list that is no longer being used.
      const { table, id } = readBody(req)
      if (!Number.isInteger(id)) return json(res, 400, { error: 'bad request' })
      if (table === 'waitlist') await sql`DELETE FROM waitlist WHERE id = ${id}`
      else if (table === 'alpha') await sql`DELETE FROM alpha WHERE id = ${id}`
      else return json(res, 400, { error: 'bad request' })
      return json(res, 204)
    }

    return json(res, 405, { error: 'method not allowed' })
  } catch (e) {
    console.error('[admin]', e?.message)
    return json(res, 500, { error: 'server error' })
  }
}
