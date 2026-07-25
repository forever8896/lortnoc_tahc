// MockBackend — genuinely end-to-end encrypted, over a localStorage "network".
// Two tabs of the same browser share localStorage, so they act as two real users:
// each publishes a pubkey to the shared directory; messages are AES-SIV-encrypted under
// an ECDH-derived K_conv (the SAME crypto the live path uses). Only the TRANSPORT is
// mocked (localStorage instead of Walrus/Sui) — the encryption is real.
import type { Backend } from './backend'
import { fullHandle } from './backend'
import type { Conversation, Health, Identity, Message } from './types'
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

  private restore(): void {
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
    this.restore()
    if (this.id) return this.id
    // demo seed: random per tab (like a fresh wallet). Real path signs with a wallet.
    const seed = crypto.getRandomValues(new Uint8Array(32))
    const ms = deriveMasterSecret(seed)
    this.kp = deriveMessagingKey(ms)
    this.id = { handle: null, address: '0xdemo' + toHex(seed).slice(0, 8), pubkeyHex: toHex(this.kp.pub) }
    this.persist()
    return this.id
  }

  currentIdentity(): Identity | null {
    this.restore()
    return this.id
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
    this.restore()
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
    this.restore()
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
    this.restore()
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

  async delegateInbox(): Promise<string> {
    return 'demo: authorizeTextRoles(eth.lortnoc.inbox → gateway) — the gateway may rotate the inbox pointer only; a pubkey write would revert. Revoke in one tx. (Live on ENS v2 Sepolia.)'
  }
  async verifyResolver(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'demo: verifyContract(proxy) → PermissionedResolverImpl (trustless handle proof). Live on ENS v2 Sepolia.' }
  }
}
