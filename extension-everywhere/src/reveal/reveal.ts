// The reveal card — an extension-origin iframe. The page hands it COVER text (public); the message
// it recovers is rendered only here, never written into the page's DOM where the site's scripts
// could read it.
import { canonicalCover, inspect, openMessage } from '../../../shared/webframe.mjs'
import { fromB64 } from '../../../shared/keys.mjs'
import { gateReleaser } from '../../../shared/gateclient.mjs'
import { sw, gatePost } from '../shared/messages'
import type { GateHealth } from '../shared/messages'
import { readAuthor } from '../../../shared/member.mjs'
import { memberKey, rememberMember, ownedSpaces, banMember, ensKeys } from '../shared/spaces'
import { writeBan } from '../shared/ensWrite'
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
/** …or to prove NFT ownership with their wallet (a click — never automatic). */
let wantsNft = false

async function nftProof({ ref, readerPub, policyHash }: { ref: string; readerPub: string; policyHash: string }) {
  if (!wantsNft) return null
  const c = await gatePost('/challenge', { ref, readerPub, policyHash })
  if (!c?.request) throw new Error(c?.deny ?? c?.error ?? 'the gate could not start the NFT check')
  setStatus('Sign the message in your wallet…')
  const w = await sw<{ address: string; sig: string }>({ type: 'WALLET_SIGN', message: c.request.message })
  if (!w.ok) throw new Error(w.error)
  setStatus('Checking the collection…')
  return { nonce: c.request.nonce, address: w.data.address, sig: w.data.sig }
}
let cancelWorld: (() => void) | null = null
/** The World ID tab we are waiting on — its widget is told the gate's verdict (see onRelease/onDeny). */
let worldTab: string | null = null
const tellWidget = (ok: boolean, deny?: string) => {
  if (!worldTab) return
  void chrome.runtime.sendMessage({ type: 'WORLD_WIDGET_VERDICT', id: worldTab, ok, deny }).catch(() => {})
  worldTab = null
}

/**
 * World ID for the `human` check: ask the gate for a challenge bound to THIS post + THIS reader key,
 * then open World's own IDKit widget (IDKitRequestWidget) in an extension tab — src/world/ — with that
 * signed request. The proof comes back here and goes to the gate; the widget waits for the gate's
 * verdict. Cancelling (or closing the widget) is the "alternative path": the post stays shut, and a
 * passphrase branch (if the author gave one) still works.
 */
async function worldProof({ check, ref, readerPub, policyHash }: { check: string; ref: string; readerPub: string; policyHash: string }) {
  if (check !== 'human') return undefined
  if (!wantsHuman) return null // not asked yet: don't pop a verification the reader didn't request
  const c = await gatePost('/challenge', { ref, readerPub, policyHash })
  if (!c?.request) throw new Error(c?.deny ?? c?.error ?? 'the gate could not start World ID')
  const q = c.request
  const id = crypto.randomUUID()

  $('world').hidden = false
  $('verifyHuman').hidden = true
  // The simulator only does Proof of Human, and only on staging; nationality needs World App or Sandbox.
  $('sim').hidden = q.environment !== 'staging' || q.preset === 'identity'
  $('worldHow').textContent = q.preset === 'identity'
    ? `World ID opened in a new tab. It checks your passport's nationality is ${q.attributes?.[0]?.value} — nothing else is shared.`
    : "World ID opened in a new tab — scan its code with World App. Only that you're a unique human is shared."
  fit()

  const result = await new Promise<unknown>((resolve, reject) => {
    const done = () => (chrome.runtime.onMessage.removeListener(on), (cancelWorld = null))
    const closeTab = () => void sw({ type: 'WORLD_WIDGET_DONE', id })
    function on(m: { type?: string; id?: string; result?: unknown }) {
      if (m?.id !== id) return
      if (m.type === 'WORLD_WIDGET_RESULT') (done(), resolve(m.result))
      if (m.type === 'WORLD_WIDGET_CLOSED') (done(), reject(new Error('You closed World ID.')))
    }
    chrome.runtime.onMessage.addListener(on)
    cancelWorld = () => (done(), closeTab(), reject(new Error('You cancelled World ID.')))
    void sw({ type: 'WORLD_WIDGET_OPEN', id, request: q }).then((r) => {
      if (!r.ok) (done(), reject(new Error(`Could not open World ID: ${r.error}`)))
    })
    // Staging demo: World's simulator completes the WIDGET's own request (the widget tab reads its
    // connect link and asks the gate to run the simulator) — so the demo takes the same path as a phone.
    $('sim').onclick = () => (setStatus('Simulator is verifying…'), void chrome.runtime.sendMessage({ type: 'WORLD_WIDGET_SIMULATE', id }).catch(() => {}))
  })
  worldTab = id
  $('world').hidden = true
  setStatus('Checking the proof…')
  return result
}

