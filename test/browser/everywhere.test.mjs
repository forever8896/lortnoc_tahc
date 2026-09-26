// extension-everywhere, end to end in a real Chromium with the BUILT extension loaded:
// a local "cooking blog" with a comment box, a real local codec, three browser profiles.
//
//   profile 1 writes a comment locked with a passphrase (the sheet), posts it
//   profile 2 scans the page, clicks Reveal, types the passphrase → reads the message
//   profile 3 types the wrong passphrase → still chatter
//
// And the property the design exists for (PRD §14 G7): while profile 1 writes, the PAGE never
// sees the plaintext — not in its DOM, not in keyboard/input events, not in postMessage traffic.
//
// Skips (never fails) when the build, Playwright/Chromium or python3 are missing.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DIST = process.env.EXT_DIST ?? join(ROOT, 'extension-everywhere/dist')
const CODEC_PORT = 8898
const GATE_PORT = 8897
const SECRET = 'meet at the market at seven, bring the list'

let skip = null, chromium, codec, gate, site, siteUrl
const comments = []
const dirs = []

const PAGE = () => `<!doctype html><html><head><meta charset="utf-8"><title>Grandma's lentil soup</title></head>
<body><article><h1>Grandma's lentil soup</h1><p>Rinse the lentils, then simmer with onion and cumin.</p>
<p class="decoy">honestly this is the kind of soup my grandmother used to make every winter when the house was cold and we would all sit around the big table waiting for her to call us in from the garden</p></article>
<section id="comments">${comments.map((c) => `<div class="comment"><p class="author">guest</p><p class="body">${c
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p></div>`).join('')}</section>
<form id="f" method="post" action="/comment"><textarea id="c" name="c" rows="4" cols="60"></textarea><button>Post comment</button></form>
<script>
  // A nosy page: record everything it can observe while the user writes.
  window.__seen = []
  for (const t of ['keydown','keypress','input','beforeinput','paste'])
    document.addEventListener(t, (e) => window.__seen.push(t + ':' + (e.key || e.data || '')), true)
  window.addEventListener('message', (e) => window.__seen.push('message:' + JSON.stringify(e.data)))
</script></body></html>`

before(async () => {
  if (!existsSync(join(DIST, 'manifest.json'))) return void (skip = 'extension-everywhere not built — npm run build --prefix extension-everywhere')
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    return void (skip = 'playwright not installed')
  }
  codec = spawn('python3', ['server.py'], {
    cwd: join(ROOT, 'codec'),
    env: { ...process.env, PORT: String(CODEC_PORT), CODEC_BACKEND: 'markov' },
    stdio: 'ignore',
  })
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${CODEC_PORT}/health`)).ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
    if (i === 59) skip = 'local codec did not start'
  }
  const gateDb = mkdtempSync(join(tmpdir(), 'lortnoc-gate-'))
  dirs.push(gateDb)
  gate = spawn(process.execPath, [join(ROOT, 'gate/server.mjs')], {
    env: { ...process.env, PORT: String(GATE_PORT), GATE_DB: join(gateDb, 'gate.sqlite') },
    stdio: 'ignore',
  })
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${GATE_PORT}/health`)).ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 150))
    if (i === 39) skip = 'local gate did not start'
  }
  site = createServer((req, res) => {
    if (req.method === 'POST') {
      let b = ''
      req.on('data', (d) => (b += d))
      req.on('end', () => {
        comments.push(new URLSearchParams(b).get('c') ?? '')
        res.writeHead(303, { location: '/' }).end()
      })
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE())
  })
  await new Promise((r) => site.listen(0, '127.0.0.1', r))
  siteUrl = `http://127.0.0.1:${site.address().port}/`
})

