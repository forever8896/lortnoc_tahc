// NFT-gated ENS space, LIVE, through the built extension's own UI. Opt-in (Sepolia, spends the
// deployer's Sepolia ETH, relayer on fly.io):
//
//   NFT_LIVE=1 node --test test/browser/nft-live.test.mjs
//
// The story a judge sees, with nothing faked but the wallet popup:
//   0. a space is bought on Sepolia LortnocSpaces → the relayer mints <label>.space.lortnoctahc.eth
//      with eth.lortnoc.space.token = the LortnocDemoPass collection; the holder and the owner get a pass
//   1. a writer locks a comment to "NFT holders of <label>.space"
//   2. a stranger (no pass) presses "Prove I hold the NFT" → refused
//   3. the holder does the same → it opens, and they are now a member
//   4. the holder posts a comment SIGNED as their member pseudonym
//   5. the owner opens it, sees "✓ verified member …", presses Ban → the ban is written to ENS
//   6. the holder is refused the next time
// The wallet is a window.ethereum injected into the page that signs with an in-memory throwaway key,
// so the extension's real MAIN-world wallet path is exercised end to end.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const GATE_PORT = 8797
const CODEC_PORT = 8798
const RELAYER = process.env.RELAYER ?? 'https://lortnoc-relayer.fly.dev'
let skip = process.env.NFT_LIVE ? null : 'set NFT_LIVE=1 (live Sepolia + relayer)'
let chromium, gate, codec, site, siteUrl, DIST, viem, accounts
const comments = [], dirs = [], open = []
const space = {} // label, ownerPriv, owner, holder, stranger

before(async () => {
  if (skip) return
  if (!existsSync(join(ROOT, '.env.local'))) return void (skip = 'no deployer key (.env.local)')
  ;({ chromium } = await import('playwright'))
  viem = await import('../../gate/node_modules/viem/_esm/index.js')
  accounts = await import('../../gate/node_modules/viem/_esm/accounts/index.js')
  const { clients, sendTx, readDeployment } = await import('../../scripts/ens/lib/ens.mjs')

  // 0. a fresh space, bought and minted for real
  const S = readDeployment().lortnoc.spaces
  const SPACES = JSON.parse(readFileSync(join(ROOT, 'app/src/lib/live/spaces-deployment.json'), 'utf8')).sepolia.address
  const { publicClient: pc, walletClient: deployer } = clients()
  const key = () => accounts.generatePrivateKey()
  space.label = `nftui-${Math.random().toString(36).slice(2, 8)}`
  space.ownerPriv = key()
  for (const who of ['owner', 'holder', 'stranger']) space[who] = accounts.privateKeyToAccount(who === 'owner' ? space.ownerPriv : key())
  const token = `eip155:11155111/erc721:${S.demoPass.toLowerCase()}`
  const abi = viem.parseAbi(['function buySpace(string,address,bytes32) payable returns (uint256)', 'function price() view returns (uint256)', 'function mintTo(address) returns (uint256)'])
  const price = await pc.readContract({ address: SPACES, abi, functionName: 'price' })
  const rules = viem.keccak256(viem.stringToHex(`lortnoc/space/rules/v1|${token}`))
  const buy = await sendTx(pc, deployer, { to: SPACES, value: price, data: viem.encodeFunctionData({ abi, functionName: 'buySpace', args: [space.label, space.owner.address, rules] }) }, 'buySpace')
  let made
  for (let i = 0; i < 20 && !made?.name; i++) {
    made = await fetch(`${RELAYER}/space`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chainId: 11155111, txHash: buy.transactionHash, label: space.label, token }) }).then((r) => r.json()).catch(() => null)
    if (!made?.name) await new Promise((r) => setTimeout(r, 6000))
  }
  if (!made?.name) return void (skip = `relayer did not create the space: ${JSON.stringify(made)}`)
  for (const who of [space.holder, space.owner])
    await sendTx(pc, deployer, { to: S.demoPass, data: viem.encodeFunctionData({ abi, functionName: 'mintTo', args: [who.address] }) }, 'mintTo')

  // the extension, a gate (real ENS + balances), a codec, a comment page
  DIST = mkdtempSync(join(tmpdir(), 'lortnoc-ext-'))
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
        if (!h.checks.includes('nft')) skip = 'gate has no NFT check'
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
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><body><h1>Holders</h1>${comments.map((c) => `<p class="c">${c}</p>`).join('')}
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

