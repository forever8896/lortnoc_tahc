// BROWSER TIER — the DOM layer, in a real Chromium, against a Telegram Web K fixture.
//
// This is the layer the rest of the suite could not reach: selectors.ts, compose.ts's send
// interception, and inbound.ts's MutationObserver scanning. It is also the layer most likely to
// break in production, because Telegram ships new markup without notice.
//
// What this tier CAN prove: that the logic layered on the selectors is correct — the compose
// swap is fail-closed, the inbound cache distinguishes "not ours" from "try again", history
// fossils never drive a handshake, the hidden chat pane is ignored.
//
// What it CANNOT prove: that the selectors still match the real Telegram build. Only a live
// page can tell you that. Treat a green run here as "our logic is intact", never as "the
// overlay works today".
//
// Skips cleanly when Playwright or its Chromium is not installed.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { ROOT } from '../lib/env.mjs'
import { buildBundle, esbuildAvailable } from './build.mjs'

let chromium = null
let browser = null
let bundlePath = null
let skipReason = null

before(async () => {
  if (!esbuildAvailable()) {
    skipReason = 'esbuild not found — run `npm ci --prefix extension`'
    return
  }
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    skipReason = 'playwright not installed — run `npm install` at the repo root'
    return
  }
  try {
    browser = await chromium.launch()
  } catch (e) {
    skipReason = `could not launch chromium (${e.message.split('\n')[0]}) — run \`npx playwright install chromium\``
    return
  }
  bundlePath = await buildBundle()
})

after(async () => {
  await browser?.close()
})

/**
 * Fresh page with the fixture loaded, the content modules bundled in, and a chrome.* stub.
 * `location.pathname` must start with /k or detectClient() returns 'unknown'.
 */
async function newPage() {
  const page = await browser.newPage()
  // ui.ts calls chrome.runtime.getURL for fonts and the logo at style-injection time.
  await page.addInitScript(() => {
    window.chrome = {
      runtime: {
        id: 'test',
        getURL: (p) => `about:blank#${p}`,
        onMessage: { addListener: () => {} },
        sendMessage: async () => ({ ok: false }),
      },
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        session: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener: () => {} },
      },
    }
  })
  // Serve the fixture under a /k path so detectClient() sees Web K.
  await page.route('**/k/**', async (route) => {
    const fs = await import('node:fs/promises')
    const html = await fs.readFile(resolve(ROOT, 'test/browser/fixture.html'), 'utf8')
    await route.fulfill({ status: 200, contentType: 'text/html', body: html })
  })
  await page.goto('https://web.telegram.org/k/')
  await page.addScriptTag({ path: bundlePath })
  return page
}

/** Wrap a test body so it skips when the browser tier is unavailable. */
function browserTest(name, fn) {
  test(name, async (t) => {
    if (skipReason) return t.skip(skipReason)
    const page = await newPage()
    try {
      await fn(page, t)
    } finally {
      await page.close()
    }
  })
}

describe('selectors.ts — client detection and the active pane', () => {
  browserTest('detects Web K from the URL path', async (page) => {
    assert.equal(await page.evaluate(() => window.lortnoc.selectors.detectClient()), 'k')
  })

  browserTest('every Web K selector resolves against the fixture', async (page) => {
    // Not proof they match the live build, but it catches a selector typo and it means the
    // fixture and the selector set cannot drift apart silently.
    const missing = await page.evaluate(() => {
      const K = window.lortnoc.selectors.K
      const out = []
      for (const [name, sel] of Object.entries(K)) {
        if (name === 'midAttr') continue
        if (!document.querySelector(sel)) out.push(`${name} (${sel})`)
      }
      return out
    })
    assert.deepEqual(missing, [], `selectors resolved nothing: ${missing.join(', ')}`)
  })

  browserTest('activeCompose picks the VISIBLE pane, not the stale one', async (page) => {
    // Telegram keeps the previous chat's pane in the DOM. Taking the first match would type
    // the cover text into a chat the user is not looking at.
    const id = await page.evaluate(() => {
      const sel = window.lortnoc.selectors.K
      return window.lortnoc.selectors.activeCompose(sel)?.id
    })
    assert.equal(id, 'compose', 'activeCompose selected the hidden pane')
  })

  browserTest('unknown client paths return no selector set', async (page) => {
    const r = await page.evaluate(() => window.lortnoc.selectors.selectorsFor('unknown'))
    assert.equal(r, null)
  })
})

