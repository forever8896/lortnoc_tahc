// The onboarding bot's conversation (site/api/_lib/bot.js), driven through a fake Bot API and a
// fake store. Imports the real module — never a copy (test/README.md).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { handleUpdate, screen, STEPS } from '../../site/api/_lib/bot.js'

const cfg = { releaseUrl: 'https://example.test/release', repoUrl: 'https://example.test/repo', siteUrl: 'https://example.test' }

function harness() {
  const calls = []
  const rows = new Map()
  const api = async (method, params) => { calls.push({ method, params }); return { ok: true } }
  const store = {
    async seen(u, source) {
      const r = rows.get(u.id) || { username: null, source: null, step: 'welcome' }
      rows.set(u.id, { ...r, username: u.username || null, source: r.source ?? source })
    },
    async step(id, step) { const r = rows.get(id); if (r) r.step = step },
    async forget(id) { rows.delete(id) },
    async note(id, text) { rows.get(id).last = text },
  }
  return { calls, rows, deps: { api, store, cfg } }
}

const user = { id: 42, username: 'kirsten', is_bot: false }
const msg = (text, chat = { id: 42, type: 'private' }) => ({ message: { from: user, chat, text } })
const tap = (data) => ({ callback_query: { id: 'q1', from: user, data, message: { chat: { id: 42 }, message_id: 7 } } })

describe('onboarding bot', () => {
  test('/start records the handle and the deep-link source', async () => {
    const h = harness()
    await handleUpdate(msg('/start site'), h.deps)
    assert.deepEqual(h.rows.get(42), { username: 'kirsten', source: 'site', step: 'welcome' })
    assert.equal(h.calls.at(-1).method, 'sendMessage')
    assert.match(h.calls.at(-1).params.text, /\/privacy/, 'the welcome must disclose that the handle is kept')
  })

  test('a later bare /start does not overwrite where they came from', async () => {
    const h = harness()
    await handleUpdate(msg('/start site'), h.deps)
    await handleUpdate(msg('/start'), h.deps)
    assert.equal(h.rows.get(42).source, 'site')
  })

  test('the deep-link payload is sanitised before it reaches the database', async () => {
    const h = harness()
    await handleUpdate(msg("/start x';DROP TABLE--"), h.deps)
    assert.equal(h.rows.get(42).source, 'xDROP') // payload ends at the first space
  })

  test('buttons walk every step in order and record progress', async () => {
    const h = harness()
    await handleUpdate(msg('/start'), h.deps)
    for (const step of ['download', 'verify', 'load', 'run', 'done']) {
      await handleUpdate(tap(`go:${step}`), h.deps)
      assert.equal(h.rows.get(42).step, step)
      const edit = h.calls.findLast((c) => c.method === 'editMessageText')
      assert.equal(edit.params.text, screen(step, cfg).text)
    }
  })

  test('forged callback data falls back to the start instead of throwing', async () => {
    const h = harness()
    await handleUpdate(tap('go:../../etc'), h.deps)
    assert.equal(h.rows.get(42).step, 'welcome')
  })

  test('/delete erases the row', async () => {
    const h = harness()
    await handleUpdate(msg('/start'), h.deps)
    await handleUpdate(msg('/delete'), h.deps)
    assert.equal(h.rows.has(42), false)
  })

  test('group chats are ignored — nothing stored, nothing said', async () => {
    const h = harness()
    await handleUpdate(msg('/start', { id: -100, type: 'supergroup' }), h.deps)
    assert.equal(h.rows.size, 0)
    assert.equal(h.calls.length, 0)
  })

  test('free text is kept as a help request', async () => {
    const h = harness()
    await handleUpdate(msg('/start'), h.deps)
    await handleUpdate(msg('load unpacked is greyed out'), h.deps)
    assert.equal(h.rows.get(42).last, 'load unpacked is greyed out')
  })

  test('every screen links the right places and uses the X extension, not the Telegram one', () => {
    assert.ok(screen('download', cfg).buttons.flat().some((b) => b.url === cfg.releaseUrl))
    assert.ok(screen('verify', cfg).buttons.flat().some((b) => b.url?.endsWith('/extension-x')))
    for (const s of STEPS) assert.doesNotMatch(screen(s, cfg).text, /PrivacyMaxxing|Telegram Web/)
  })

  test('the public mode is described honestly', () => {
    assert.match(screen('run', cfg).text, /<b>not<\/b> private/)
  })
})
