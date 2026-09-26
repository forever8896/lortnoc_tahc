// POST /demo/mint — the limits that protect the relayer's Sepolia ETH (relayer/demo.mjs).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createDemoMinter, PER_REQUEST, PER_IP_HOUR, PER_DAY } from '../demo.mjs'

const addr = (n) => '0x' + n.toString(16).padStart(40, '0')
function setup() {
  const sent = []
  let t = 1_000_000
  const h = createDemoMinter({ mintTo: async (to) => (sent.push(to), `0xtx${sent.length}`), now: () => t })
  return { h, sent, tick: (ms) => (t += ms) }
}

describe('demo passes', () => {
  test('mints to one address or a list, deduplicated and checksummed', async () => {
    const s = setup()
    const r = await s.h({ to: [addr(1), addr(1).toUpperCase().replace('0X', '0x'), addr(2)] }, 'ip')
    assert.equal(r.status, 200)
    assert.equal(r.body.minted.length, 2)
    assert.equal((await s.h({ to: addr(3) }, 'ip')).status, 200)
  })
  test('refuses junk and too many at once', async () => {
    const s = setup()
    assert.equal((await s.h({ to: ['nope'] }, 'ip')).status, 400)
    assert.equal((await s.h({}, 'ip')).status, 400)
    assert.equal((await s.h({ to: Array.from({ length: PER_REQUEST + 1 }, (_, i) => addr(i + 1)) }, 'ip')).status, 400)
    assert.equal(s.sent.length, 0)
  })
  test(`a visitor gets at most ${PER_IP_HOUR} an hour; another visitor is unaffected`, async () => {
    const s = setup()
    for (let i = 0; i < PER_IP_HOUR / PER_REQUEST; i++) assert.equal((await s.h({ to: [1, 2, 3, 4, 5].map((k) => addr(i * 10 + k)) }, 'a')).status, 200)
    assert.equal((await s.h({ to: addr(999) }, 'a')).status, 429)
    assert.equal((await s.h({ to: addr(999) }, 'b')).status, 200)
    s.tick(3600_001)
    assert.equal((await s.h({ to: addr(998) }, 'a')).status, 200)
  })
  test(`at most ${PER_DAY} a day in total`, async () => {
    const s = setup()
    let ok = 0
    for (let ip = 0; ok < PER_DAY; ip++) for (let j = 0; j < PER_IP_HOUR / PER_REQUEST && ok < PER_DAY; j++) {
      const r = await s.h({ to: [1, 2, 3, 4, 5].map((k) => addr(ip * 1000 + j * 10 + k)) }, `ip${ip}`)
      if (r.status === 200) ok += 5
    }
    assert.equal((await s.h({ to: addr(123456) }, 'fresh')).status, 429)
  })
  test('one failed mint does not hide the others', async () => {
    let n = 0
    const h = createDemoMinter({ mintTo: async () => (++n === 2 ? Promise.reject(new Error('nonce too low')) : '0xok') })
    const r = await h({ to: [addr(1), addr(2), addr(3)] }, 'ip')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.minted.map((m) => !!m.tx), [true, false, true])
  })
})
