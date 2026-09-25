// BROWSER TIER (X) — the DOM layer, in a real Chromium, against an X fixture.
//
// This is the layer nothing else in the suite reaches: selectors.ts, compose.ts's post
// interception and thread layout, and inbound.ts's virtualisation-safe scanning. It is also the
// layer most likely to break in production, because X ships new markup without notice.
//
// What this tier CAN prove: that the logic layered on the selectors is correct — the visible
// variant is chosen over the hidden one, tweets are identified by permalink rather than by node,
// the hashtag pre-filter rejects before spending a decode, and the compose path fails closed.
//
// What it CANNOT prove: that the selectors still match the real X build, or that Draft.js accepts
// our insertion. Only a live page can tell you either, which is what the §7 spike was for. Treat
// a green run as "our logic is intact", never as "the overlay works today".
//
// Skips cleanly when Playwright or its Chromium is not installed.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { ROOT } from '../lib/env.mjs'
import { buildXBundle, esbuildAvailable } from './build.mjs'

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
    skipReason = `chromium unavailable (${String(e).slice(0, 60)})`
    return
  }
  bundlePath = await buildXBundle()
})

after(async () => {
  await browser?.close()
})

/** A fresh page on the fixture with the real modules loaded, plus a chrome.* stub. */
async function page() {
  const p = await browser.newPage()
  // ui.ts calls chrome.runtime.getURL for fonts and the logo the moment a progress stepper is
  // built, which is inside the swap path. Without this the interceptor throws before onSwap runs
  // — and the fail-closed assertions would pass for the wrong reason.
  await p.addInitScript(() => {
    window.chrome = {
      runtime: {
        id: 'test',
        getURL: (path) => `about:blank#${path}`,
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
  await p.goto(pathToFileURL(resolve(ROOT, 'test/browser/x-fixture.html')).href)
  await p.addScriptTag({ path: bundlePath })
  return p
}

describe('selectors — picking the right element out of X\'s duplicates', () => {
  test('activePostButton takes the VISIBLE variant, not the first match', async (t) => {
    if (skipReason) return t.skip(skipReason)
    const p = await page()
    const which = await p.evaluate(() =>
      window.lortnocX.selectors.activePostButton()?.getAttribute('data-testid'),
    )
    // tweetButtonInline comes first in the DOM but is hidden. Taking the first match would
    // click a button that is not there — the exact bug the spike caught X's variant flip causing.
    assert.equal(which, 'tweetButton')
    await p.close()
  })

  test('activeCompose finds the visible composer', async (t) => {
    if (skipReason) return t.skip(skipReason)
    const p = await page()
    const id = await p.evaluate(() =>
      window.lortnocX.selectors.activeCompose()?.getAttribute('data-testid'),
    )
    assert.equal(id, 'tweetTextarea_0')
    await p.close()
  })

  test('thread composers are addressed BY POSITION — they share one testid', async (t) => {
    if (skipReason) return t.skip(skipReason)
    const p = await page()
    const found = await p.evaluate(() => {
      const { composers, composerAt } = window.lortnocX.selectors
      const before = { count: composers().length, second: !!composerAt(1) }
      document.getElementById('second-composer').classList.remove('hidden-variant')
      return { before, after: { count: composers().length, second: !!composerAt(1) } }
    })
    // Measured live: adding a thread part mounts a SECOND `tweetTextarea_0`, not a
    // `tweetTextarea_1`. Indexing by id would find nothing for part 2 and abort every thread —
    // the failure would be a thread that posts short, with no error anywhere.
    assert.equal(found.before.count, 1, 'only the first composer should be visible initially')
    assert.equal(found.before.second, false, 'composerAt(1) must be null before the part mounts')
    assert.equal(found.after.count, 2, 'both composers share the testid and must both be found')
    assert.equal(found.after.second, true, 'composerAt(1) must resolve once the part mounts')
    await p.close()
  })

  test('tweetId reads the permalink, and distinguishes IDENTICAL adjacent tweets', async (t) => {
    if (skipReason) return t.skip(skipReason)
    const p = await page()
    const ids = await p.evaluate(() => {
      const { TWEET, tweetId } = window.lortnocX.selectors
      return [...document.querySelectorAll(TWEET)].map((a) => tweetId(a))
    })
    // The two thread parts have byte-identical text and adjacent positions; only the permalink
    // separates them. A node- or index-keyed cache would hand one's decode to the other as the
    // virtualised feed recycles nodes.
    assert.equal(ids[3], '1000000000000000004')
    assert.equal(ids[4], '1000000000000000005')
    assert.notEqual(ids[3], ids[4])
    // No permalink yet (still posting) → null, so no verdict is cached against a changing id.
    assert.equal(ids[5], null)
    await p.close()
  })
})

/**
 * The layout measured on live x.com 2026-09-25, built into the fixture page: a compose DIALOG
 * (parts `tweetTextarea_0`, `tweetTextarea_1`, its own "Post all") sitting over the page's own
 * visible, editable composer — the fixture's existing `tweetTextarea_0` plays the home timeline's
 * "What's happening?" box. This is exactly where threads broke.
 */
async function dialogOverTimeline(p) {
  await p.evaluate(() => {
    const d = document.createElement('div')
    d.setAttribute('role', 'dialog')
    d.innerHTML = `
      <div data-testid="tweetTextarea_0" contenteditable="true" id="d0">meet at 8</div>
      <div id="slot1" style="display:none">
        <div data-testid="tweetTextarea_1" contenteditable="true" id="d1"></div>
      </div>
      <div data-testid="addButton" role="button" id="dadd">Add post</div>
      <button data-testid="tweetButton" id="dpost">Post all</button>`
    document.body.appendChild(d)
    // Mimic X: "Add post" mounts the next part — and records whether an editor still had focus,
    // because on live X a press while the editor is focused throws that part's text away.
    window.__focusAtAdd = null
    d.querySelector('#dadd').addEventListener('click', () => {
      window.__focusAtAdd = document.activeElement?.getAttribute('data-testid') ?? 'none'
      d.querySelector('#slot1').style.display = 'block'
    })
    window.__posted = null
    d.querySelector('#dpost').addEventListener('click', () => {
      window.__focusAtPost = document.activeElement?.getAttribute('data-testid') ?? 'none'
      window.__posted = [...d.querySelectorAll('[contenteditable="true"]')].map((c) => c.innerText.trim())
    })
    // The timeline box holds an unrelated draft. If it held the message text, the leak gate would
    // (correctly) refuse to post, and the test would be measuring that instead.
    const timeline = [...document.querySelectorAll('[data-testid="tweetTextarea_0"]')].find((c) => !c.closest('[role="dialog"]'))
    timeline.textContent = 'unrelated timeline draft'
    d.querySelector('#d0').focus()
  })
}

describe('threads — scoped to the compose dialog, not the timeline behind it', () => {
  test('part 2 is the dialog\'s tweetTextarea_1, never the timeline composer', async (t) => {
    if (skipReason) return t.skip(skipReason)
    const p = await page()
    await dialogOverTimeline(p)
    const got = await p.evaluate(() => {
      document.getElementById('slot1').style.display = 'block'
      const { composers, composerAt, activePostButton } = window.lortnocX.selectors
      return {
        ids: composers().map((c) => c.id || 'TIMELINE'),
        part2: composerAt(1)?.id || 'TIMELINE',
        post: activePostButton()?.id || 'TIMELINE',
      }
    })
    // Page-wide, the timeline's own composer is a visible `tweetTextarea_0` too. Counting it made
    // it "part 2", so every thread wrote its second post into the home timeline box.
    assert.deepEqual(got.ids, ['d0', 'd1'])
    assert.equal(got.part2, 'd1')
    assert.equal(got.post, 'dpost', 'the modal\'s "Post all", not the timeline\'s disabled Post')
    await p.close()
  })

  test('a two-part post lands in the right boxes, with the editor blurred before each press', async (t) => {
    if (skipReason) return t.skip(skipReason)
    const p = await page()
    await dialogOverTimeline(p)
    const result = await p.evaluate(async () => {
      window.lortnocX.compose.installPostInterceptor(() => true, async () => [
        'first cover part #lortnoctahc',
        'second cover part #lortnoctahc',
      ])
      document.getElementById('dpost').click() // the user presses "Post all"
      for (let i = 0; i < 80 && !window.__posted; i++) await new Promise((r) => setTimeout(r, 100))
      const timeline = [...document.querySelectorAll('[data-testid="tweetTextarea_0"]')].find((c) => !c.closest('[role="dialog"]'))
      return { posted: window.__posted, focusAtAdd: window.__focusAtAdd, focusAtPost: window.__focusAtPost, timeline: timeline.innerText.trim() }
    })
    assert.deepEqual(result.posted, ['first cover part #lortnoctahc', 'second cover part #lortnoctahc'])
    // Measured on live X: pressing "Add post" while an editor is focused discards that part.
    assert.equal(result.focusAtAdd, 'none', 'an editor was still focused when "Add post" was pressed')
    assert.equal(result.focusAtPost, 'none', 'an editor was still focused when "Post all" was pressed')
    assert.equal(result.timeline, 'unrelated timeline draft', 'the timeline composer behind the modal was written to')
    await p.close()
  })
})

describe('inbound — the hashtag pre-filter is what makes a feed affordable', () => {
  test('only tagged tweets ever reach the decoder', async (t) => {
    if (skipReason) return t.skip(skipReason)
    const p = await page()
    const seen = await p.evaluate(async () => {
      const asked = []
      window.lortnocX.inbound.startInbound(
        () => true,
        async (cover) => {
          asked.push(cover)
          return null // definitively not ours
        },
      )
      await new Promise((r) => setTimeout(r, 700)) // debounce is 250ms
      return asked
    })
    // Untagged chatter and the mid-sentence hashtag must both be rejected locally. Spending a
    // model decode on every tweet in a feed is not viable — that is why the tag exists at all.
    assert.ok(seen.every((c) => !c.includes('breakfast')), `untagged tweet was decoded: ${seen}`)
    assert.ok(seen.every((c) => !c.includes('what even is')), 'a mid-sentence hashtag was treated as ours')
    assert.ok(seen.length >= 1, 'the tagged tweet should have been offered to the decoder')
    // The tag itself is stripped before the codec sees it — the codec must get byte-exact cover.
    assert.ok(seen.every((c) => !c.includes('#lortnoctahc')), 'the hashtag was not stripped')
    await p.close()
  })

  test('a decoded message is rendered inline and the cover is kept for the card', async (t) => {
    if (skipReason) return t.skip(skipReason)
    const p = await page()
    const rendered = await p.evaluate(async () => {
      window.lortnocX.inbound.startInbound(() => true, async () => 'MEET AT 8')
      await new Promise((r) => setTimeout(r, 700))
      const el = [...document.querySelectorAll('[data-testid="tweetText"]')].find((n) =>
        n.querySelector('.lortnoc-decoded'),
      )
      return el?.querySelector('.lortnoc-decoded')?.textContent ?? null
    })
    assert.equal(rendered, 'MEET AT 8')
    await p.close()
  })

  test('RETRY is not cached — a transient failure is retried, a null is not', async (t) => {
    if (skipReason) return t.skip(skipReason)
    const p = await page()
    const counts = await p.evaluate(async () => {
      let calls = 0
      const api = window.lortnocX.inbound.startInbound(() => true, async () => {
        calls++
        return window.lortnocX.RETRY
      })
      await new Promise((r) => setTimeout(r, 600))
      const afterFirst = calls
      api.reset()
      await new Promise((r) => setTimeout(r, 600))
      return { afterFirst, afterReset: calls }
    })
    // A RETRY verdict must leave the post eligible for another attempt. Caching it is the bug the
    // RETRY symbol exists to make impossible — it once rendered the literal word "retry".
    assert.ok(counts.afterReset > counts.afterFirst, 'a RETRY verdict was cached as final')
    await p.close()
  })
})

describe('inbound threads — the message reads from the top', () => {
  /** Replace the timeline with a two-post thread and decode it with a scripted codec. `order`
   *  decides which part completes the thread (the one that arrives last carries the text). */
  async function thread(p, { completes, failed = false }) {
    return p.evaluate(async ({ completes, failed }) => {
      const col = document.querySelector('[data-testid="primaryColumn"]')
      col.innerHTML = `
        <article data-testid="tweet"><a href="/k/status/9000000000000000001"><time>1m</time></a>
          <div data-testid="tweetText">first cover chatter #lortnoctahc</div></article>
        <article data-testid="tweet"><a href="/k/status/9000000000000000002"><time>1m</time></a>
          <div data-testid="tweetText">second cover chatter #lortnoctahc</div></article>`
      const seqOf = (cover) => (cover.startsWith('first') ? 0 : 1)
      window.lortnocX.inbound.startInbound(() => true, async (cover) => {
        const seq = seqOf(cover)
        // Arrival order: the part that "completes" is answered last.
        if (seq !== completes) return { thread: 't:2', seq, total: 2, text: null }
        await new Promise((r) => setTimeout(r, 300))
        return failed
          ? { thread: 't:2', seq, total: 2, text: null, failed: true }
          : { thread: 't:2', seq, total: 2, text: 'longer message triggering a break' }
      })
      await new Promise((r) => setTimeout(r, 1500))
      const [a, b] = [...col.querySelectorAll('[data-testid="tweetText"]')]
      const view = (el) => ({
        decoded: el.querySelector('.lortnoc-decoded')?.textContent ?? null,
        label: el.querySelector('.lortnoc-part:not(.lortnoc-part--waiting)')?.textContent ?? null,
        waiting: !!el.querySelector('.lortnoc-part--waiting'),
        text: el.textContent.trim(),
      })
      return { first: view(a), second: view(b) }
    }, { completes, failed })
  }

  test('the message appears on the FIRST post; the later part becomes a quiet label', async (t) => {
    if (skipReason) return t.skip(skipReason)
    const p = await page()
    // The common case, and the one the user hit: the LAST part completes the thread.
    const got = await thread(p, { completes: 1 })
    assert.equal(got.first.decoded, 'longer message triggering a break', 'message must be on the first post')
    assert.equal(got.second.decoded, null, 'the message must not also sit on the second post')
    assert.match(got.second.label ?? '', /part 2 of 2/)
    assert.equal(got.first.waiting, false, 'the "waiting" badge must go once the thread is complete')
    await p.close()
  })

  test('same result when the first post happens to complete the thread', async (t) => {
    if (skipReason) return t.skip(skipReason)
    const p = await page()
    const got = await thread(p, { completes: 0 })
    assert.equal(got.first.decoded, 'longer message triggering a break')
    assert.match(got.second.label ?? '', /part 2 of 2/)
    await p.close()
  })

  test('a thread that is not for us is left exactly as posted', async (t) => {
    if (skipReason) return t.skip(skipReason)
    const p = await page()
    const got = await thread(p, { completes: 1, failed: true })
    assert.equal(got.first.decoded, null)
    assert.equal(got.first.waiting, false, 'no leftover badge on someone else\'s thread')
    assert.equal(got.first.text, 'first cover chatter #lortnoctahc')
    assert.equal(got.second.text, 'second cover chatter #lortnoctahc')
    await p.close()
  })
})

describe('compose — fail closed, never post plaintext', () => {
  test('readCompose reads the Draft.js editor text', async (t) => {
    if (skipReason) return t.skip(skipReason)
    const p = await page()
    const text = await p.evaluate(() => {
      const el = window.lortnocX.selectors.activeCompose()
      return window.lortnocX.compose.readCompose(el)
    })
    assert.equal(text, 'meet at 8')
    await p.close()
  })

  test('a swap returning null does NOT post', async (t) => {
    if (skipReason) return t.skip(skipReason)
    const p = await page()
    const clicked = await p.evaluate(async () => {
      let posted = false
      document.querySelector('[data-testid="tweetButton"]').addEventListener('click', () => {
        posted = true
      })
      window.lortnocX.compose.installPostInterceptor(() => true, async () => null) // encode failed
      document.querySelector('[data-testid="tweetButton"]').click()
      await new Promise((r) => setTimeout(r, 400))
      return posted
    })
    // The whole point: when encoding fails the draft stays put. Posting here would publish the
    // user's plaintext to a public timeline, which is the one mistake that cannot be walked back.
    assert.equal(clicked, false, 'a failed encode still posted')
    await p.close()
  })

  test('ABORTS if the plaintext is still in the composer — never posts the secret', async (t) => {
    if (skipReason) return t.skip(skipReason)
    const p = await page()
    const result = await p.evaluate(async () => {
      let posted = false
      document.querySelector('[data-testid="tweetButton"]').addEventListener('click', () => { posted = true })

      const box = window.lortnocX.selectors.activeCompose()
      box.textContent = 'meet at 8' // the user's real message

      // Reproduce the field failure exactly: make insertText APPEND rather than replace, which
      // is what X did when the selection did not cover the editor contents. The cover text
      // arrives, every "did the cover land?" check passes — and the secret is still sitting there.
      document.execCommand = (cmd, _ui, value) => {
        if (cmd === 'insertText') { box.textContent = box.textContent + ' ' + value; return true }
        return true // selectAll etc. no-op, as they effectively did
      }

      window.lortnocX.compose.installPostInterceptor(() => true, async () => [
        'quiet morning here nothing much #lortnoctahc',
      ])
      document.querySelector('[data-testid="tweetButton"]').click()
      await new Promise((r) => setTimeout(r, 2500))
      return { posted, composer: box.innerText }
    })

    assert.ok(result.composer.includes('meet at 8'), 'the append simulation should leave the plaintext')
    assert.equal(result.posted, false, 'PLAINTEXT WAS POSTED — the leak gate did not fire')
    await p.close()
  })

  test('plain Enter is left alone — it is a newline on X, not a post', async (t) => {
    if (skipReason) return t.skip(skipReason)
    const p = await page()
    const swaps = await p.evaluate(async () => {
      let called = 0
      window.lortnocX.compose.installPostInterceptor(() => true, async () => {
        called++
        return null
      })
      const el = window.lortnocX.selectors.activeCompose()
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise((r) => setTimeout(r, 200))
      const afterPlain = called
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
      await new Promise((r) => setTimeout(r, 200))
      return { afterPlain, afterCtrl: called }
    })
    assert.equal(swaps.afterPlain, 0, 'plain Enter triggered a swap — it would break typing')
    assert.equal(swaps.afterCtrl, 1, 'Ctrl+Enter did not trigger a swap')
    await p.close()
  })
})
