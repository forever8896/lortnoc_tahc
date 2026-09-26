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
  return { ctx, sw }
}
async function trigger(sw, action) {
  await sw.evaluate(async (action) => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' })
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

describe('World ID, live (simulator + World API + World Chain)', () => {
  test('writer locks a comment to verified humans', { timeout: 180_000 }, async (t) => {
    if (skip) return t.skip(skip)
    const { ctx, sw } = await profile()
    const page = await ctx.newPage()
    await page.goto(siteUrl)
    await page.click('#c')
    await trigger(sw, { action: 'compose' })
    const sheet = await frameOf(page, 'sheet')
    await sheet.waitForSelector('#msg')
    await sheet.selectOption('#groups select', 'human')
    await sheet.click('#groups .check .x')
    await sheet.fill('#msg', 'the circle meets thursday')
    await sheet.click('#go')
    await sheet.waitForSelector('.status.ok', { timeout: 90_000 })
    await page.click('button:has-text("Post")')
    await page.waitForSelector('.c')
    await ctx.close()
  })

  test('cancelling World ID keeps it shut (the alternative path)', { timeout: 180_000 }, async (t) => {
    if (skip || !comments.length) return t.skip(skip ?? 'nothing posted')
    const { ctx, sw } = await profile()
    const page = await ctx.newPage()
    await page.goto(siteUrl)
    await trigger(sw, { action: 'scan' })
    await page.click('button:has-text("Reveal")')
    const card = await frameOf(page, 'reveal')
    await card.click('#verifyHuman', { timeout: 60_000 })
    await card.waitForSelector('#world:not([hidden])', { timeout: 30_000 })
    await card.click('#cancelWorld')
    await card.waitForSelector('.status.err', { timeout: 30_000 })
    assert.match(await card.textContent('#status'), /cancelled/i)
    assert.equal(await card.isHidden('#out'), true)
    await ctx.close()
  })

  test('a verified human reads it', { timeout: 240_000 }, async (t) => {
    if (skip || !comments.length) return t.skip(skip ?? 'nothing posted')
    const { ctx, sw } = await profile()
    const page = await ctx.newPage()
    await page.goto(siteUrl)
    await trigger(sw, { action: 'scan' })
    await page.click('button:has-text("Reveal")')
    const logs = []
    page.on('console', (m) => logs.push(`page: ${m.type()} ${m.text()}`.slice(0, 300)))
    sw.on('console', (m) => logs.push(`sw: ${m.type()} ${m.text()}`.slice(0, 300)))
    const card = await frameOf(page, 'reveal')
    await card.click('#verifyHuman', { timeout: 60_000 })
    await card.waitForSelector('#sim:not([hidden])', { timeout: 30_000 })
    await card.click('#sim')
    try {
      await card.waitForSelector('#out:not([hidden])', { timeout: 150_000 })
    } catch (e) {
      const status = await card.textContent('#status').catch(() => '?')
      const world = await card.isVisible('#world').catch(() => '?')
      const bridge = await card.getAttribute('#worldHow', 'data-state').catch(() => '?')
      throw new Error(`never opened — card status: "${status}", World panel visible: ${world}, bridge state: ${bridge}\n${logs.filter((l) => !/preload/.test(l)).join('\n')}`)
    }
    assert.equal(await card.textContent('#plain'), 'the circle meets thursday')
    await ctx.close()
  })
})
