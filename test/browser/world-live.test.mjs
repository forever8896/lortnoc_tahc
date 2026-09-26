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
    await sheet.selectOption('#who', 'human')
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
    const widgetTab = ctx.waitForEvent('page', { predicate: (p) => p.url().includes('/src/world/'), timeout: 30_000 })
    await card.click('#verifyHuman', { timeout: 60_000 })
    // World's OWN widget (IDKitRequestWidget) opens in its tab and shows its QR (in its shadow root)
    const world = await widgetTab
    world.on('console', (m) => logs.push(`world: ${m.type()} ${m.text()}`.slice(0, 300)))
    await world.waitForSelector('.idkit-qr-inner', { timeout: 30_000 })
    if (process.env.SHOT) await world.screenshot({ path: process.env.SHOT })
    await card.waitForSelector('#sim:not([hidden])', { timeout: 30_000 })
    await card.click('#sim')
    try {
      await card.waitForSelector('#out:not([hidden])', { timeout: 150_000 })
    } catch (e) {
      const status = await card.textContent('#status').catch(() => '?')
      const world = await card.isVisible('#world').catch(() => '?')
      const bridge = await card.getAttribute('#worldHow', 'data-state').catch(() => '?')
      const wstatus = await (await widgetTab).textContent('#status').catch(() => '?')
      const link = await (await widgetTab).evaluate(() => document.querySelector('[data-idkit-shadow-host]')?.shadowRoot?.querySelector('a.idkit-deeplink-btn')?.href ?? 'none').catch((e) => 'eval failed ' + e.message)
      throw new Error(`never opened — card status: "${status}", widget tab: "${wstatus}", widget link: ${String(link).slice(0, 40)}, World panel visible: ${world}, bridge state: ${bridge}\n${logs.filter((l) => !/preload/.test(l)).join('\n')}`)
    }
    assert.equal(await card.textContent('#plain'), 'the circle meets thursday')
    // the widget saw the gate's verdict, showed success, and closed its own tab
    await world.waitForEvent('close', { timeout: 30_000 })
    await ctx.close()
  })
})

describe('spaces: join with World ID, sign as a member, get banned — live', () => {
  // World's simulator is ONE fake human, so the owner never verifies here (they would become the same
  // member they are about to ban). The member signs a post readable by anyone; the owner reads it,
  // sees the verified pseudonym, and bans it. The member then cannot get back in.
  const SPACE = 'wl-' + Date.now().toString(36)
  let owner, member

  test('owner creates a space and posts to its members', { timeout: 180_000 }, async (t) => {
    if (skip) return t.skip(skip)
    comments.length = 0
    owner = await profile()
    const pop = await owner.ctx.newPage()
    await pop.goto(`chrome-extension://${new URL(owner.sw.url()).host}/src/popup/index.html`)
    await pop.click('summary')
    await pop.fill('#spaceName', SPACE)
    await pop.click('#createSpace')
    await pop.waitForFunction(() => /Created/.test(document.getElementById('status').textContent), null, { timeout: 30_000 })
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

  test('a member joins with World ID and signs a post as their pseudonym', { timeout: 240_000 }, async (t) => {
    if (skip || !owner) return t.skip(skip ?? 'no space')
    member = await profile()
    const page = await member.ctx.newPage()
    const step = (m) => console.log(`    · ${m}`)
    let card
    try {
    await page.goto(siteUrl)
    step('scan')
    await trigger(member.sw, { action: 'scan' })
    await page.click('button:has-text("Reveal")', { timeout: 60_000 })
    card = await frameOf(page, 'reveal')
    step('verify')
    await card.click('#verifyHuman', { timeout: 60_000 })
    await card.click('#sim', { timeout: 30_000 })
    await card.waitForSelector('#out:not([hidden])', { timeout: 150_000 })
    assert.equal(await card.textContent('#plain'), 'members meet at the library')
    step('opened; now writing as a member')
    // now a member: sign a post readable by anyone
    await page.keyboard.press('Escape')
    await page.click('#c')
    await trigger(member.sw, { action: 'compose' })
    const sheet = await frameOf(page, 'sheet')
    await sheet.waitForSelector('#signAs', { timeout: 10_000 })
    await sheet.selectOption('#who', 'public')
    await sheet.check('#signAs')
    await sheet.fill('#msg', 'i am about to misbehave')
    await sheet.click('#go')
    await sheet.waitForSelector('.status.ok', { timeout: 90_000 })
    step('posting')
    await page.click('button:has-text("Post")')
    await page.waitForFunction(() => document.querySelectorAll('.c').length === 2)
    } catch (e) {
      const status = await card?.textContent('#status').catch(() => '?')
      throw new Error(`${e.message.split('\n')[0]} — card status: "${status}"`)
    }
  })

  test('the owner sees the verified member and bans them; they cannot get back in', { timeout: 300_000 }, async (t) => {
    if (skip || !member) return t.skip(skip ?? 'no member')
    const page = await owner.ctx.newPage()
    await page.goto(siteUrl)
    await trigger(owner.sw, { action: 'scan' })
    await page.waitForFunction(() => [...document.querySelectorAll('button')].filter((b) => b.textContent.includes('Reveal')).length === 2, null, { timeout: 60_000 })
    await page.locator('button:has-text("Reveal")').last().click()
    const card = await frameOf(page, 'reveal')
    await card.waitForSelector('#out:not([hidden])', { timeout: 60_000 })
    assert.match(await card.textContent('#author'), /✓ verified member member-[0-9a-f]{12}/)
    await card.click('#ban')
    await card.waitForFunction(() => /is banned/.test(document.getElementById('ban').textContent), null, { timeout: 30_000 })
    // the member tries the members-only post again — same human, same nullifier → refused
    const mp = await member.ctx.newPage()
    await mp.goto(siteUrl)
    await trigger(member.sw, { action: 'scan' })
    await mp.locator('button:has-text("Reveal")').first().click({ timeout: 60_000 })
    const again = await frameOf(mp, 'reveal')
    await again.click('#verifyHuman', { timeout: 60_000 })
    await again.click('#sim', { timeout: 30_000 })
    await again.waitForFunction(() => /banned/i.test(document.getElementById('status').textContent), null, { timeout: 150_000 })
    assert.equal(await again.isHidden('#out'), true)
  })
})
