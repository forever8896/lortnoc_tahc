// Freemium metering (§9) — the conversion engine, and the one place the product deliberately
// trades enforcement for honesty. These tests pin the BEHAVIOUR; the audit covers the fact
// that client-side metering is bypassable by design (CLAUDE.md §9 says so out loud).
//
// What matters here is the reconciliation with the server's authoritative count: the codec
// became the real gate (codec/auth.py), and a mismatch between the two counters shows up to
// the user as a paywall that fires early or never fires at all.
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { installChromeStub } from '../lib/env.mjs'

const store = installChromeStub()

const meter = await import('../../extension/src/content/metering.ts')
const { FREE_LIMIT, WARN_AT, LOCAL } = await import('../../extension/src/shared/config.ts')

beforeEach(async () => {
  store.reset()
  await meter.loadMeter() // cold profile → zeroed state
  await meter.setPaid(false)
  // loadMeter only overwrites when storage has a value, so explicitly re-zero the counter.
  await meter.syncFromServer(FREE_LIMIT, false)
})

describe('free-tier counting', () => {
  test('a cold install starts with the full free allowance', () => {
    assert.equal(meter.sends(), 0)
    assert.equal(meter.remaining(), FREE_LIMIT)
    assert.equal(meter.isBlocked(), false)
  })

  test('each send decrements the allowance exactly once', async () => {
    for (let i = 1; i <= 3; i++) {
      await meter.increment()
      assert.equal(meter.sends(), i)
      assert.equal(meter.remaining(), FREE_LIMIT - i)
    }
  })

  test('blocks precisely AT the limit, not one send early or late', async () => {
    for (let i = 0; i < FREE_LIMIT - 1; i++) await meter.increment()
    assert.equal(meter.isBlocked(), false, `blocked with ${meter.remaining()} sends still owed`)
    await meter.increment()
    assert.equal(meter.isBlocked(), true, 'the free limit was exceeded without blocking')
  })

  test('remaining() floors at zero and never goes negative', async () => {
    for (let i = 0; i < FREE_LIMIT + 5; i++) await meter.increment()
    assert.equal(meter.remaining(), 0)
  })

  test('the "running low" nudge fires in the warning band and nowhere else', async () => {
    assert.equal(meter.isRunningLow(), false)
    for (let i = 0; i < WARN_AT; i++) await meter.increment()
    assert.equal(meter.isRunningLow(), true, `no nudge at ${WARN_AT}/${FREE_LIMIT}`)
    for (let i = WARN_AT; i < FREE_LIMIT; i++) await meter.increment()
    assert.equal(meter.isRunningLow(), false, 'still nudging after the limit — should be blocking')
  })
})

describe('membership bypasses the meter', () => {
  test('a paid member is never blocked, however many sends', async () => {
    for (let i = 0; i < FREE_LIMIT + 20; i++) await meter.increment()
    assert.equal(meter.isBlocked(), true)
    await meter.setPaid(true)
    assert.equal(meter.isBlocked(), false)
    assert.equal(meter.isRunningLow(), false, 'a member was nudged to upgrade')
  })

  test('the membership token round-trips through storage.local', async () => {
    assert.equal(await meter.getMembershipToken(), undefined)
    await store.chrome.storage.local.set({ [LOCAL.membership]: 'body.sig' })
    assert.equal(await meter.getMembershipToken(), 'body.sig')
  })

  test('an empty-string token reads as absent, not as a valid token', async () => {
    // A blank token must not be forwarded to the codec as if it were a capability.
    await store.chrome.storage.local.set({ [LOCAL.membership]: '' })
    assert.equal(await meter.getMembershipToken(), undefined)
  })
})

describe('reconciliation with the codec (server is authoritative, §7)', () => {
  test('mirrors the server count instead of trusting the local one', async () => {
    await meter.increment() // local thinks 1
    await meter.syncFromServer(4, false) // server says 4 remaining
    assert.equal(meter.remaining(), 4)
    assert.equal(meter.sends(), FREE_LIMIT - 4)
  })

  test('a server "member: true" flips the local paid flag', async () => {
    await meter.syncFromServer(-1, true)
    assert.equal(meter.isPaid(), true)
    assert.equal(meter.isBlocked(), false)
  })

  test('markBlocked (a 402 from the codec) blocks immediately', async () => {
    assert.equal(meter.isBlocked(), false)
    await meter.markBlocked()
    assert.equal(meter.isBlocked(), true)
  })

  test('state survives a content-script reload via storage.local', async () => {
    await meter.increment()
    await meter.increment()
    const persisted = store.peek('local', LOCAL.meter)
    assert.equal(persisted.sends, 2, 'the counter was not mirrored to storage')
    await meter.loadMeter()
    assert.equal(meter.sends(), 2)
  })

  test('metering state is in storage.local — it must SURVIVE a browser restart', async () => {
    // The mirror image of the session-key test: keys must not survive, quota must.
    await meter.increment()
    assert.ok(store.peek('local', LOCAL.meter))
    assert.equal(store.peek('session', LOCAL.meter), undefined)
  })
})