describe('compose.ts — reading and replacing the draft', () => {
  browserTest('readCompose trims and normalises the non-breaking spaces Telegram inserts', async (page) => {
    const text = await page.evaluate(() => {
      const el = document.getElementById('compose')
      el.innerText = '  meet at 8  '
      return window.lortnoc.compose.readCompose(el)
    })
    assert.equal(text, 'meet at 8')
  })

  browserTest('readCompose returns empty string for an empty box', async (page) => {
    const text = await page.evaluate(() => {
      const el = document.getElementById('compose')
      el.innerHTML = ''
      return window.lortnoc.compose.readCompose(el)
    })
    assert.equal(text, '')
  })

  browserTest('replaceCompose swaps the content so the app sends the NEW text', async (page) => {
    const after = await page.evaluate(() => {
      const el = document.getElementById('compose')
      el.innerText = 'the real message'
      window.lortnoc.compose.replaceCompose(el, 'harmless cover chatter')
      return el.innerText.trim()
    })
    assert.equal(after, 'harmless cover chatter')
    assert.ok(!after.includes('real'), 'the plaintext survived the swap')
  })
})

describe('compose.ts — send interception (§6.1 outbound)', () => {
  /** Install the interceptor with a controllable swap function. */
  const install = (page, { cover = 'cover text goes here', ready = true } = {}) =>
    page.evaluate(
      ({ cover, ready }) => {
        window.__swapCalls = []
        window.lortnoc.compose.installSendInterceptor('k', () => ready, async (real) => {
          window.__swapCalls.push(real)
          return cover // null = abort
        })
      },
      { cover, ready },
    )

  browserTest('Enter sends the COVER text and never the plaintext', async (page) => {
    await install(page)
    await page.evaluate(() => {
      document.getElementById('compose').innerText = 'meet at 8 by the north gate'
    })
    await page.focus('#compose')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__tg.sent.length > 0, null, { timeout: 5000 })

    const { sent, swaps } = await page.evaluate(() => ({ sent: window.__tg.sent, swaps: window.__swapCalls }))
    assert.deepEqual(swaps, ['meet at 8 by the north gate'], 'the swap did not receive the draft')
    assert.deepEqual(sent, ['cover text goes here'])
    assert.ok(!sent.join(' ').includes('north gate'), 'PLAINTEXT WAS SENT — invariant §4 broken')
  })

  browserTest('clicking send also swaps', async (page) => {
    await install(page)
    await page.evaluate(() => {
      document.getElementById('compose').innerText = 'clicked message'
    })
    await page.click('#send')
    await page.waitForFunction(() => window.__tg.sent.length > 0, null, { timeout: 5000 })
    assert.deepEqual(await page.evaluate(() => window.__tg.sent), ['cover text goes here'])
  })

  browserTest('FAIL-CLOSED: a null cover aborts the send and leaves the draft intact', async (page) => {
    // The single most important behaviour in the file. If encoding fails, nothing may go out.
    await install(page, { cover: null })
    await page.evaluate(() => {
      document.getElementById('compose').innerText = 'must never be sent'
    })
    await page.focus('#compose')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__swapCalls.length > 0, null, { timeout: 5000 })
    await page.waitForTimeout(300)

    const { sent, draft } = await page.evaluate(() => ({
      sent: window.__tg.sent,
      draft: document.getElementById('compose').innerText.trim(),
    }))
    assert.deepEqual(sent, [], 'a message was sent despite the encode failing')
    assert.equal(draft, 'must never be sent', 'the draft was lost on a failed encode')
  })

  browserTest('Shift+Enter inserts a newline instead of sending', async (page) => {
    await install(page)
    await page.focus('#compose')
    await page.keyboard.type('line one')
    await page.keyboard.press('Shift+Enter')
    await page.waitForTimeout(150)
    assert.deepEqual(await page.evaluate(() => window.__swapCalls), [], 'Shift+Enter triggered a send')
  })

  browserTest('when stego is OFF the send passes through untouched', async (page) => {
    await install(page, { ready: false })
    await page.evaluate(() => {
      document.getElementById('compose').innerText = 'plain telegram message'
    })
    await page.click('#send')
    await page.waitForFunction(() => window.__tg.sent.length > 0, null, { timeout: 5000 })
    const { sent, swaps } = await page.evaluate(() => ({ sent: window.__tg.sent, swaps: window.__swapCalls }))
    assert.deepEqual(swaps, [], 'the interceptor ran while disabled')
    assert.deepEqual(sent, ['plain telegram message'])
  })

  browserTest('an empty draft does not trigger a swap', async (page) => {
    await install(page)
    await page.focus('#compose')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    assert.deepEqual(await page.evaluate(() => window.__swapCalls), [])
  })

  browserTest('a second Enter during an in-flight swap does not double-send', async (page) => {
    // The documented double-send bug: `swapping` is set synchronously before the await, so the
    // async gap cannot let a second send slip through.
    await page.evaluate(() => {
      window.__swapCalls = []
      window.lortnoc.compose.installSendInterceptor('k', () => true, async (real) => {
        window.__swapCalls.push(real)
        await new Promise((r) => setTimeout(r, 400)) // a slow codec
        return 'cover text goes here'
      })
    })
    await page.evaluate(() => {
      document.getElementById('compose').innerText = 'only once please'
    })
    await page.focus('#compose')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__tg.sent.length > 0, null, { timeout: 5000 })
    await page.waitForTimeout(400)

    const { sent, swaps } = await page.evaluate(() => ({ sent: window.__tg.sent, swaps: window.__swapCalls }))
    assert.equal(swaps.length, 1, `the codec was called ${swaps.length} times for one message`)
    assert.equal(sent.length, 1, `the message was sent ${sent.length} times`)
  })

  browserTest('sendCoverText sends a handshake frame without re-encoding it', async (page) => {
    await install(page)
    const ok = await page.evaluate(() => window.lortnoc.compose.sendCoverText('handshake cover words here'))
    assert.equal(ok, true)
    await page.waitForFunction(() => window.__tg.sent.length > 0, null, { timeout: 5000 })
    const { sent, swaps } = await page.evaluate(() => ({ sent: window.__tg.sent, swaps: window.__swapCalls }))
    assert.deepEqual(sent, ['handshake cover words here'])
    assert.deepEqual(swaps, [], 'the interceptor re-encoded our own programmatic send')
  })
})

