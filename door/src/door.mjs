/**
 * The front door for codec2 on boat. codec2 needs a 4 vCPU / 8 GB machine to hold its model, but only
 * while somebody hides or reveals; boat bills per second. So the machine sleeps, and this Worker —
 * always on, nearly free — wakes it on demand and puts it back to sleep when idle.
 *
 *   request ──► Worker ──► Door (one Durable Object: one wake at a time, one idle clock)
 *                            ├─ cached?          answer without waking (reveal results, drop frames)
 *                            ├─ machine asleep?  boat resume → wait for codec2 /health ready
 *                            └─ forward with X-Door-Secret + X-Client-IP
 *   alarm: idle IDLE_MS and not busy → boat stop; posts waiting for Walrus → wake again in time
 *   cron (weekly): wake once, so boat never expires a stopped disk (it may after 14 days)
 *
 * What it caches, and why that is safe:
 *   /reveal  deterministic: the same reply text on the same platform always decodes the same way.
 *            Without this, every "Always on" reader scrolling a feed keeps the machine awake.
 *   /drop/x  a frame never changes once written (first write wins), and EVERY write passes through
 *            here, so a successful POST /drop overwrites whatever was cached for that locator —
 *            including a decoy someone fetched before the post existed.
 * Both are what the codec server sees anyway: public reply text, random locators, sealed frames.
 */

const IDLE_MS = 10 * 60_000
const BUSY_RETRY_MS = 2 * 60_000
const WAKE_POLL_MS = 2_000
const WAKE_LIMIT_MS = 150_000
const HEALTH_FRESH_MS = 20_000
const BOAT_API = 'https://boat.dev/api/v1'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}

export function json(status, obj, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...CORS, ...extra } })
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Everything stateful, written against small interfaces so tests can drive it without Cloudflare:
 *   storage  get/put/delete/getAlarm/setAlarm   (DurableObjectStorage)
 *   env      BOX_URL, BOAT_SANDBOX, BOAT_KEY, DOOR_SECRET
 *   fetchImpl, now, wait                         (injected for tests)
 */
export class DoorCore {
  constructor(storage, env, { fetchImpl = fetch, now = Date.now, wait = sleep } = {}) {
    this.storage = storage
    this.env = env
    // wrapped: Workers throw "Illegal invocation" if the global fetch is called as this.fetch(...)
    this.fetch = (...a) => fetchImpl(...a)
    this.now = now
    this.wait = wait
    this.waking = null          // the one wake in progress; concurrent requests share it
    this.readyAt = 0            // last time codec2 said ready
  }

  // ---------------------------------------------------------------- the box
  box(path, init = {}, clientIp = '') {
    const headers = { ...(init.headers || {}), 'x-door-secret': this.env.DOOR_SECRET }
    if (clientIp) headers['x-client-ip'] = clientIp
    return this.fetch(this.env.BOX_URL + path, { ...init, headers })
  }

  async health(timeoutMs = 4000) {
    try {
      const r = await this.box('/health', { signal: AbortSignal.timeout(timeoutMs) })
      return r.ok ? await r.json() : null
    } catch {
      return null
    }
  }

