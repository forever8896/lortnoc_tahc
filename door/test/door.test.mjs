// The codec2 front door against a fake boat API and a fake codec2 box. No Cloudflare needed.
//   node --test door/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DoorCore } from '../src/door.mjs'

function memStorage() {
  const m = new Map()
  let alarm = null
  return {
    m,
    get: async (k) => m.get(k),
    put: async (k, v) => { m.set(k, structuredClone(v)) },
    delete: async (k) => { m.delete(k) },
    getAlarm: async () => alarm,
    setAlarm: async (t) => { alarm = t },
    get alarm() { return alarm },
  }
}

/** A sandbox that is asleep until resumed, then takes `bootPolls` health checks to load the model. */
function world({ asleep = true, bootPolls = 2, pending = 0, pendingAge = 0 } = {}) {
  const w = { state: asleep ? 'archived' : 'running', boots: 0, resumes: 0, stops: 0, boxCalls: [], clock: 1_000_000 }
  w.fetchImpl = async (url, init = {}) => {
    const u = new URL(url)
    if (u.host === 'boat.dev') {
      assert.equal(init.headers.authorization, 'Bearer KEY')
      if (u.pathname.endsWith('/resume')) { w.resumes++; w.state = 'running'; w.boots = 0; return new Response('{}', { status: 202 }) }
      if (u.pathname.endsWith('/stop')) { w.stops++; w.state = 'archived'; return new Response('{}', { status: 202 }) }
      return Response.json({ sandbox: { state: w.state } })
    }
    // the box
    if (w.state !== 'running') throw new Error('connection refused')
    assert.equal(init.headers['x-door-secret'], 'SECRET')
    w.boxCalls.push([u.pathname, init.headers['x-client-ip']])
    if (u.pathname === '/health') {
      w.boots++
      return Response.json({ ready: w.boots > bootPolls, busy: !!w.busy, pending, pendingAge, flushInterval: 21600 })
    }
    if (u.pathname === '/reveal') return Response.json({ locators: ['aabbccdd00112233'] })
    if (u.pathname.startsWith('/drop/')) return Response.json({ frame: 'DECOY' })
    if (u.pathname === '/drop') return Response.json({ result: 'stored' }, { status: 201 })
    return Response.json({ text: 'hi' })
  }
  w.now = () => w.clock
  w.wait = async (ms) => { w.clock += ms }
  return w
}

const env = { BOX_URL: 'https://box.test', BOAT_SANDBOX: 'bx_1', BOAT_KEY: 'KEY', DOOR_SECRET: 'SECRET' }
const reveal = (text) => new Request('https://door/reveal', {
  method: 'POST', body: JSON.stringify({ text, platform: 'reddit', nbits: 64 }), headers: { 'cf-connecting-ip': '1.2.3.4' },
})

test('a request to a sleeping machine resumes it, waits for the model, then answers', async () => {
  const w = world()
  const d = new DoorCore(memStorage(), env, w)
  const r = await d.handle(reveal('Nice point. I had the same thought.'))
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { locators: ['aabbccdd00112233'] })
  assert.equal(w.resumes, 1)
  assert.deepEqual(w.boxCalls.at(-1), ['/reveal', '1.2.3.4'])     // the real client IP, for rate limits
})

test('ten requests at once wake the machine once', async () => {
  const w = world()
  const d = new DoorCore(memStorage(), env, w)
  const rs = await Promise.all([...Array(10)].map((_, i) => d.handle(reveal(`reply number ${i} here`))))
  assert.ok(rs.every((r) => r.status === 200))
  assert.equal(w.resumes, 1)
})

test('a reveal already answered never wakes the machine again', async () => {
  const w = world()
  const s = memStorage()
  const d = new DoorCore(s, env, w)
  await d.handle(reveal('Same reply text.'))
  w.state = 'archived'; d.readyAt = 0
  const r = await d.handle(reveal('  Same reply text. '))             // trimmed like the server does
  assert.equal(r.headers.get('x-door'), 'cache')
  assert.equal(w.resumes, 1)
})

test('a frame cached as a decoy is replaced by the write that makes the locator real', async () => {
  const w = world({ asleep: false, bootPolls: 0 })
  const d = new DoorCore(memStorage(), env, w)
  const loc = 'aabbccdd00112233'
  assert.equal((await (await d.handle(new Request(`https://door/drop/${loc}`))).json()).frame, 'DECOY')
  const put = await d.handle(new Request('https://door/drop', { method: 'POST', body: JSON.stringify({ locator: loc.toUpperCase(), token: 't', frame: 'REAL' }) }))
  assert.equal(put.status, 201)
  const got = await d.handle(new Request(`https://door/drop/${loc}`))
  assert.equal(got.headers.get('x-door'), 'cache')
  assert.equal((await got.json()).frame, 'REAL')
})

test('/health answers without waking anything', async () => {
  const w = world()
  const d = new DoorCore(memStorage(), env, w)
  assert.equal((await d.handle(new Request('https://door/health'))).status, 200)
  assert.equal(w.resumes, 0)
  assert.equal(w.boxCalls.length, 0)
})

test('idle → stop; busy → wait; recent traffic → wait', async () => {
  const w = world({ asleep: false, bootPolls: 0 })
  const s = memStorage()
  const d = new DoorCore(s, env, w)
  await d.handle(reveal('one'))
  await d.alarm()
  assert.equal(w.stops, 0, 'just used: stays up')
  w.clock += 11 * 60_000
  w.busy = true
  await d.alarm()
  assert.equal(w.stops, 0, 'mid-flush or mid-hide: stays up')
  w.busy = false
  await d.alarm()
  assert.equal(w.stops, 1)
  assert.equal(w.state, 'archived')
})

test('posts waiting for Walrus: the door wakes the machine when the oldest is due', async () => {
  const w = world({ asleep: false, bootPolls: 0, pending: 3, pendingAge: 3600 })
  const s = memStorage()
  const d = new DoorCore(s, env, w)
  await d.handle(reveal('one'))
  w.clock += 11 * 60_000
  await d.alarm()
  assert.equal(w.stops, 1)
  const flushAt = await s.get('flushAt')
  assert.ok(flushAt > w.clock + 4.9 * 3600_000 && flushAt < w.clock + 5.1 * 3600_000, '6 h interval minus 1 h waited')
  assert.equal(s.alarm, flushAt)
  w.clock = flushAt
  await d.alarm()
  assert.equal(w.resumes, 1, 'woken for the upload')
})

test('a resume that never comes up returns 503, not a hang', async () => {
  const w = world({ bootPolls: 1e9 })
  const d = new DoorCore(memStorage(), env, w)
  const r = await d.handle(reveal('x'))
  assert.equal(r.status, 503)
})
