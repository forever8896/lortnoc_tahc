// Unread bookkeeping — the rule that decides whether an arriving message becomes a notification.
//
// This is worth pinning because the failure modes are both silent and both bad: too eager and
// signing in on a second device fires a banner for every message you have ever received; too
// lazy and a real message arrives with no signal at all, which is precisely the bug this module
// was written to fix (four sealed knocks sat unread on the relay because the receiving tab had
// no way to know they existed).
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// The module reads localStorage only INSIDE its load/save helpers, so a minimal stub is enough
// and the pure functions need nothing at all.
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
}

const {
  loadWatermarks, saveWatermarks, loadAnnouncedKnocks, saveAnnouncedKnocks,
  newestInbound, unreadByPeer, seedWatermarks, FRESH_MS,
} = await import('../../app/src/lib/unread.ts')

const ME = 'me.lortnoctahc.eth'
const PEER = 'kirsten.lortnoctahc.eth'

const conv = (peer, messages) => ({
  convId: `c:${peer}`, peer, seq: messages.length, updatedAt: 0, messages,
})
const msg = (from, ts, body = 'hi') => ({ v: 1, from, to: from === ME ? PEER : ME, ts, body })

beforeEach(() => store.clear())

describe('watermarks', () => {
  test('a device that has never stored one reads null, not an empty set', () => {
    // The caller uses exactly this distinction to decide "seed silently" vs "everything is new".
    assert.equal(loadWatermarks(), null)
    saveWatermarks({})
    assert.deepEqual(loadWatermarks(), {})
  })

  test('corrupt storage degrades to null rather than throwing', () => {
    store.set('lortnoc.unread.marks.v1', '{not json')
    assert.equal(loadWatermarks(), null)
  })

  test('seeding marks old history as caught up', () => {
    const NOW = 10_000_000
    const old = NOW - FRESH_MS - 1000
    const convos = [conv(PEER, [msg(PEER, old - 200), msg(ME, old - 100), msg(PEER, old)])]
    assert.deepEqual(seedWatermarks(convos, ME, NOW), { [PEER]: old })
    // Seeded, then diffed: nothing is unread, so a device with history stays silent.
    assert.deepEqual(unreadByPeer(convos, ME, seedWatermarks(convos, ME, NOW)), {})
  })

  test('seeding leaves the last few minutes UNREAD — the second-device demo case', () => {
    // Someone messages you, then you open the app on another device. Marking that read on sight
    // is the difference between a working notification and a silent one.
    const NOW = 10_000_000
    const convos = [conv(PEER, [msg(PEER, NOW - FRESH_MS - 1, 'old'), msg(PEER, NOW - 5_000, 'just now')])]
    const marks = seedWatermarks(convos, ME, NOW)
    assert.equal(marks[PEER], NOW - FRESH_MS - 1)
    assert.deepEqual(unreadByPeer(convos, ME, marks)[PEER].map((m) => m.body), ['just now'])
  })

  test('a conversation where only we have spoken seeds to 0, not to our own timestamp', () => {
    // Otherwise our own outbound message would suppress the peer's first reply if it arrived
    // with an earlier clock reading.
    assert.deepEqual(seedWatermarks([conv(PEER, [msg(ME, 500)])], ME, 10_000_000), { [PEER]: 0 })
  })
})

describe('what counts as unread', () => {
  test('our own messages never do', () => {
    const convos = [conv(PEER, [msg(ME, 100), msg(ME, 200)])]
    assert.deepEqual(unreadByPeer(convos, ME, {}), {})
  })

  test('inbound messages past the mark do, oldest first', () => {
    const convos = [conv(PEER, [msg(PEER, 100, 'a'), msg(PEER, 200, 'b'), msg(PEER, 300, 'c')])]
    const fresh = unreadByPeer(convos, ME, { [PEER]: 100 })
    assert.deepEqual(fresh[PEER].map((m) => m.body), ['b', 'c'])
  })

  test('a peer with no watermark is entirely unread', () => {
    // A peer who appears for the first time AFTER seeding is genuinely new — that is the knock
    // acceptance case, and it must notify.
    const convos = [conv(PEER, [msg(PEER, 100), msg(PEER, 200)])]
    assert.equal(unreadByPeer(convos, ME, { 'other.lortnoctahc.eth': 999 })[PEER].length, 2)
  })

  test('a mark at the newest message clears the conversation', () => {
    const convos = [conv(PEER, [msg(PEER, 100), msg(PEER, 200)])]
    assert.deepEqual(unreadByPeer(convos, ME, { [PEER]: 200 }), {})
  })

  test('peers are counted independently', () => {
    const other = 'kilian.lortnoctahc.eth'
    const convos = [conv(PEER, [msg(PEER, 300)]), conv(other, [msg(other, 50)])]
    const fresh = unreadByPeer(convos, ME, { [PEER]: 200, [other]: 100 })
    assert.deepEqual(Object.keys(fresh), [PEER])
  })
})

describe('newestInbound', () => {
  test('ignores our own messages even when they are newest', () => {
    assert.equal(newestInbound(conv(PEER, [msg(PEER, 100), msg(ME, 900)]), ME).ts, 100)
  })

  test('is null when the peer has never spoken', () => {
    assert.equal(newestInbound(conv(PEER, [msg(ME, 100)]), ME), null)
  })
})

describe('announced knocks', () => {
  test('round-trip, and a missing store reads as empty', () => {
    assert.deepEqual(loadAnnouncedKnocks(), [])
    saveAnnouncedKnocks(['a', 'b'])
    assert.deepEqual(loadAnnouncedKnocks(), ['a', 'b'])
  })

  test('the list is bounded — relay ids expire, so remembering all of them forever is waste', () => {
    saveAnnouncedKnocks(Array.from({ length: 500 }, (_, i) => `k${i}`))
    const kept = loadAnnouncedKnocks()
    assert.equal(kept.length, 200)
    assert.equal(kept.at(-1), 'k499') // the newest are the ones worth keeping
  })
})
