// Sealed posts in the service worker: finding them, opening them with the keyring, and connecting
// keyring credentials (World ID, wallets) to the gate — all here, so it survives the popup closing
// (it does the moment a World ID tab or a wallet opens).
//
// Opened plaintext is held in storage.session (extension-only, memory-backed, gone when the browser
// closes) for the reveal card to show. It never goes to the page: the content script only learns
// WHICH block opened, and the card is an extension-origin frame.
import { DEFAULT_GATE_URL, LOCAL } from '../shared/messages'
import type { SwResponse, WorldRequest } from '../shared/messages'
import { canonicalCover, inspect } from '../../../shared/webframe.mjs'
import { openPost, sealedRef, passKey } from '../../../shared/sealed.mjs'
import { unlockRefs } from '../../../shared/gateclient.mjs'
import { fromB64, toHex } from '../../../shared/keys.mjs'
import { keyring, saveKeyring, passKeys, labelFor } from '../shared/keyring'
import type { Claims } from '../shared/keyring'

async function gateBase(): Promise<string> {
  const got = await chrome.storage.local.get(LOCAL.gateUrl)
  return ((got[LOCAL.gateUrl] as string) || DEFAULT_GATE_URL).replace(/\/+$/, '')
}
async function gate(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${await gateBase()}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  })
  return r.json()
}

// ---------------------------------------------------------------------------
// Finding + opening
// ---------------------------------------------------------------------------
type Opened = { text: string; checks: string[]; obfuscationOnly: boolean; members: { space: string; memberId: string }[] }

/**
 * @param frames decoded candidates: index in the page's block list → frame bytes
 * @returns sealed posts the keyring opened (id to show them by), and legacy (mode 5) posts
 */
export async function openCandidates(frames: { i: number; frame: Uint8Array }[]) {
  const kr = await keyring()
  const keys = passKeys(kr)
  // one gate round trip for the whole page — it cannot know which candidates are its posts, nor can we
  let unlocked = new Map<string, { shares: Uint8Array[]; members: { space: string; memberId: string }[] }>()
  const refs = frames.map((f) => sealedRef(f.frame)).filter(Boolean) as Uint8Array[]
  if (refs.length) {
    try {
      unlocked = await unlockRefs({ post: gate, token: kr.token, refs, memberPub: kr.member.pub })
    } catch {} // gate down: passphrase and "anyone" posts still open
  }
  const opened: { i: number; id: string }[] = []
  const legacy: number[] = []
  const store: Record<string, Opened> = {}
  for (const { i, frame } of frames) {
    const u = unlocked.get(toHex(sealedRef(frame) ?? new Uint8Array()))
    const o = await openPost(frame, { keys, gateShares: u?.shares ?? [] })
    if (o) {
      const id = crypto.randomUUID()
      store[`sealed:${id}`] = { text: o.text, checks: o.checks, obfuscationOnly: !!(o.honesty as { obfuscationOnly?: boolean }).obfuscationOnly, members: u?.members ?? [] }
      opened.push({ i, id })
      for (const m of u?.members ?? []) await rememberMember(m.space, m.memberId, kr.member)
    } else if (inspect(frame)) legacy.push(i) // an older post that shows its rule — the reveal card handles it
  }
  if (opened.length) await chrome.storage.session.set(store)
  return { opened, legacy }
}

export async function sealedGet(id: string): Promise<SwResponse> {
  const v = (await chrome.storage.session.get(`sealed:${id}`))[`sealed:${id}`]
  return v ? { ok: true, data: v } : { ok: false, error: 'gone — find hidden posts again' }
}

/** Joining a space through a sealed post: the keyring's member key signs "post as my member name". */
async function rememberMember(space: string, memberId: string, member: { priv: string; pub: string }) {
  const all = ((await chrome.storage.local.get('spaceMemberships')).spaceMemberships ?? {}) as Record<string, unknown>
  all[space] = { ...member, memberId }
  await chrome.storage.local.set({ spaceMemberships: all })
}

/** Decode helper for callers that already have cover text. */
export const coverToFrame = (b64: string) => fromB64(b64)
export { canonicalCover }

// ---------------------------------------------------------------------------
// The keyring
// ---------------------------------------------------------------------------
export async function keyringView(): Promise<SwResponse> {
  const k = await keyring()
  let claims: Claims | undefined = k.claims
  if (k.token) {
    const r = await gate('/keyring', { token: k.token }).catch(() => null)
    if (r?.claims) {
      claims = r.claims
      if (!r.claims.human && !r.claims.selfie && !r.claims.nationalities.length && !r.claims.wallets.length) {
        delete k.token // expired on the gate
        claims = undefined
      }
      await saveKeyring({ ...k, claims })
    }
  }
  return { ok: true, data: { passphrases: k.pass.map(({ id, label }) => ({ id, label })), claims: claims ?? null } }
}