/** A browser with the extension, knowing the space, and (optionally) a wallet for `account`. */
async function profile(account, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lortnoc-nl-'))
  dirs.push(dir)
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`] })
  open.push(ctx)
  if (account) {
    await ctx.exposeBinding('__lortnocSign', (_src, message) => account.signMessage({ message }))
    await ctx.addInitScript((address) => {
      window.ethereum = {
        request: async ({ method, params }) => {
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address]
          if (method === 'personal_sign') return window.__lortnocSign(params[0])
          throw new Error(`test wallet: ${method} not supported`)
        },
      }
    }, account.address)
  }
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  await sw.evaluate(([c, g, l, e]) => chrome.storage.local.set({ codecUrl: c, gateUrl: g, ensSpaces: [l], ...e }),
    [`http://127.0.0.1:${CODEC_PORT}`, `http://127.0.0.1:${GATE_PORT}`, space.label, extra])
  sw.__ctx = ctx
  sw.__extId = new URL(sw.url()).host
  return { ctx, sw }
}
async function liveSw(ctx, extId) {
  let w = ctx.serviceWorkers().at(-1)
  if (w && (await Promise.race([w.evaluate(() => 1).then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]))) return w
  const wake = await ctx.newPage()
  await wake.goto(`chrome-extension://${extId}/src/popup/index.html`)
  w = ctx.serviceWorkers().at(-1) ?? (await ctx.waitForEvent('serviceworker'))
  await wake.close()
  return w
}
async function trigger(sw, action) {
  sw = await liveSw(sw.__ctx, sw.__extId)
  await sw.evaluate(async (action) => {
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
async function write(p, text, who, { signAs = false } = {}) {
  const page = await p.ctx.newPage()
  await page.goto(siteUrl)
  await page.click('#c')
  await trigger(p.sw, { action: 'compose' })
  const sheet = await frameOf(page, 'sheet')
  await sheet.waitForSelector('#msg')
  await sheet.selectOption('#who', who)
  await sheet.fill('#msg', text)
  if (signAs) {
    await sheet.check('#signAs')
    await sheet.selectOption('#signSpace', `@${space.label}`)
  }
  await sheet.click('#go')
  await sheet.waitForSelector('.status.ok, .status.err', { timeout: 90_000 })
  assert.ok(await sheet.locator('.status.ok').count(), `sheet: ${await sheet.textContent('#status')}`)
  await page.click('button:has-text("Post")')
  await page.waitForSelector('.c')
  await page.close()
}
/** Reveal the Nth hidden comment and press "Prove I hold the NFT". Returns the card frame + page. */
async function proveOn(p, nth) {
  const page = await p.ctx.newPage()
  await page.goto(siteUrl)
  await trigger(p.sw, { action: 'scan' })
  await page.locator('button:has-text("Reveal")').nth(nth).click()
  const card = await frameOf(page, 'reveal')
  await card.waitForSelector('#proveNft:not([hidden])', { timeout: 60_000 })
  // clear whatever the first (proof-less) attempt left, so the wait below sees only THIS attempt
  await card.evaluate(() => Object.assign(document.querySelector('#status'), { className: 'status', textContent: '' }))
  await card.click('#proveNft')
  await card.waitForFunction(() => document.querySelector('#plain').textContent || document.querySelector('.status.err'), null, { timeout: 90_000 })
  return { page, card }
}

describe('NFT-gated ENS space, live, through the extension', () => {
  let holder
  test('a writer locks a comment to the space NFT holders', { timeout: 300_000 }, async (t) => {
    if (skip) return t.skip(skip)
    const writer = await profile(null)
    await write(writer, 'holders: the drop is at nine', `nft:@${space.label}`)
    assert.equal(comments.length, 1)
  })

  test('a wallet without the pass is refused', { timeout: 180_000 }, async (t) => {
    if (skip || !comments.length) return t.skip(skip ?? 'nothing posted')
    const { card } = await proveOn(await profile(space.stranger), 0)
    assert.match(await card.textContent('.status'), /doesn.t hold/)
    assert.ok(await card.locator('#out').isHidden())
  })

  test('the holder proves the NFT, reads it, and posts signed as a member', { timeout: 300_000 }, async (t) => {
    if (skip || !comments.length) return t.skip(skip ?? 'nothing posted')
    holder = await profile(space.holder)
    const { card } = await proveOn(holder, 0)
    assert.equal(await card.textContent('#plain'), 'holders: the drop is at nine')
    const mem = await holder.sw.evaluate(() => chrome.storage.local.get('spaceMemberships'))
    holder.memberId = mem.spaceMemberships?.[`@${space.label}`]?.memberId
    assert.match(holder.memberId ?? '', /^member-[0-9a-f]{12}$/)
    await write(holder, 'signed by a holder', `nft:@${space.label}`, { signAs: true })
    assert.equal(comments.length, 2)
  })

  test('the owner sees the verified member and bans them through ENS', { timeout: 300_000 }, async (t) => {
    if (skip || !holder?.memberId) return t.skip(skip ?? 'no member')
    const owner = await profile(space.owner, { ensSpaceKeys: { [space.label]: { priv: space.ownerPriv, address: space.owner.address, role: 'owner' } } })
    const { card } = await proveOn(owner, 1)
    assert.equal(await card.textContent('#plain'), 'signed by a holder', `card: ${await card.textContent('.status')}`)
    assert.match(await card.textContent('#author'), new RegExp(`verified member ${holder.memberId}`))
    await card.click('#ban')
    await card.waitForFunction(() => /is banned/.test(document.querySelector('#ban').textContent) || document.querySelector('.status.err'), null, { timeout: 180_000 })
    assert.match(await card.textContent('#ban'), /is banned/)
  })

  test('the banned holder is refused', { timeout: 180_000 }, async (t) => {
    if (skip || !holder?.memberId) return t.skip(skip ?? 'no member')
    await new Promise((r) => setTimeout(r, 21_000)) // the gate caches ENS reads for 20 s
    const { card } = await proveOn(holder, 0)
    assert.match(await card.textContent('.status'), /banned/, `plain: ${await card.textContent('#plain')}`)
    assert.ok(await card.locator('#out').isHidden())
  })
})
