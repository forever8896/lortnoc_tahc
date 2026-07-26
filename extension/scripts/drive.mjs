#!/usr/bin/env node
// Drive the paired windows through a full handshake, and report what actually happened.
//
//   npm run pair:debug
//   node scripts/drive.mjs
//
// Opens Saved Messages in both windows, turns the extension on, has ALICE offer and BOB accept,
// then prints both consoles and the two conversation-key fingerprints. Those fingerprints are the
// whole test: equal means the handshake converged, different is the bug that reads as "the codec
// is broken" and is not.
//
// Deliberately targets Saved Messages only. Connecting SENDS cover text into whatever chat is
// focused, and doing that to a real contact by accident is not a mistake worth risking.
const PORTS = { alice: 9222, bob: 9223 }
const EXT_ID = process.env.EXT_ID || 'hpikilnidmhbjnogcbfhlgbkmcgofmag'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.logs = []
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m)
        this.pending.delete(m.id)
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
        if (text.includes('lortnoc')) this.logs.push(text)
      }
    }
  }
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = rej
    })
    const s = new Session(ws)
    await s.send('Runtime.enable')
    return s
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      setTimeout(() => resolve({ timeout: true }), 15000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return r?.result?.result?.value
  }
  close() {
    this.ws.close()
  }
}

async function pageOf(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const t = list.find(
    (x) => x.type === 'page' && x.url.startsWith('https://web.telegram.org/k/') && !x.url.includes('.worker'),
  )
  return t ? Session.open(t.webSocketDebuggerUrl) : null
}

/** Open Saved Messages via Telegram's own search.
 *
 *  The chat list is virtualised, so Saved Messages usually is not in the DOM to click — searching
 *  is what a person would do anyway, and it renders the row reliably. If a chat is already open
 *  (you opened it yourself), leave it alone: whatever is focused is what Connect will send into,
 *  and second-guessing that is how cover text ends up in a stranger's chat. */
async function openSavedMessages(s) {
  const already = await s.eval(`(() => {
    if (!document.querySelector('div.input-message-input[contenteditable="true"]')) return null
    return location.hash || '(chat)'
  })()`)
  if (already) return `already open → ${already}`

  const typed = await s.eval(`(() => {
    const i = document.querySelector('input.input-search-input')
    if (!i) return 'no-search-input'
    i.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(i, 'Saved Messages')
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return 'typed'
  })()`)
  if (typed !== 'typed') return typed
  await sleep(2000)
  return s.eval(`(() => {
    const rows = [...document.querySelectorAll('.chatlist-chat, li')]
    const hit = rows.find((r) => /saved messages/i.test(r.textContent || ''))
    if (!hit) return 'no-result'
    hit.click()
    return 'opened'
  })()`)
}

/** Turn the extension on and (optionally) fire Connect, from a popup page that has chrome.* APIs. */
async function viaPopup(port, action) {
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const browser = await Session.open(ver.webSocketDebuggerUrl)
  const created = await browser.send('Target.createTarget', {
    url: `chrome-extension://${EXT_ID}/src/popup/index.html`,
  })
  const targetId = created?.result?.targetId
  if (!targetId) {
    browser.close()
    return 'popup-failed'
  }
  await sleep(1200)
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const popup = list.find((t) => t.id === targetId)
  if (!popup) {
    browser.close()
    return 'popup-not-found'
  }
  const s = await Session.open(popup.webSocketDebuggerUrl)
  const out = await s.eval(action)
  s.close()
  await browser.send('Target.closeTarget', { targetId })
  browser.close()
  return out
}

const ENABLE = `(async () => {
  await chrome.storage.local.set({ enabled: true })
  return 'enabled'
})()`

// START_HANDSHAKE is what the popup's Connect button sends — same path, not a test-only shortcut.
const CONNECT = `(async () => {
  const [tab] = await chrome.tabs.query({ url: 'https://web.telegram.org/k/*' })
  if (!tab) return 'no-telegram-tab'
  const r = await chrome.tabs.sendMessage(tab.id, { type: 'START_HANDSHAKE' }).catch((e) => ({ error: String(e) }))
  return JSON.stringify(r ?? null)
})()`

const STATUS = `(async () => {
  const [tab] = await chrome.tabs.query({ url: 'https://web.telegram.org/k/*' })
  if (!tab) return 'no-telegram-tab'
  const r = await chrome.tabs.sendMessage(tab.id, { type: 'HS_STATUS' }).catch((e) => ({ error: String(e) }))
  return JSON.stringify(r)
})()`

// ---- run ---------------------------------------------------------------------------------------

const S = {}
for (const [name, port] of Object.entries(PORTS)) {
  S[name] = await pageOf(port)
  if (!S[name]) {
    console.error(`[${name}] no Telegram page — run \`npm run pair:debug\` first`)
    process.exit(1)
  }
}

console.log('\n1. Opening Saved Messages in both windows')
for (const [name, s] of Object.entries(S)) console.log(`   ${name}: ${await openSavedMessages(s)}`)
await sleep(2500)

console.log('\n2. Confirming the chat is really open (compose box present)')
for (const [name, s] of Object.entries(S)) {
  const ok = await s.eval(`!!document.querySelector('div.input-message-input[contenteditable="true"]')`)
  console.log(`   ${name}: compose=${ok}`)
}

console.log('\n3. Turning the extension on in both')
for (const [name, port] of Object.entries(PORTS)) console.log(`   ${name}: ${await viaPopup(port, ENABLE)}`)
await sleep(1500)

console.log('\n4. alice → Connect (this sends cover text into Saved Messages)')
console.log(`   ${await viaPopup(PORTS.alice, CONNECT)}`)

// Offer → bob decodes → ack → alice decodes. Each leg is a full arithmetic decode per bubble, so
// this is tens of seconds, not milliseconds. Poll rather than guess a single timeout — and stop
// early once both sides hold a key, so a fast run is not padded to the worst case.
console.log('\n5. Waiting for the exchange (poll every 10s, up to 2min)…')
let last = {}
for (let i = 0; i < 12; i++) {
  await sleep(10000)
  const now = {}
  for (const [name, port] of Object.entries(PORTS)) now[name] = await viaPopup(port, STATUS)
  if (JSON.stringify(now) !== JSON.stringify(last)) {
    console.log(`   +${(i + 1) * 10}s  alice=${now.alice}  bob=${now.bob}`)
    last = now
  }
  if (Object.values(now).every((v) => typeof v === 'string' && v.includes('"hasKey":true'))) break
}

console.log('\n6. Handshake status')
for (const [name, port] of Object.entries(PORTS)) console.log(`   ${name}: ${await viaPopup(port, STATUS)}`)

console.log('\n7. Console output')
for (const [name, s] of Object.entries(S)) {
  console.log(`\n[${name}]`)
  const seen = new Set()
  for (const l of s.logs) if (!seen.has(l)) (seen.add(l), console.log(`   ${l}`))
  if (!s.logs.length) console.log('   (nothing)')
}

const fp = (name) => (S[name].logs.find((l) => l.includes('fingerprint')) ?? '').match(/[0-9a-f]{12}/)?.[0]
const a = fp('alice')
const b = fp('bob')
console.log(`\nfingerprints: alice=${a ?? '(none)'}  bob=${b ?? '(none)'}`)
console.log(a && b && a === b ? '\x1b[32mMATCH — the handshake converged.\x1b[0m' : '\x1b[31mNO MATCH — see console above.\x1b[0m')

for (const s of Object.values(S)) s.close()