  boat(path, method = 'GET', body = {}) {
    return this.fetch(`${BOAT_API}/sandboxes/${this.env.BOAT_SANDBOX}${path}`, {
      method, headers: { authorization: `Bearer ${this.env.BOAT_KEY}`, 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    })
  }

  /** boat drops hosted ports on stop (measured 2026-11-10); re-registering gives back the same URL. */
  host() {
    return this.boat('/host', 'POST', { port: 8080, public: true })
  }

  async boatState() {
    const r = await this.boat('')
    if (!r.ok) throw new Error(`boat status ${r.status}`)
    return (await r.json()).sandbox?.state
  }

  /** Resolve once codec2 answers ready, resuming the sandbox first if it is asleep. */
  awake() {
    if (this.now() - this.readyAt < HEALTH_FRESH_MS) return Promise.resolve()
    this.waking ??= this._wake().finally(() => { this.waking = null })
    return this.waking
  }

  async _wake() {
    const h = await this.health()
    if (h?.ready) { this.readyAt = this.now(); return }
    const t0 = this.now()
    let state = await this.boatState()
    // measured 2026-11-10: a full stop reports `stopped` (~4 min to settle); resume → ready in ~3 s
    const stopping = (st) => st === 'archiving' || st === 'stopping'
    if (['archived', 'archiving', 'stopped', 'stopping'].includes(state)) {
      if (stopping(state)) {         // mid-stop: boat refuses resume until it finishes
        while (stopping(state) && this.now() - t0 < WAKE_LIMIT_MS) { await this.wait(WAKE_POLL_MS); state = await this.boatState() }
      }
      const r = await this.boat('/resume', 'POST')
      if (!r.ok && r.status !== 409) throw new Error(`boat resume ${r.status}`)
    }
    // up to WAKE_LIMIT_MS for the machine, then the port route, then the container, then the model
    let hosted = false
    while (this.now() - t0 < WAKE_LIMIT_MS) {
      const hh = await this.health()
      if (hh?.ready) { this.readyAt = this.now(); return }
      if (!hosted && ['ready', 'idle', 'running'].includes(await this.boatState())) {
        const r = await this.host()
        if (!r.ok) throw new Error(`boat host ${r.status}`)
        hosted = true
      }
      await this.wait(WAKE_POLL_MS)
    }
    throw new Error('codec2 did not wake in time')
  }

  // ---------------------------------------------------------------- sleep
  async touch() {
    await this.storage.put('lastSeen', this.now())
    // an alarm may already be set far ahead (a Walrus wake); the idle check must still come first
    const at = await this.storage.getAlarm()
    if (!at || at > this.now() + IDLE_MS) await this.storage.setAlarm(this.now() + IDLE_MS)
  }

  /** Durable Object alarm: put the machine to sleep when idle, and wake it when Walrus is due. */
  async alarm() {
    const now = this.now()
    const flushAt = (await this.storage.get('flushAt')) || 0
    if (flushAt && now >= flushAt) {            // a sleeping machine has posts waiting for Walrus
      await this.storage.delete('flushAt')
      await this.awake()                        // its archiver uploads within seconds of boot
      await this.storage.put('lastSeen', now)
    }
    const lastSeen = (await this.storage.get('lastSeen')) || 0
    if (now - lastSeen < IDLE_MS) return this._next(lastSeen + IDLE_MS)
    const h = await this.health()
    if (h?.busy) return this._next(now + BUSY_RETRY_MS)
    if (h || this.readyAt) {
      const r = await this.boat('/stop', 'POST')
      if (!r.ok && r.status !== 409) return this._next(now + BUSY_RETRY_MS)
      this.readyAt = 0
      // posts not on Walrus yet: come back when the oldest is due (codec2 FLUSH_INTERVAL)
      if (h?.pending) {
        const wakeAt = now + Math.max(60_000, ((h.flushInterval ?? 21600) - (h.pendingAge ?? 0)) * 1000 + 60_000)
        await this.storage.put('flushAt', wakeAt)
        return this._next(wakeAt)
      }
    }
  }

  async _next(at) {
    const flushAt = (await this.storage.get('flushAt')) || Infinity
    await this.storage.setAlarm(Math.min(at, flushAt))
  }

  /** Weekly cron: keep the stopped disk from expiring, and let any waiting posts upload. */
  async maintain() {
    await this.awake()
    await this.touch()
  }

  // ---------------------------------------------------------------- requests
  async handle(req) {
    const url = new URL(req.url)
    const path = url.pathname
    const ip = req.headers.get('cf-connecting-ip') || ''
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    if (req.method === 'GET' && path === '/health') {
      // never wakes the machine: popups and settings pages call this
      const fresh = this.now() - this.readyAt < HEALTH_FRESH_MS
      return json(200, { model: 'codec2', ready: true, awake: fresh })
    }

    let body = ''
    let cacheKey = null
    if (req.method === 'POST' && path === '/reveal') {
      body = await req.text()
      let q
      try { q = JSON.parse(body) } catch { return json(400, { error: 'bad json' }) }
      cacheKey = 'r:' + (await sha256hex(JSON.stringify([q.platform ?? '', q.nbits ?? 64, String(q.text ?? '').trim()])))
    } else if (req.method === 'GET' && /^\/drop\/[0-9a-fA-F]{8,32}$/.test(path)) {
      cacheKey = 'd:' + path.slice(6).toLowerCase()
    } else if (req.method === 'POST') {
      body = await req.text()
    } else {
      return json(404, { error: 'not found' })
    }

    if (cacheKey) {
      const hit = await this.storage.get(cacheKey)
      if (hit) return json(200, hit, { 'x-door': 'cache' })
    }

    try {
      await this.awake()
    } catch (e) {
      return json(503, { error: 'waking up, try again in a minute', detail: String(e.message || e) })
    }
    await this.touch()
    const r = await this.box(path, req.method === 'POST'
      ? { method: 'POST', body, headers: { 'content-type': 'application/json' } }
      : {}, ip)
    const text = await r.text()

    if (r.ok && cacheKey) {
      try { await this.storage.put(cacheKey, JSON.parse(text)) } catch { /* not json: don't cache */ }
    }
    if (r.status === 201 && path === '/drop') {
      // the write that makes a locator real replaces any decoy cached for it before
      try {
        const q = JSON.parse(body)
        await this.storage.put('d:' + String(q.locator).toLowerCase(), { frame: q.frame })
      } catch { /* the box accepted it; the cache just misses next time */ }
    }
    return new Response(text, { status: r.status, headers: { 'content-type': 'application/json', ...CORS } })
  }
}

// ------------------------------------------------------------------ Cloudflare bindings
export class Door {
  constructor(state, env) {
    this.core = new DoorCore(state.storage, env)
  }
  fetch(req) {
    if (new URL(req.url).pathname === '/__maintain') return this.core.maintain().then(() => json(200, { ok: true }))
    return this.core.handle(req)
  }
  alarm() {
    return this.core.alarm()
  }
}

const stub = (env) => env.DOOR.get(env.DOOR.idFromName('codec2'))

export default {
  fetch(req, env) {
    if (new URL(req.url).pathname === '/__maintain') return json(404, { error: 'not found' })
    return stub(env).fetch(req)
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil(stub(env).fetch('https://door/__maintain'))
  },
}