export async function addPassphrase(passphrase: string): Promise<SwResponse> {
  let key: Uint8Array
  try {
    key = passKey(passphrase)
  } catch {
    return { ok: false, error: 'Type the passphrase first.' }
  }
  const k = await keyring()
  const hex = toHex(key)
  if (!k.pass.some((p) => p.key === hex)) k.pass.push({ id: crypto.randomUUID(), label: labelFor(passphrase), key: hex })
  await saveKeyring(k)
  return keyringView()
}
export async function removePassphrase(id: string): Promise<SwResponse> {
  const k = await keyring()
  k.pass = k.pass.filter((p) => p.id !== id)
  await saveKeyring(k)
  return keyringView()
}
export async function forgetConnected(): Promise<SwResponse> {
  const k = await keyring()
  if (k.token) await gate('/keyring/forget', { token: k.token }).catch(() => {})
  delete k.token
  delete k.claims
  await saveKeyring(k)
  return keyringView()
}

async function granted(r: { token?: string; claims?: Claims; deny?: string; error?: string }): Promise<SwResponse> {
  if (!r?.token) return { ok: false, error: r?.deny ?? r?.error ?? 'the gate refused' }
  const k = await keyring()
  await saveKeyring({ ...k, token: r.token, claims: r.claims })
  return { ok: true, data: r.claims }
}

/** Pending World ID tabs this worker is waiting on (id → resolve). The widget tab pings while open
 *  (WORLD_WIDGET_PING), which also keeps this worker alive through a slow scan. */
const waiting = new Map<string, (m: { type: string; result?: unknown }) => void>()
export function onWidgetMessage(m: { type?: string; id?: string; result?: unknown }) {
  if (m?.id && waiting.has(m.id) && (m.type === 'WORLD_WIDGET_RESULT' || m.type === 'WORLD_WIDGET_CLOSED')) waiting.get(m.id)!(m as { type: string })
}

/**
 * Connect World ID to the keyring, once: the gate signs a request bound to the keyring key, World's
 * widget runs in a tab, and the gate verifies the proof (World's API + World Chain) and remembers the
 * credential. `simulate` = staging demo (World's simulator answers instead of a phone).
 */
export async function worldConnect(
  kind: 'poh' | 'selfie' | 'nationality', country: string | undefined, simulate: boolean,
  openTab: (id: string, request: WorldRequest, simulate: boolean) => Promise<SwResponse>,
): Promise<SwResponse> {
  const k = await keyring()
  const c = await gate('/connect/world/challenge', { kind, country, readerPub: k.readerKey.pub, ...(simulate ? { env: 'staging' } : {}) }).catch((e) => ({ error: String(e) }))
  if (!c?.request) return { ok: false, error: c?.deny ?? c?.error ?? 'the gate could not start World ID' }
  const id = crypto.randomUUID()
  const got = new Promise<{ type: string; result?: unknown }>((resolve) => waiting.set(id, resolve))
  const opened = await openTab(id, c.request as WorldRequest, simulate)
  if (!opened.ok) return (waiting.delete(id), opened)
  const m = await got
  waiting.delete(id)
  if (m.type !== 'WORLD_WIDGET_RESULT') return { ok: false, error: 'You closed World ID.' }
  const v = await gate('/connect/world', { sid: c.sid, readerPub: k.readerKey.pub, proof: m.result, token: k.token }).catch((e) => ({ error: String(e) }))
  // World's widget shows success only if the gate really accepted it
  void chrome.runtime.sendMessage({ type: 'WORLD_WIDGET_VERDICT', id, ok: !!v?.token, deny: v?.deny ?? v?.error }).catch(() => {})
  return granted(v)
}

/** Connect a wallet to the keyring, once: it signs a gate message naming the keyring key. */
export async function walletConnect(sign: (message: string) => Promise<SwResponse>): Promise<SwResponse> {
  const k = await keyring()
  const c = await gate('/connect/wallet/challenge', { readerPub: k.readerKey.pub }).catch((e) => ({ error: String(e) }))
  if (!c?.message) return { ok: false, error: c?.deny ?? c?.error ?? 'the gate is unreachable' }
  const s = await sign(c.message)
  if (!s.ok) return s
  const { address, sig } = s.data as { address: string; sig: string }
  return granted(await gate('/connect/wallet', { nonce: c.nonce, address, sig, token: k.token }).catch((e) => ({ error: String(e) })))
}
