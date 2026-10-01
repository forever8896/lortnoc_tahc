// shared/coverctx.mjs — what the codec2 writer tells the model about the page, and which page blocks
// the reader bothers to ask about. Decoding itself needs only the reply and the platform.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { threadContext, normaliseTitle, platformOf, replyText, looksLikeReply } from '../../shared/coverctx.mjs'

describe('context', () => {
  test('platforms', () => {
    assert.equal(platformOf('www.reddit.com'), 'reddit')
    assert.equal(platformOf('old.reddit.com'), 'reddit')
    assert.equal(platformOf('x.com'), 'x')
    assert.equal(platformOf('mobile.twitter.com'), 'x')
    assert.equal(platformOf('news.ycombinator.com'), 'news')
    assert.equal(platformOf('notreddit.com'), 'news')
  })

  test('the platform is the same on old and new reddit (it is part of the decode context)', () => {
    assert.equal(threadContext('a', 'www.reddit.com').platform, threadContext('b', 'old.reddit.com').platform)
  })

  test('thread = title, plus the parent comment when one was found', () => {
    assert.deepEqual(threadContext('(3) First 100km ride : r/cycling', 'www.reddit.com'), { thread: 'First 100km ride : r/cycling', platform: 'reddit' })
    const t = threadContext('First 100km ride', 'www.reddit.com', '  The hills\n are brutal. ')
    assert.equal(t.thread, 'First 100km ride\n\nThe hills are brutal.')
    assert.equal(threadContext('t', 'x.com', 'y'.repeat(1000)).thread.length, 'tnn'.length + 400) // title + blank line + the last 400 chars
  })

  test('unread counters and invisibles are dropped, length is capped', () => {
    assert.equal(normaliseTitle('(99+) Home / X'), 'Home / X')
    assert.equal(normaliseTitle('a​b'), 'ab')
    assert.equal(normaliseTitle('x'.repeat(500)).length, 200)
  })
})

describe('reply shape', () => {
  // real two-part replies from codec2 (opener + carrier)
  const REAL = [
    'Yesterday was my first outing of the year and I did some other short rides and built up my energy. I almost won\'t even know what the difference is. How long would it take to see a change?',
    "i just went there to try coffee and would definitely recommend it to people, as it's pretty good. i'm new here, but i've been saying all the above for years so im just sharing what others are saying.",
    'Honestly this took way too long. You should probably try to have a real job with a solid salary rather than living in a sweat shop at an expensive apartment.',
    'Nice take, nice coffee. Enjoy your hot take. I could probably give it my stamp of approval.',
  ]
  test('real codec2 replies pass', () => REAL.forEach((t) => assert.ok(looksLikeReply(t), t)))
  test('curly quotes and wrapping as a site renders them', () => {
    assert.ok(looksLikeReply('Let’s see if this one really works.\n I did some of the same stuff, and it works.'))
    assert.equal(replyText('Let’s  see\nit.'), "Let's see it.")
  })
  test('not replies', () => {
    assert.ok(!looksLikeReply('Too short.'))
    assert.ok(!looksLikeReply('This one never ends its sentence and just keeps going on'))
    assert.ok(!looksLikeReply('Emoji are never ours, so this one is out 🚲.'))
    assert.ok(!looksLikeReply(`${'word '.repeat(85)}end.`))
  })
})
