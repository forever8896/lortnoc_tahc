// The reveal card — an extension-origin iframe. The page hands it COVER text (public); the message
// it recovers is rendered only here, never written into the page's DOM where the site's scripts
// could read it.
import { canonicalCover, inspect, openMessage } from '../../../shared/webframe.mjs'
import { fromB64 } from '../../../shared/keys.mjs'
import { gateReleaser } from '../../../shared/gateclient.mjs'
import { IDKit, proofOfHuman, selfieCheck } from '@worldcoin/idkit-core'
import QRCode from 'qrcode'
import { sw, gatePost } from '../shared/messages'
import type { GateHealth } from '../shared/messages'
import { readAuthor } from '../../../shared/member.mjs'
import { memberKey, rememberMember, ownedSpaces, banMember } from '../shared/spaces'
import type { DecodeData, FrameToContent } from '../shared/messages'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const toParent = (m: FrameToContent) => parent.postMessage(m, '*')

function setStatus(text: string, kind: '' | 'ok' | 'err' = '') {
  const s = $('status')
  s.textContent = text
  s.className = `status ${kind}`
}
function fit() {
  toParent({ lortnoc: 'resize', height: document.body.scrollHeight + 2 })
}

/** Passphrases typed in this card, in memory only — gone when the card closes. */
const tried: string[] = []
/** Why the gate said no, e.g. "not yet" + when — shown instead of a bare failure. */
const denied: { last: { deny?: string; retryAt?: number } | null } = { last: null }
/** The space this post belongs to, if any — only then does "unverified writer" mean something. */
let postSpace = ''
/** The reader chose to verify with World ID in this card (a click — never automatic). */
let wantsHuman = false
let cancelWorld: (() => void) | null = null

/**
 * World ID for the `human` check: ask the gate for a challenge bound to THIS post + THIS reader key,
 * run IDKit here (an extension-origin page, so the proof never passes through the site), and hand
 * the result back to the gate. Cancelling is the "alternative path": the post simply stays shut,
 * and a passphrase branch (if the author gave one) still works.
 */
async function worldProof({ check, ref, readerPub, policyHash }: { check: string; ref: string; readerPub: string; policyHash: string }) {
  if (check !== 'human') return undefined
  if (!wantsHuman) return null // not asked yet: don't pop a verification the reader didn't request
  const c = await gatePost('/challenge', { ref, readerPub, policyHash })
  if (!c?.request) throw new Error(c?.deny ?? c?.error ?? 'the gate could not start World ID')
  const q = c.request
  const preset = q.preset === 'selfie' ? selfieCheck({ signal: q.signal }) : proofOfHuman({ signal: q.signal })
  const req = await IDKit.request({
    app_id: q.app_id, action: q.action, rp_context: q.rp_context, allow_legacy_proofs: false, environment: q.environment,
  }).preset(preset)
  $('world').hidden = false
  $('verifyHuman').hidden = true
  $('sim').hidden = q.environment !== 'staging'
  await QRCode.toCanvas($<HTMLCanvasElement>('qr'), req.connectorURI, { width: 132, margin: 1 })
  fit()
  const abort = new AbortController()
  cancelWorld = () => abort.abort()
  $('sim').onclick = async () => {
    setStatus('Simulator is verifying…')
    const r = await sw<unknown>({ type: 'WORLD_SIM', connectUrl: req.connectorURI })
    setStatus(r.ok ? 'Simulator done — waiting for the proof…' : `Simulator: ${r.error}`, r.ok ? '' : 'err')
  }
  setStatus('Waiting for World ID…')
  // Our own poll loop instead of pollUntilCompletion: that one rejects on the first network blip
  // (measured: ERR_NETWORK_CHANGED mid-wait surfaced as a message-less rejection and killed a real
  // verification). Here a failed poll is retried; only World App's own verdict or Cancel ends it.
  const deadline = Date.now() + 180_000
  let result: unknown = null
  let misses = 0
  while (!result) {
    if (abort.signal.aborted) throw new Error('You cancelled World ID.')
    if (Date.now() > deadline) throw new Error('World ID timed out — try again.')
    try {
      const st = (await req.pollOnce()) as { type: string; result?: unknown; error?: string }
      misses = 0
      $('worldHow').dataset.state = st.type // visible to tests and devtools: waiting_for_connection → confirmed
      if (st.type === 'confirmed') result = st.result
      else if (st.type === 'failed') throw Object.assign(new Error(`World ID: ${String(st.error ?? 'failed').replace(/_/g, ' ')}`), { final: true })
    } catch (e) {
      if ((e as { final?: boolean }).final) throw e
      if (++misses > 10) throw new Error(`World ID: the connection keeps failing (${e instanceof Error ? e.message : String(e)})`)
    }
    if (!result) await new Promise((r) => setTimeout(r, 1000))
  }
  $('world').hidden = true
  cancelWorld = null
  setStatus('Checking the proof…')
  return result
}

const release = gateReleaser({
  post: gatePost,
  onDeny: (d: { deny?: string; retryAt?: number }) => (denied.last = d),
  proofFor: worldProof,
  // Joining a space: bind our member key to the pseudonym the gate derives from our World ID.
  extraFor: async (_check: string, params: { space?: string }) => (params.space ? { memberPub: (await memberKey(params.space)).pub } : {}),
  onRelease: (r: { member?: { space: string; memberId: string } }) => r.member && void rememberMember(r.member.space, r.member.memberId),
})
let frame: Uint8Array | null = null

