// MockBackend — genuinely end-to-end encrypted, over a localStorage "network".
// Two tabs of the same browser share localStorage, so they act as two real users:
// each publishes a pubkey to the shared directory; messages are AES-SIV-encrypted under
// an ECDH-derived K_conv (the SAME crypto the live path uses). Only the TRANSPORT is
// mocked (localStorage instead of Walrus/Sui) — the encryption is real.
import type { Backend } from './backend'
import { fullHandle } from './backend'
import type { Conversation, EnsStatus, Health, Identity, Message, OpenedKnock, RecordPerm } from './types'
import { createKnockConfig, deriveKnockKey, openKnock, parseKnockConfig, sealKnock } from './live/knock'
import { RECORD_SPECS } from './live/config'

/** Demo records are keyed by the short name, since there is no resolver to namespace them. */
const short = (key: string): string => key.replace('eth.lortnoc.', '')
import {
  deriveConvKey,
  deriveMasterSecret,
  deriveMessagingKey,
  encrypt,
  fromHex,
  toHex,
  tryDecrypt,
  type KeyPair,
} from './crypto'

const NET = 'lortnoc.net.v1' // shared: directory + encrypted messages
const ME = 'lortnoc.me.v1' // per-tab identity (sessionStorage)

type Net = {
  directory: Record<string, string> // handle -> pubkeyHex
  blobs: Record<string, { from: string; to: string; ct: string; ts: number }[]> // convId -> encrypted msgs
  records?: Record<string, string> // "<handle>|<key>" -> value (stands in for ENS text records)
  knocks?: Record<string, { id: string; sealed: string; ts: number }[]> // handle -> sealed knocks
  accepted?: string[] // peers whose knock was opened — through the door, gate no longer applies
}
const loadNet = (): Net => JSON.parse(localStorage.getItem(NET) || '{"directory":{},"blobs":{}}')
const saveNet = (n: Net): void => localStorage.setItem(NET, JSON.stringify(n))