after(async () => {
  for (const c of contexts) await c.close().catch(() => {})
  codec?.kill()
  gate?.kill()
  site?.close()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const contexts = [] // closed in after(), even when a test fails midway — else Node never exits
/** A fresh browser profile with the built extension, pointed at the local codec. */
async function profile() {
  const dir = mkdtempSync(join(tmpdir(), 'lortnoc-everywhere-'))
  dirs.push(dir)
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  })
  contexts.push(ctx)
  let [swk] = ctx.serviceWorkers()
  if (!swk) swk = await ctx.waitForEvent('serviceworker')
  await swk.evaluate(([codecUrl, gateUrl]) => chrome.storage.local.set({ codecUrl, gateUrl }),
    [`http://127.0.0.1:${CODEC_PORT}`, `http://127.0.0.1:${GATE_PORT}`])
  swk.__ctx = ctx
  swk.__extId = new URL(swk.url()).host
  return { ctx, sw: swk }
}

/** What the shortcut / popup does: inject the content script into this tab, send the action. */

/** The CURRENT service worker. MV3 stops an idle worker after ~30 s and starts a new one on the next
 *  event; a handle to the old one hangs forever (measured: a live test stalled right after a long
 *  World ID wait). So never reuse a stored handle — wake the worker and take the live one. */
async function liveSw(ctx, extId) {
  let w = ctx.serviceWorkers().at(-1)
  if (w) {
    const alive = await Promise.race([w.evaluate(() => 1).then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))])
    if (alive) return w
  }
  const wake = await ctx.newPage()
  await wake.goto(`chrome-extension://${extId}/src/popup/index.html`)
  w = ctx.serviceWorkers().at(-1) ?? (await ctx.waitForEvent('serviceworker'))
  await wake.close()
  return w
}
async function trigger(sw, action) {
  sw = await liveSw(sw.__ctx, sw.__extId)
  await sw.evaluate(async (action) => {
    // the NEWEST matching tab — an older tab of the same page may still be open from an earlier step
    const [tab] = (await chrome.tabs.query({ url: 'http://127.0.0.1/*' })).sort((a, b) => b.id - a.id)
    const file = chrome.runtime.getManifest().web_accessible_resources.flatMap((w) => w.resources).find((r) => r.endsWith('.ts.js'))
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [file] })
    await chrome.tabs.sendMessage(tab.id, { lortnocAction: action })
  }, action)
}

const frameOf = async (page, name) => {
  for (let i = 0; i < 50; i++) {
    const f = page.frames().find((f) => f.url().includes(`/src/${name}/`))
    if (f) return f
    await page.waitForTimeout(100)
  }
  throw new Error(`no ${name} frame`)
}