async function show(raw: string, obfuscationOnly: boolean) {
  $('needs').hidden = true
  $('out').hidden = false
  // A member-signed post carries the gate's attestation inside the (encrypted) message.
  const g = await sw<GateHealth>({ type: 'GATE_HEALTH' })
  const { text, author } = readAuthor(raw, g.ok ? g.data.signPub : '')
  $('plain').textContent = text
  if (author) {
    $('author').hidden = false
    $('author').textContent = author.verified
      ? `✓ verified member ${author.memberId} · ${author.space}`
      : `⚠ claims to be ${author.memberId} of ${author.space} — the signature does not check out`
    const mine = (await ownedSpaces())[author.space]
    if (mine && author.verified) {
      const b = $<HTMLButtonElement>('ban')
      b.hidden = false
      b.textContent = `Ban ${author.memberId} from ${author.space}`
      b.onclick = async () => {
        try {
          await banMember(author.space, author.memberId)
          b.textContent = `${author.memberId} is banned — they cannot rejoin, even with a new account`
          b.disabled = true
        } catch (e) {
          setStatus(e instanceof Error ? e.message : String(e), 'err')
        }
      }
    }
  } else if (postSpace) {
    $('author').hidden = false
    $('author').textContent = `unverified writer — not signed by a member of ${postSpace}`
  }
  $('note').textContent = obfuscationOnly
    ? 'Anyone with the extension can read this one — it was hidden, not locked.'
    : 'Only readers who meet the author’s checks can see this.'
  setStatus('')
  fit()
}

async function attempt() {
  if (!frame) return
  const info = inspect(frame)!
  denied.last = null
  const needsGate = info.needs?.includes('after') || info.needs?.includes('human')
  const text = await openMessage(frame, { passphrases: tried, ...(needsGate ? { release } : {}) })
  if (text !== null) return void (await show(text, !!(info.honesty as { obfuscationOnly?: boolean } | undefined)?.obfuscationOnly))
  // (read through a cast: TS cannot see the onDeny callback assigning it during openMessage)
  const deny = denied.last as { retryAt?: number; deny?: string; check?: string } | null
  if (deny?.retryAt) setStatus(`Locked until ${new Date(deny.retryAt).toLocaleString()}.`, 'err')
  else if (deny?.check === 'human' && deny.deny) setStatus(deny.deny, 'err')
  else if (tried.length) setStatus('That didn’t open it.', 'err')
  $('verifyHuman').hidden = !info.needs?.includes('human') || !$('world').hidden
  fit()
}

async function main() {
  const hash = location.hash
  if (hash === '#none') return setStatus('No hidden posts found on this page. If you know one is there, select its text and right-click → Reveal.'), fit()
  const raw = hash.startsWith('#t=') ? decodeURIComponent(hash.slice(3)) : ''
  const cover = canonicalCover(raw)
  if (!cover) return setStatus('Nothing to reveal here.', 'err'), fit()

  const r = await sw<DecodeData>({ type: 'DECODE', coverText: cover })
  if (!r.ok) {
    return setStatus(
      r.error === 'not-cover'
        ? 'This isn’t a lortnoc message — or the site changed it.'
        : `Couldn’t reach the codec: ${r.error}`,
      'err',
    ), fit()
  }
  frame = fromB64(r.data.ciphertext)
  const info = inspect(frame)
  if (!info) return setStatus('This is a lortnoc message from another surface (X or Telegram) — open it there.', 'err'), fit()
  if (info.unsupported) return setStatus('This message needs a newer version of the extension.', 'err'), fit()

  const checks = $('checks')
  for (const c of info.checks ?? []) checks.append(Object.assign(document.createElement('span'), { className: 'chip', textContent: c }))
  $('needs').hidden = false
  $('pass').hidden = !info.needs?.includes('passphrase')
  $('identity').hidden = !info.needs?.includes('recipients')
  $('verifyHuman').hidden = !info.needs?.includes('human')
  postSpace = (info.checks ?? []).find((c: string) => c.includes(' · members of '))?.split(' · members of ')[1] ?? ''
  setStatus('')
  await attempt() // a public post, or a passphrase already typed in this card, opens straight away
  if ($('out').hidden && !$('pass').hidden) $<HTMLInputElement>('pw').focus()
}

async function tryPassphrase() {
  const pw = $<HTMLInputElement>('pw')
  if (!pw.value.trim()) return
  tried.push(pw.value)
  pw.value = ''
  setStatus('Checking…')
  await attempt()
}

$('try').onclick = () => void tryPassphrase()
$('verifyHuman').onclick = () => {
  wantsHuman = true
  void attempt().finally(() => (wantsHuman = false))
}
$('cancelWorld').onclick = () => {
  cancelWorld?.()
  $('world').hidden = true
  $('verifyHuman').hidden = false
  fit()
}
$<HTMLInputElement>('pw').addEventListener('keydown', (e) => e.key === 'Enter' && void tryPassphrase())
$('close').onclick = () => toParent({ lortnoc: 'close' })
document.addEventListener('keydown', (e) => e.key === 'Escape' && toParent({ lortnoc: 'close' }))
void main()