const release = gateReleaser({
  post: gatePost,
  onDeny: (d: { deny?: string; retryAt?: number; check?: string }) => ((denied.last = d), d.check === 'human' && tellWidget(false, d.deny)),
  proofFor: (r: { check: string; ref: string; readerPub: string; policyHash: string }) => (r.check === 'nft' ? nftProof(r) : worldProof(r)),
  // Joining a space: bind our member key to the pseudonym the gate derives from our World ID.
  extraFor: async (_check: string, params: { space?: string }) => (params.space ? { memberPub: (await memberKey(params.space)).pub } : {}),
  onRelease: (r: { member?: { space: string; memberId: string } }) => (tellWidget(true), r.member && void rememberMember(r.member.space, r.member.memberId)),
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
    const isEns = author.space.startsWith('@')
    const ensKey = isEns ? (await ensKeys())[author.space.slice(1)] : undefined
    const mine = isEns ? ensKey : (await ownedSpaces())[author.space]
    if (mine && author.verified) {
      const b = $<HTMLButtonElement>('ban')
      b.hidden = false
      b.textContent = `Ban ${author.memberId} from ${isEns ? `${author.space.slice(1)}.space` : author.space}`
      b.onclick = async () => {
        try {
          if (ensKey) {
            // ENS space: the ban is written into the space's own ENS record, on-chain and public.
            b.disabled = true
            b.textContent = 'Writing the ban to ENS…'
            await writeBan(author.space, author.memberId, ensKey.priv)
          } else await banMember(author.space, author.memberId)
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
  const needsGate = ['after', 'human', 'nft'].some((c) => info.needs?.includes(c))
  const text = await openMessage(frame, { passphrases: tried, ...(needsGate ? { release } : {}) })
  if (text !== null) return void (await show(text, !!(info.honesty as { obfuscationOnly?: boolean } | undefined)?.obfuscationOnly))
  // (read through a cast: TS cannot see the onDeny callback assigning it during openMessage)
  const deny = denied.last as { retryAt?: number; deny?: string; check?: string } | null
  if (deny?.retryAt) setStatus(`Locked until ${new Date(deny.retryAt).toLocaleString()}.`, 'err')
  else if ((deny?.check === 'human' || deny?.check === 'nft') && deny.deny) setStatus(deny.deny, 'err')
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

  $('checks').textContent = `Locked · ${(info.checks ?? []).join(' · ')}`
  $('needs').hidden = false
  $('pass').hidden = !info.needs?.includes('passphrase')
  $('identity').hidden = !info.needs?.includes('recipients')
  $('verifyHuman').hidden = !info.needs?.includes('human')
  $('proveNft').hidden = !info.needs?.includes('nft')
  postSpace = (info.checks ?? []).find((c: string) => c.includes(' · members of '))?.split(' · members of ')[1]
    ?? (info.checks ?? []).find((c: string) => c.startsWith('Holders of '))?.replace(/^Holders of |'s NFT$/g, '') ?? ''
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
$('proveNft').onclick = () => {
  wantsNft = true
  void attempt().finally(() => (wantsNft = false))
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