describe('inbound.ts — bubble scanning and decode caching (§6.1 inbound)', () => {
  /**
   * Start inbound with a scripted decoder. `script` maps cover text -> return value:
   * a string (decoded), null (definitely not ours), or 'RETRY'.
   */
  const start = (page, script) =>
    page.evaluate((script) => {
      window.__decodeCalls = []
      window.__inbound = window.lortnoc.inbound.startInbound('k', () => true, async (cover, fromHistory) => {
        window.__decodeCalls.push({ cover, fromHistory })
        const verdict = script[cover]
        if (verdict === 'RETRY') return window.lortnoc.RETRY
        return verdict === undefined ? null : verdict
      })
    }, script)

  const LONG = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen'

  browserTest('decodes a matching bubble and renders the plaintext inline', async (page) => {
    await start(page, { [LONG]: 'meet at 8 by the north gate' })
    await page.evaluate((t) => window.__tg.addBubble(1, t), LONG)
    await page.waitForFunction(() => window.__tg.decodedSpan(1) !== null, null, { timeout: 5000 })
    assert.equal(await page.evaluate(() => window.__tg.decodedSpan(1)), 'meet at 8 by the north gate')
  })

  browserTest('the timestamp is stripped before decoding, and survives rendering', async (page) => {
    // `.time` lives inside `.message`. Feeding "…fourteen12:00" to the codec would never decode.
    await start(page, { [LONG]: 'decoded ok' })
    await page.evaluate((t) => window.__tg.addBubble(1, t, { time: '23:59' }), LONG)
    await page.waitForFunction(() => window.__tg.decodedSpan(1) !== null, null, { timeout: 5000 })
    const calls = await page.evaluate(() => window.__decodeCalls)
    assert.equal(calls[0].cover, LONG, 'the timestamp leaked into the text sent to the codec')
    assert.ok(
      await page.evaluate(() => !!document.querySelector('.bubble[data-mid="1"] .time')),
      'rendering the decode destroyed the timestamp element',
    )
  })

  browserTest('short bubbles are rejected locally without a codec round trip', async (page) => {
    // MIN_COVER_WORDS: the difference between a scan costing seconds and costing minutes.
    await start(page, {})
    await page.evaluate(() => {
      window.__tg.addBubble(1, 'ok')
      window.__tg.addBubble(2, 'see you tonight')
      window.__tg.addBubble(3, 'one two three four five six seven eight nine ten eleven twelve')
    })
    await page.waitForTimeout(700)
    const calls = await page.evaluate(() => window.__decodeCalls)
    assert.deepEqual(calls, [], `the codec was called for ${calls.length} obviously-too-short bubbles`)
  })

  browserTest('a "not ours" verdict is cached — the codec is never asked twice', async (page) => {
    await start(page, {}) // everything returns null
    await page.evaluate((t) => window.__tg.addBubble(1, t), LONG)
    await page.waitForFunction(() => window.__decodeCalls.length > 0, null, { timeout: 5000 })
    // Churn the DOM the way Telegram does, to force re-scans.
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) document.getElementById('bubbles').append(document.createElement('span'))
    })
    await page.waitForTimeout(700)
    const n = await page.evaluate(() => window.__decodeCalls.length)
    assert.equal(n, 1, `a settled "not ours" verdict was re-decoded ${n} times`)
  })

  browserTest('RETRY is NOT cached — the bubble is tried again (the swallowed-message bug)', async (page) => {
    // The failure this prevents: a transient error (no key yet, codec blip) cached as a final
    // verdict means the real message is never decoded, silently, forever.
    await start(page, { [LONG]: 'RETRY' })
    await page.evaluate((t) => window.__tg.addBubble(1, t), LONG)
    await page.waitForFunction(() => window.__decodeCalls.length > 0, null, { timeout: 5000 })
    await page.evaluate(() => {
      for (let i = 0; i < 3; i++) document.getElementById('bubbles').append(document.createElement('span'))
    })
    await page.waitForFunction(() => window.__decodeCalls.length > 1, null, { timeout: 5000 })
    assert.ok(
      (await page.evaluate(() => window.__decodeCalls.length)) > 1,
      'a RETRY verdict was cached as final — the message would never decode',
    )
  })

  browserTest('RETRY never renders the word "retry" into the bubble', async (page) => {
    // It used to be the string 'retry', which satisfied `typeof decoded === "string"`.
    await start(page, { [LONG]: 'RETRY' })
    await page.evaluate((t) => window.__tg.addBubble(1, t), LONG)
    await page.waitForFunction(() => window.__decodeCalls.length > 0, null, { timeout: 5000 })
    await page.waitForTimeout(300)
    assert.equal(await page.evaluate(() => window.__tg.decodedSpan(1)), null)
    assert.equal(await page.evaluate(() => window.__tg.renderedText(1)), LONG, 'the bubble was mutated')
  })

  browserTest('a bubble that is not ours is left completely untouched', async (page) => {
    await start(page, {})
    const chatter = 'hey are you around later today i wanted to ask you about the thing we discussed'
    await page.evaluate((t) => window.__tg.addBubble(1, t), chatter)
    await page.waitForFunction(() => window.__decodeCalls.length > 0, null, { timeout: 5000 })
    await page.waitForTimeout(300)
    assert.equal(await page.evaluate(() => window.__tg.renderedText(1)), chatter)
    assert.equal(await page.evaluate(() => window.__tg.decodedSpan(1)), null)
  })

  browserTest('bubbles already on screen are flagged fromHistory (handshake fossils)', async (page) => {
    // A frame already in the chat when we load is a FOSSIL of an earlier session; acting on it
    // keys you to a pubkey the peer discarded. inbound reports it so index.ts can ignore it.
    await page.evaluate((t) => window.__tg.addBubble(1, t), LONG)
    await start(page, { [LONG]: 'old message' })
    await page.waitForFunction(() => window.__decodeCalls.length > 0, null, { timeout: 5000 })
    const calls = await page.evaluate(() => window.__decodeCalls)
    assert.equal(calls[0].fromHistory, true, 'a pre-existing bubble was treated as a live arrival')
  })

  browserTest('bubbles arriving after start are NOT fromHistory', async (page) => {
    await start(page, { [LONG]: 'live message' })
    await page.waitForTimeout(300) // let the first pass record the (empty) history set
    await page.evaluate((t) => window.__tg.addBubble(2, t), LONG)
    await page.waitForFunction(() => window.__decodeCalls.length > 0, null, { timeout: 5000 })
    const calls = await page.evaluate(() => window.__decodeCalls)
    assert.equal(calls.at(-1).fromHistory, false, 'a live arrival was mistaken for a fossil')
  })

  browserTest('the newest bubble is decoded FIRST, ahead of the backlog', async (page) => {
    // Otherwise an incoming handshake ACK queues behind the whole visible history — minutes of
    // decodes — and the handshake reads as broken.
    const script = {}
    for (let i = 1; i <= 6; i++) script[`${LONG} number ${i}`] = null
    await start(page, script)
    await page.evaluate(
      ({ LONG }) => {
        for (let i = 1; i <= 6; i++) window.__tg.addBubble(i, `${LONG} number ${i}`)
      },
      { LONG },
    )
    await page.waitForFunction(() => window.__decodeCalls.length >= 6, null, { timeout: 8000 })
    const calls = await page.evaluate(() => window.__decodeCalls.map((c) => c.cover))
    assert.ok(calls[0].endsWith('number 6'), `scanned oldest-first: started with ${JSON.stringify(calls[0])}`)
  })

  browserTest('reset() re-scans so pre-key messages decode once a handshake lands', async (page) => {
    await page.evaluate(() => {
      window.__decodeCalls = []
      window.__haveKey = false
      window.__inbound = window.lortnoc.inbound.startInbound('k', () => true, async (cover) => {
        window.__decodeCalls.push(cover)
        if (!window.__haveKey) return window.lortnoc.RETRY
        return 'now readable'
      })
    })
    await page.evaluate((t) => window.__tg.addBubble(1, t), LONG)
    await page.waitForFunction(() => window.__decodeCalls.length > 0, null, { timeout: 5000 })
    assert.equal(await page.evaluate(() => window.__tg.decodedSpan(1)), null)

    // Handshake completes → key arrives → reset re-scans.
    await page.evaluate(() => {
      window.__haveKey = true
      window.__inbound.reset()
    })
    await page.waitForFunction(() => window.__tg.decodedSpan(1) !== null, null, { timeout: 5000 })
    assert.equal(await page.evaluate(() => window.__tg.decodedSpan(1)), 'now readable')
  })

  browserTest('the hidden chat pane is never scanned', async (page) => {
    await start(page, {})
    await page.waitForTimeout(500)
    const calls = await page.evaluate(() => window.__decodeCalls.map((c) => c.cover))
    assert.ok(
      !calls.some((c) => c.includes('previously open chat')),
      'the stale, hidden chat pane was scanned',
    )
  })

  browserTest('our own outgoing bubbles decode too, so the sender sees their message', async (page) => {
    await start(page, { [LONG]: 'what i sent' })
    await page.evaluate((t) => window.__tg.addBubble(1, t, { outgoing: true }), LONG)
    await page.waitForFunction(() => window.__tg.decodedSpan(1) !== null, null, { timeout: 5000 })
    assert.equal(await page.evaluate(() => window.__tg.decodedSpan(1)), 'what i sent')
  })
})

