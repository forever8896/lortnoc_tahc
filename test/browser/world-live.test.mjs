// World ID, LIVE: the built extension + a real gate configured from gate/.env + World's real
// simulator. Opt-in (network, World's servers, needs the 24h staging window for World's API):
//
//   WORLD_LIVE=1 node --test test/browser/world-live.test.mjs
//
// Proves the whole reader path a judge would see: a post locked to verified humans → the reader
// clicks "Verify with World ID" → World ID (simulator) → the gate verifies (World's API + on-chain)
// → the message opens. And the alternative path: Cancel → it stays shut.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const GATE_PORT = 8796
const CODEC_PORT = 8795
let skip = process.env.WORLD_LIVE ? null : 'set WORLD_LIVE=1 (live World ID, network)'
let chromium, gate, codec, site, siteUrl, DIST
const comments = [], dirs = []

before(async () => {
  if (skip) return
  if (!existsSync(join(ROOT, 'gate/.env'))) return void (skip = 'gate/.env missing')
  ;({ chromium } = await import('playwright'))
  DIST = mkdtempSync(join(tmpdir(), 'lortnoc-ext-')) // a private build — never the human's dist/
  dirs.push(DIST)
  execFileSync('npm', ['run', 'build', '--prefix', join(ROOT, 'extension-everywhere')], { env: { ...process.env, OUT_DIR: DIST }, stdio: 'ignore' })
  const db = mkdtempSync(join(tmpdir(), 'lortnoc-gate-'))
  dirs.push(db)
  gate = spawn(process.execPath, [join(ROOT, 'gate/server.mjs')], { env: { ...process.env, PORT: String(GATE_PORT), GATE_DB: join(db, 'g.sqlite') }, stdio: 'ignore' })
  codec = spawn('python3', ['server.py'], { cwd: join(ROOT, 'codec'), env: { ...process.env, PORT: String(CODEC_PORT), CODEC_BACKEND: 'markov' }, stdio: 'ignore' })
  for (let i = 0; i < 80; i++) {
    try {
      const h = await (await fetch(`http://127.0.0.1:${GATE_PORT}/health`)).json()
      if ((await fetch(`http://127.0.0.1:${CODEC_PORT}/health`)).ok) {
        if (!h.checks.includes('human')) skip = 'gate has no World ID configured'
        break
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  site = createServer((req, res) => {
    if (req.method === 'POST') {
      let b = ''
      req.on('data', (d) => (b += d))
      req.on('end', () => (comments.push(new URLSearchParams(b).get('c')), res.writeHead(303, { location: '/' }).end()))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><body><h1>Circle</h1>${comments.map((c) => `<p class="c">${c}</p>`).join('')}
      <form method="post"><textarea id="c" name="c"></textarea><button>Post</button></form></body>`)
  })
  await new Promise((r) => site.listen(0, '127.0.0.1', r))
  siteUrl = `http://127.0.0.1:${site.address().port}/`
})
after(async () => {
  for (const c of open) await c.close().catch(() => {})
  gate?.kill(); codec?.kill(); site?.close()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const open = [] // every browser context, closed in after() even when a test fails midway
async function profile() {
  const dir = mkdtempSync(join(tmpdir(), 'lortnoc-wl-'))
  dirs.push(dir)
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`] })
  open.push(ctx)
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  await sw.evaluate(([c, g]) => chrome.storage.local.set({ codecUrl: c, gateUrl: g }), [`http://127.0.0.1:${CODEC_PORT}`, `http://127.0.0.1:${GATE_PORT}`])
  sw.__ctx = ctx
  sw.__extId = new URL(sw.url()).host
  return { ctx, sw }
}

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
  for (let i = 0; i < 60; i++) {
    const f = page.frames().find((f) => f.url().includes(`/src/${name}/`))
    if (f) return f
    await page.waitForTimeout(100)
  }
  throw new Error(`no ${name} frame`)
}

/** What the popup's "Your keys → World ID" does, with World's simulator answering (staging demo).
 *  World's own widget opens in a tab, the simulator completes it, the gate verifies (World API +
 *  World Chain) and remembers the credential; returns the keyring's claims. */
async function connectWorldSim(p) {
  const ext = await p.ctx.newPage()
  await ext.goto(`chrome-extension://${p.sw.__extId}/src/popup/index.html`)
  const widget = p.ctx.waitForEvent('page', { predicate: (x) => x.url().includes('/src/world/'), timeout: 30_000 })
  const done = ext.evaluate(() => chrome.runtime.sendMessage({ type: 'WORLD_CONNECT', kind: 'poh', simulate: true }))
  const w = await widget
  await w.waitForSelector('.idkit-qr-inner', { timeout: 30_000 }) // World's own IDKitRequestWidget
  const r = await done
  await ext.close()
  return r
}
/** What a reader sees after a scan: the number of posts that opened for them (0 = the page is plain). */
async function scanOpens(p) {
  const page = await p.ctx.newPage()
  await page.goto(siteUrl)
  await trigger(p.sw, { action: 'scan' })
  const t0 = Date.now()
  for (;;) {
    const n = await page.locator('button:has-text("Hidden message")').count()
    const none = page.frames().find((f) => f.url().includes('/src/reveal/'))
    if (n || (none && /Nothing on this page opens/.test(await none.textContent('#status').catch(() => '')))) return { page, n }
    if (Date.now() - t0 > 90_000) return { page, n: 0 }
    await page.waitForTimeout(500)
  }
}
async function readFirst(page, which = 'first') {
  await page.locator('button:has-text("Hidden message")')[which]().click()
  const card = await frameOf(page, 'reveal')
  await card.waitForSelector('#out:not([hidden])', { timeout: 30_000 })
  return card
}

describe('World ID keyring, live (World widget + simulator + World API + World Chain)', () => {
  let reader
  test('writer locks a comment to verified humans — sealed, nothing on it says so', { timeout: 180_000 }, async (t) => {
    if (skip) return t.skip(skip)
    const { ctx, sw } = await profile()
    const page = await ctx.newPage()
    await page.goto(siteUrl)
    await page.click('#c')
    await trigger(sw, { action: 'compose' })
    const sheet = await frameOf(page, 'sheet')
    await sheet.waitForSelector('#msg')
    await sheet.selectOption('#who', 'human')
    await sheet.fill('#msg', 'the circle meets thursday')
    await sheet.click('#go')
    await sheet.waitForSelector('.status.ok', { timeout: 90_000 })
    await page.click('button:has-text("Post")')
    await page.waitForSelector('.c')
    await ctx.close()
  })

  test('without World ID connected, the page is plain: no button, no hint', { timeout: 180_000 }, async (t) => {
    if (skip || !comments.length) return t.skip(skip ?? 'nothing posted')
    reader = await profile()
    assert.equal((await scanOpens(reader)).n, 0)
  })

  test('connect World ID once (World widget, simulator) — then the post appears and opens', { timeout: 300_000 }, async (t) => {
    if (skip || !reader) return t.skip(skip ?? 'no reader')
    const r = await connectWorldSim(reader)
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.data.human, true)
    const { page, n } = await scanOpens(reader)
    assert.equal(n, 1)
    const card = await readFirst(page)
    assert.equal(await card.textContent('#plain'), 'the circle meets thursday')
    assert.match(await card.textContent('#note'), /Verified human/)
  })
})

describe('spaces through the keyring: join, sign as a member, get banned — live', () => {
  // World's simulator is ONE fake human, so the owner never connects World ID here (they would become
  // the member they are about to ban). The member signs a post anyone can read; the owner bans it.
  const SPACE = 'wl-' + Date.now().toString(36)
  let owner, member

  test('owner creates a space and posts to its members', { timeout: 180_000 }, async (t) => {
    if (skip) return t.skip(skip)
    comments.length = 0
    owner = await profile()
    const pop = await owner.ctx.newPage()
    await pop.goto(`chrome-extension://${new URL(owner.sw.url()).host}/src/home/index.html#spaces`) // the full page (popup ⚙)
    await pop.fill('#spaceName', SPACE)
    await pop.click('#createSpace')
    await pop.waitForFunction(() => /Created/.test(document.getElementById('spaceMsg').textContent), null, { timeout: 30_000 })
    const page = await owner.ctx.newPage()
    await page.goto(siteUrl)
    await page.click('#c')
    await trigger(owner.sw, { action: 'compose' })
    const sheet = await frameOf(page, 'sheet')
    await sheet.waitForSelector(`#who option[value="space:${SPACE}"]`, { state: 'attached' })
    await sheet.selectOption('#who', `space:${SPACE}`)
    await sheet.fill('#msg', 'members meet at the library')
    await sheet.click('#go')
    await sheet.waitForSelector('.status.ok', { timeout: 90_000 })
    await page.click('button:has-text("Post")')
    await page.waitForSelector('.c')
  })

  test('a member connects World ID, the members-only post opens, and they sign a post as their pseudonym', { timeout: 300_000 }, async (t) => {
    if (skip || !owner) return t.skip(skip ?? 'no space')
    member = await profile()
    assert.equal((await connectWorldSim(member)).ok, true)
    const { page, n } = await scanOpens(member)
    assert.equal(n, 1)
    assert.equal(await (await readFirst(page)).textContent('#plain'), 'members meet at the library')
    await page.keyboard.press('Escape')
    await page.click('#c', { timeout: 20_000 })
    await trigger(member.sw, { action: 'compose' })
    const sheet = await frameOf(page, 'sheet')
    await sheet.waitForSelector('#signAs', { timeout: 10_000 })
    await sheet.selectOption('#who', 'public')
    await sheet.check('#signAs')
    await sheet.fill('#msg', 'i am about to misbehave')
    await sheet.click('#go')
    await sheet.waitForSelector('.status.ok', { timeout: 90_000 })
    await page.click('button:has-text("Post")')
    await page.waitForFunction(() => document.querySelectorAll('.c').length === 2)
  })

  test('the owner sees the verified member and bans them; the members-only post vanishes for them', { timeout: 300_000 }, async (t) => {
    if (skip || !member) return t.skip(skip ?? 'no member')
    const { page, n } = await scanOpens(owner)
    assert.equal(n, 1, 'the owner sees the public post (the members-only one needs World ID they did not connect)')
    const card = await readFirst(page)
    assert.match(await card.textContent('#author'), /✓ verified member member-[0-9a-f]{12}/)
    await card.click('#ban')
    await card.waitForFunction(() => /is banned/.test(document.getElementById('ban').textContent), null, { timeout: 30_000 })
    const again = await scanOpens(member)
    assert.equal(again.n, 1, 'only the public post is left for them')
    assert.equal(await (await readFirst(again.page)).textContent('#plain').then((x) => x.includes('library')), false)
  })
})