const convId = (a: string, b: string): string => [a, b].sort().join('|')
const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u))
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export class MockBackend implements Backend {
  private id: Identity | null = null
  private kp: KeyPair | null = null

  health(): Health {
    return { mode: 'demo', ens: true, store: true }
  }

  /** Rehydrate from sessionStorage. Sync and private — see the public restore() below. */
  private rehydrate(): void {
    if (this.id) return
    const raw = sessionStorage.getItem(ME)
    if (!raw) return
    const saved = JSON.parse(raw) as { id: Identity; priv: string }
    this.id = saved.id
    const priv = fromHex(saved.priv)
    this.kp = { priv, pub: fromHex(saved.id.pubkeyHex) }
  }

  private persist(): void {
    if (this.id && this.kp) sessionStorage.setItem(ME, JSON.stringify({ id: this.id, priv: toHex(this.kp.priv) }))
  }

  async connect(): Promise<Identity> {
    this.rehydrate()
    if (this.id) return this.id
    // demo seed: random per tab (like a fresh wallet). Real path signs with a wallet.
    const seed = crypto.getRandomValues(new Uint8Array(32))
    const ms = deriveMasterSecret(seed)
    this.kp = deriveMessagingKey(ms)
    const addr = '0xdemo' + toHex(seed).slice(0, 8)
    this.id = { handle: null, address: addr, ownerAddress: addr, pubkeyHex: toHex(this.kp.pub) }
    this.persist()
    return this.id
  }

  currentIdentity(): Identity | null {
    this.rehydrate()
    return this.id
  }

  /** Demo mode has no wallet to re-prompt, so resuming is just reading the tab's own state. */
  async restore(): Promise<Identity | null> {
    this.rehydrate()
    return this.id
  }

  /** Demo mode keeps no derived-key cache: the "network" is this tab, so readKnocks is already
   *  instant and there is nothing to poll in the background. */
  async pendingKnocks(): Promise<OpenedKnock[]> {
    return []
  }

  /** Demo mode has no cached-key concept — readKnocks is instant against this tab's own store. */
  async knockState(): Promise<'none' | 'armed' | 'locked'> {
    return 'none'
  }

  async acceptKnock(handle: string): Promise<void> {
    const net = loadNet()
    const h = fullHandle(handle)
    ;(net.accepted ||= []).includes(h) || net.accepted.push(h)
    saveNet(net)
  }

  /** Demo mode has no chain and therefore no paid tier. */
  masterSecret(): Uint8Array | null {
    return null
  }

  async paidClaimAvailable(): Promise<boolean> {
    return false
  }

  async unlockExtension(): Promise<'unlocked' | 'no-extension' | 'not-a-member'> {
    return 'not-a-member' // demo mode has no membership to unlock with
  }

  async claimHandlePaid(): Promise<Identity> {
    throw new Error('demo mode has no chain — the paid claim path needs ?live')
  }

  async isHandleAvailable(name: string): Promise<boolean> {
    return !loadNet().directory[fullHandle(name)]
  }

  async claimHandle(name: string): Promise<Identity> {
    if (!this.id || !this.kp) await this.connect()
    const handle = fullHandle(name)
    const net = loadNet()
    if (net.directory[handle] && net.directory[handle] !== this.id!.pubkeyHex) throw new Error('handle taken')
    net.directory[handle] = this.id!.pubkeyHex // publish pubkey to the "ENS" directory
    saveNet(net)
    this.id = { ...this.id!, handle } // NEW reference so React re-routes
    this.persist()
    return this.id
  }

  async resolvePubkey(handle: string): Promise<string | null> {
    return loadNet().directory[fullHandle(handle)] ?? null
  }

  private async keyFor(peerPub: string): Promise<Uint8Array> {
    if (!this.kp) throw new Error('no identity')
    return deriveConvKey(this.kp.priv, fromHex(peerPub), this.kp.pub)
  }

  async send(peer: string, body: string): Promise<Message> {
    this.rehydrate()
    if (!this.id?.handle || !this.kp) throw new Error('claim a handle first')
    const peerH = fullHandle(peer)
    const peerPub = await this.resolvePubkey(peerH)
    if (!peerPub) throw new Error('unknown handle — they need to claim it first')
    const key = await this.keyFor(peerPub)
    const msg: Message = { v: 1, from: this.id.handle, to: peerH, ts: Date.now(), body }
    const ct = b64(encrypt(key, JSON.stringify(msg)))
    const net = loadNet()
    const id = convId(this.id.handle, peerH)
    ;(net.blobs[id] ||= []).push({ from: this.id.handle, to: peerH, ct, ts: msg.ts })
    saveNet(net)
    return msg
  }

  async getConversation(peer: string): Promise<Conversation> {
    this.rehydrate()
    const peerH = fullHandle(peer)
    const me = this.id?.handle
    const peerPub = await this.resolvePubkey(peerH)
    const messages: Message[] = []
    if (me && this.kp && peerPub) {
      const key = await this.keyFor(peerPub)
      const raw = loadNet().blobs[convId(me, peerH)] || []
      for (const b of raw) {
        const pt = tryDecrypt(key, unb64(b.ct))
        if (pt) messages.push(JSON.parse(pt) as Message)
      }
    }
    messages.sort((a, b) => a.ts - b.ts)
    return {
      convId: convId(me || '', peerH),
      peer: peerH,
      seq: messages.length,
      updatedAt: messages.at(-1)?.ts ?? 0,
      messages,
    }
  }

  async listConversations(): Promise<Conversation[]> {
    this.rehydrate()
    const me = this.id?.handle
    if (!me) return []
    const net = loadNet()
    const peers = new Set<string>()
    for (const id of Object.keys(net.blobs)) {
      const [a, b] = id.split('|')
      if (a === me) peers.add(b)
      else if (b === me) peers.add(a)
    }
    return Promise.all([...peers].map((p) => this.getConversation(p)))
  }

  // ---- ENS v2 surface, narrated -----------------------------------------------------------
  // Demo mode has no chain, so these mirror the shape of the live results and say so plainly.
  // The permission table below is exactly what the live resolver reports (see LiveBackend);
  // here it is asserted, not measured — never present it as an on-chain reading.

  async ensStatus(): Promise<EnsStatus> {
    // Read back whatever was actually written, so the table reflects reality in demo mode too —
    // a panel that always says "unset" teaches the wrong thing about the live one.
    const net = loadNet()
    const handle = this.id?.handle ?? null
    const stored = (key: string): string | null =>
      key.endsWith('pubkey') ? (this.id?.pubkeyHex ?? null) : (net.records?.[`${handle}|${short(key)}`] ?? null)

    return {
      live: false,
      handle,
      resolver: null,
      factoryVerified: false,
      impl: '',
      gateway: '0x000000000000000000000000000000000000dEaD',
      inboxDelegated: this.delegated,
      perms: RECORD_SPECS.map((spec): RecordPerm => ({
        key: spec.key,
        value: stored(spec.key),
        ownerCanWrite: true,
        gatewayCanWrite: spec.key.endsWith('inbox') ? this.delegated : false,
      })),
      explorer: null,
    }
  }

  private delegated = false

  async delegateInbox(grant: boolean): Promise<string> {
    this.delegated = grant
    return grant
      ? 'demo: authorizeTextRoles(eth.lortnoc.inbox → gateway) — the gateway may rotate the inbox pointer only; a pubkey write reverts.'
      : 'demo: role revoked in one tx — the gateway can no longer write anything.'
  }

  async delegateRecord(key: string, to: string, grant: boolean): Promise<string> {
    if (key.endsWith('inbox')) this.delegated = grant
    return `demo: authorizeTextRoles(${key} → ${to.slice(0, 8)}…, ${grant}) — on-chain in live mode.`
  }

  async setRecord(key: string, value: string): Promise<string> {
    const net = loadNet()
    ;(net.records ||= {})[`${this.id?.handle}|${short(key)}`] = value
    saveNet(net)
    return `demo: ${key} set locally (a real setText on ENS v2 in live mode).`
  }

  // ---- knock (§6.8) — real crypto, localStorage instead of the relay -------------------------
  // The Argon2id + AEAD path here is EXACTLY the live one; only the transport is faked. So a
  // wrong answer fails in demo mode for the same reason it fails on-chain.

  async setKnock(prompt: string, answer: string): Promise<string> {
    if (!this.id?.handle) throw new Error('claim a handle first')
    if (!answer.trim()) throw new Error('an answer is required — it never leaves this device')
    const config = createKnockConfig(prompt)
    await deriveKnockKey(answer, config)
    const net = loadNet()
    ;(net.records ||= {})[`${this.id.handle}|knock`] = JSON.stringify(config)
    saveNet(net)
    return `demo: knock published — "${config.prompt}"`
  }

  async peerKnockPrompt(handle: string): Promise<string | null> {
    const net = loadNet()
    return parseKnockConfig(net.records?.[`${fullHandle(handle)}|knock`] ?? null)?.prompt ?? null
  }

  async sendKnock(toHandle: string, answer: string, intro: string): Promise<'sent' | 'no-knock'> {
    const handle = fullHandle(toHandle)
    const net = loadNet()
    const config = parseKnockConfig(net.records?.[`${handle}|knock`] ?? null)
    if (!config) return 'no-knock'
    const key = await deriveKnockKey(answer, config)
    const sealed = sealKnock(key, {
      v: 1,
      pubkey: this.id?.pubkeyHex ?? '',
      from: this.id?.handle ?? undefined,
      intro: intro.slice(0, 280),
      ts: Date.now(),
    })
    ;(net.knocks ||= {})[handle] = [
      ...(net.knocks?.[handle] ?? []),
      { id: `${Date.now()}`, sealed, ts: Date.now() },
    ]
    saveNet(net)
    return 'sent'
  }

  async readKnocks(answer: string): Promise<OpenedKnock[]> {
    if (!this.id?.handle) throw new Error('claim a handle first')
    const net = loadNet()
    const config = parseKnockConfig(net.records?.[`${this.id.handle}|knock`] ?? null)
    if (!config) throw new Error('you have not published a knock question yet')
    const key = await deriveKnockKey(answer, config)
    const out: OpenedKnock[] = []
    for (const k of net.knocks?.[this.id.handle] ?? []) {
      const p = openKnock(key, k.sealed)
      if (p) out.push({ id: k.id, pubkey: p.pubkey, from: p.from, intro: p.intro, ts: p.ts })
    }
    return out.sort((a, b) => b.ts - a.ts)
  }
}