describe('end-to-end in the page: real crypto through the real DOM', () => {
  browserTest('a message encrypted in one tab decodes in the bubble of another', async (page) => {
    // No codec: the cover text is stand-in transport. What is exercised is the real crypto and
    // the real DOM path — encrypt → (cover) → bubble → decrypt → rendered inline.
    const decoded = await page.evaluate(async () => {
      const { genKeyPair, deriveConvKey, encrypt, tryDecrypt, toB64, fromB64 } = window.lortnoc.crypto
      const alice = genKeyPair()
      const bob = genKeyPair()
      const kA = deriveConvKey(alice.priv, bob.pub, alice.pub)
      const kB = deriveConvKey(bob.priv, alice.pub, bob.pub)

      const wire = toB64(encrypt(kA, 'meet at 8 by the north gate'))
      // A FIXED 20-word cover, not one derived from the ciphertext. Deriving it made the word
      // count depend on how many digits base64 happened to emit, so it sometimes fell under
      // MIN_COVER_WORDS and the bubble was pre-filtered out — a flaky test, not a real bug.
      // The codec is not under test here; the crypto and the DOM path are.
      const cover =
        'one two three four five six seven eight nine ten ' +
        'eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'

      window.lortnoc.inbound.startInbound('k', () => true, async (text) => {
        if (text !== cover) return null
        return tryDecrypt(kB, fromB64(wire))
      })
      window.__tg.addBubble(42, cover)

      for (let i = 0; i < 60; i++) {
        const got = window.__tg.decodedSpan(42)
        if (got) return got
        await new Promise((r) => setTimeout(r, 100))
      }
      return null
    })
    assert.equal(decoded, 'meet at 8 by the north gate')
  })
})