describe('extension-everywhere, three profiles on a comment section', () => {
  let passphrase

  test('profile 1 writes a passphrase-locked comment; the page never sees the plaintext', { timeout: 120_000 }, async (t) => {
    if (skip) return t.skip(skip)
    const { ctx, sw } = await profile()
    const page = await ctx.newPage()
    await page.goto(siteUrl)
    await page.click('#c')
    // Control: the nosy recorder DOES see typing in the page itself — so "saw nothing" below means
    // something, rather than a recorder that never fires.
    await page.keyboard.type('zq')
    assert.match((await page.evaluate(() => window.__seen)).join(','), /keydown:z/)
    await page.fill('#c', '')
    await page.evaluate(() => (window.__seen = []))
    await trigger(sw, { action: 'compose' })
    const sheet = await frameOf(page, 'sheet')
    await sheet.waitForSelector('#msg')
    await sheet.selectOption('#who', 'passphrase')
    passphrase = await sheet.inputValue('#pass')
    assert.equal(passphrase.split(' ').length, 5, 'a generated five-word passphrase is the default')
    await sheet.fill('#msg', SECRET)
    await sheet.type('#msg', '!') // real keystrokes too, not only fill()
    await sheet.click('#go')
    await sheet.waitForSelector('.status.ok', { timeout: 60_000 })

    const value = await page.inputValue('#c')
    assert.ok(value.length > 100 && !/#lortnoctahc/.test(value), 'cover inserted, and NOT tagged')
    assert.ok(!value.includes('market'), 'no plaintext in the field')
    const seen = (await page.evaluate(() => window.__seen)).join('\n')
    assert.ok(!seen.includes('market') && !/keydown:!/.test(seen), `the page observed plaintext:\n${seen}`)
    assert.ok(!(await page.content()).includes('market'), 'no plaintext in the page DOM')

    await page.click('button:has-text("Post comment")')
    await page.waitForSelector('.comment')
    await ctx.close()
  })

  test('profile 2 scans, reveals, types the passphrase and reads it', { timeout: 120_000 }, async (t) => {
    if (skip || !passphrase) return t.skip(skip ?? 'no comment posted')
    const { ctx, sw } = await profile()
    const page = await ctx.newPage()
    await page.goto(siteUrl)
    await trigger(sw, { action: 'scan' })
    await page.waitForSelector('button:has-text("Reveal")', { timeout: 60_000 })
    await page.waitForTimeout(3000) // let the deep scan finish every candidate
    // The decoy passes the SHAPE filter but is not ours: the codec must reject it → exactly one chip.
    assert.equal(await page.locator('button:has-text("Reveal")').count(), 1, 'only the real post gets a chip')
    await page.click('button:has-text("Reveal")')
    const card = await frameOf(page, 'reveal')
    await card.waitForSelector('#pw:not([hidden])', { state: 'visible', timeout: 60_000 })
    assert.match(await card.textContent('#checks'), /Passphrase/)
    await card.fill('#pw', passphrase.toUpperCase()) // case never makes it wrong
    await card.click('#try')
    await card.waitForSelector('#out:not([hidden])', { timeout: 30_000 })
    assert.equal(await card.textContent('#plain'), SECRET + '!')
    assert.ok(!(await page.content()).includes('market'), 'the revealed text stays out of the page DOM')
    await ctx.close()
  })

  test('profile 3, wrong passphrase: still chatter', { timeout: 120_000 }, async (t) => {
    if (skip || !passphrase) return t.skip(skip ?? 'no comment posted')
    const { ctx, sw } = await profile()
    const page = await ctx.newPage()
    await page.goto(siteUrl)
    await trigger(sw, { action: 'scan' })
    await page.click('button:has-text("Reveal")')
    const card = await frameOf(page, 'reveal')
    await card.waitForSelector('#pw', { state: 'visible', timeout: 60_000 })
    await card.fill('#pw', 'blue door')
    await card.click('#try')
    await card.waitForSelector('.status.err')
    assert.equal(await card.isHidden('#out'), true)
    await ctx.close()
  })
})

/** datetime-local value for `h` hours from now, as the sheet's input expects (browser local time). */
const localIn = (page, h) => page.evaluate((h) => {
  const d = new Date(Date.now() + h * 3600_000)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}, h)

describe('timed messages through a real gate', () => {
  for (const [name, hours, opens] of [['still locked (opens in an hour)', 1, false], ['already open (opened an hour ago)', -1, true]]) {
    test(name, { timeout: 120_000 }, async (t) => {
      if (skip) return t.skip(skip)
      comments.length = 0
      const writer = await profile()
      const page = await writer.ctx.newPage()
      await page.goto(siteUrl)
      await page.click('#c')
      await trigger(writer.sw, { action: 'compose' })
      const sheet = await frameOf(page, 'sheet')
      await sheet.waitForSelector('#msg')
      await sheet.selectOption('#who', 'after')
      await sheet.fill('#when', await localIn(page, hours))
      assert.match(await sheet.textContent('#honesty'), /gate holds part of the key/, 'a time lock alone must be labelled gate-readable')
      await sheet.fill('#msg', 'the tasting starts at noon')
      await sheet.click('#go')
      await sheet.waitForSelector('.status.ok', { timeout: 60_000 })
      await page.click('button:has-text("Post comment")')
      await page.waitForSelector('.comment')
      await writer.ctx.close()

      const reader = await profile()
      const rp = await reader.ctx.newPage()
      await rp.goto(siteUrl)
      await trigger(reader.sw, { action: 'scan' })
      await rp.click('button:has-text("Reveal")')
      const card = await frameOf(rp, 'reveal')
      if (opens) {
        await card.waitForSelector('#out:not([hidden])', { timeout: 60_000 })
        assert.equal(await card.textContent('#plain'), 'the tasting starts at noon')
      } else {
        await card.waitForSelector('.status.err', { timeout: 60_000 })
        assert.match(await card.textContent('#status'), /Locked until/)
        assert.equal(await card.isHidden('#out'), true)
      }
      await reader.ctx.close()
    })
  }
})

describe('inserting when no box was focused (measured failure, 2026-09-26)', () => {
  test('open the panel first, click the box after: it still lands in the box', { timeout: 120_000 }, async (t) => {
    if (skip) return t.skip(skip)
    comments.length = 0
    const { ctx, sw } = await profile()
    const page = await ctx.newPage()
    await page.goto(siteUrl)
    await trigger(sw, { action: 'compose' }) // nothing focused on the page
    const sheet = await frameOf(page, 'sheet')
    await sheet.waitForSelector('#msg')
    await page.click('#c') // the user picks the box AFTER opening the panel
    await sheet.fill('#msg', 'order should not matter')
    await sheet.click('#go')
    await sheet.waitForSelector('.status.ok', { timeout: 60_000 })
    assert.ok((await page.inputValue('#c')).length > 50)
  })

  test('no box at all: the hidden text is kept, click a box, press Insert', { timeout: 120_000 }, async (t) => {
    if (skip) return t.skip(skip)
    const { ctx, sw } = await profile()
    const page = await ctx.newPage()
    await page.goto(siteUrl)
    await trigger(sw, { action: 'compose' })
    const sheet = await frameOf(page, 'sheet')
    await sheet.fill('#msg', 'insert later')
    await sheet.click('#go')
    await sheet.waitForSelector('.status.err', { timeout: 60_000 })
    assert.match(await sheet.textContent('#status'), /Click the box you want to post in/)
    await page.click('#c')
    await sheet.click('#insert')
    await sheet.waitForSelector('.status.ok', { timeout: 30_000 })
    assert.ok((await page.inputValue('#c')).length > 50, 'the kept cover text was inserted — no re-encoding')
  })
})

describe('"Always on for this site": the focus pill', () => {
  test('on an opted-in site, focusing a box shows 🔒; clicking it writes into that box', { timeout: 120_000 }, async (t) => {
    if (skip) return t.skip(skip)
    comments.length = 0
    const { ctx, sw } = await profile()
    const origin = new URL(siteUrl).origin
    // What the popup's switch does once Chrome has granted this one origin.
    const ext = await ctx.newPage()
    await ext.goto(`chrome-extension://${new URL(sw.url()).host}/src/popup/index.html`)
    const r = await ext.evaluate((origin) => chrome.runtime.sendMessage({ type: 'SITE_SET', origin, on: true }), origin)
    assert.equal(r.data.on, true)
    const page = await ctx.newPage()
    await page.goto(siteUrl) // loaded fresh: the registered script runs with NO click
    await page.click('#c')
    const pill = page.locator('button[title="Write this hidden — lortnoc tahc"]')
    await pill.waitFor({ state: 'visible', timeout: 10_000 })
    await pill.dispatchEvent('mousedown')
    const sheet = await frameOf(page, 'sheet')
    await sheet.fill('#msg', 'from the pill')
    await sheet.click('#go')
    await sheet.waitForSelector('.status.ok', { timeout: 60_000 })
    assert.ok((await page.inputValue('#c')).length > 50)
    // Same page on a hostname that was NOT switched on: no script, no pill.
    const other = await ctx.newPage()
    await other.goto(siteUrl.replace('127.0.0.1', 'localhost'))
    await other.click('#c')
    await other.waitForTimeout(1500)
    assert.equal(await other.locator('button[title="Write this hidden — lortnoc tahc"]').count(), 0)
  })
})
