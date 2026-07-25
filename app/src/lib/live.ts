// LiveBackend — real ENS v2 (Sepolia) identity + Sui/Walrus store. Same Backend interface
// as the mock, so the UI is unchanged. Identity: sign with the EVM wallet → MS → keys; a
// Sui Ed25519 keypair is ALSO derived from MS (so storage needs no separate Sui wallet —
// fund that derived address with testnet SUI/WAL). Marked where live setup is required.
import type { Backend } from './backend'
import { fullHandle } from './backend'
import type { Conversation, Health, Identity, Message } from './types'
import { deriveConvKey, deriveMasterSecret, deriveMessagingKey, fromHex, toHex, type KeyPair } from './crypto'
import * as ens from './live/ens'
import { sendMessage, readMessages, sui } from './live/sui'
import { ENS } from './live/config'

const ME = 'lortnoc.live.me.v1'
const HEADS = 'lortnoc.live.heads.v1' // peer handle -> Sui ConversationHead id (demo index)

export class LiveBackend implements Backend {
  private id: Identity | null = null
  private kp: KeyPair | null = null
  private ms: Uint8Array | null = null

  health(): Health {
    return { mode: 'live', ens: !!ENS.rpc, store: true }
  }

  async connect(): Promise<Identity> {
    const seed = await ens.signIdentity() // wallet sign (RFC 6979 deterministic)
    this.ms = deriveMasterSecret(seed)
    this.kp = deriveMessagingKey(this.ms)
    const { account } = await ens.walletClient()
    // restore a previously-claimed handle for this address, if any
    const saved = JSON.parse(localStorage.getItem(ME) || '{}') as Record<string, string>
    this.id = { handle: saved[account] ?? null, address: account, pubkeyHex: toHex(this.kp.pub) }
    return this.id
  }

  currentIdentity(): Identity | null {
    return this.id
  }

  async isHandleAvailable(name: string): Promise<boolean> {
    return (await ens.resolvePubkey(fullHandle(name))) === null
  }

  async claimHandle(name: string): Promise<Identity> {
    if (!this.kp || !this.id) throw new Error('connect first')
    const handle = fullHandle(name)
    await ens.claimHandle(handle, this.id.pubkeyHex) // setText eth.lortnoc.pubkey (on-chain)
    const saved = JSON.parse(localStorage.getItem(ME) || '{}') as Record<string, string>
    saved[this.id.address] = handle
    localStorage.setItem(ME, JSON.stringify(saved))
    this.id = { ...this.id, handle }
    return this.id
  }

  async resolvePubkey(handle: string): Promise<string | null> {
    return ens.resolvePubkey(fullHandle(handle))
  }

  private convKeyFor(peerPub: string): Uint8Array {
    if (!this.kp) throw new Error('no identity')
    return deriveConvKey(this.kp.priv, fromHex(peerPub), this.kp.pub)
  }

  // Sui signer derived from MS (deterministic) — no separate Sui wallet; fund this address.
  private async suiSigner() {
    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519')
    if (!this.ms) throw new Error('no identity')
    const { hkdf } = await import('@noble/hashes/hkdf.js')
    const { sha256 } = await import('@noble/hashes/sha2.js')
    const sk = hkdf(sha256, this.ms, new TextEncoder().encode('lortnoc/sui/ed25519/v1'), new Uint8Array(), 32)
    const kp = Ed25519Keypair.fromSecretKey(sk)
    const signAndExecute = async (tx: import('@mysten/sui/transactions').Transaction) => {
      const res = await sui.signAndExecuteTransaction({
        transaction: tx,
        signer: kp,
        options: { showObjectChanges: true },
      })
      return { digest: res.digest, objectChanges: res.objectChanges ?? [] }
    }
    return { kp, signAndExecute }
  }

  private heads(): Record<string, string> {
    return JSON.parse(localStorage.getItem(HEADS) || '{}')
  }
  private setHead(peer: string, id: string): void {
    const h = this.heads()
    h[peer] = id
    localStorage.setItem(HEADS, JSON.stringify(h))
  }

  async send(peer: string, body: string): Promise<Message> {
    if (!this.id?.handle) throw new Error('claim a handle first')
    const peerH = fullHandle(peer)
    const peerPub = await this.resolvePubkey(peerH)
    if (!peerPub) throw new Error('handle not found on ENS (they must claim + publish a pubkey)')
    const key = this.convKeyFor(peerPub)
    const msg: Message = { v: 1, from: this.id.handle, to: peerH, ts: Date.now(), body }
    const { signAndExecute } = await this.suiSigner()
    const { headId } = await sendMessage(this.heads()[peerH] ?? null, key, msg, signAndExecute)
    if (headId) this.setHead(peerH, headId)
    return msg
  }

  async getConversation(peer: string): Promise<Conversation> {
    const peerH = fullHandle(peer)
    const headId = this.heads()[peerH]
    const peerPub = await this.resolvePubkey(peerH)
    let messages: Message[] = []
    if (headId && peerPub) messages = await readMessages(headId, this.convKeyFor(peerPub))
    return { convId: peerH, peer: peerH, seq: messages.length, updatedAt: messages.at(-1)?.ts ?? 0, messages }
  }

  async listConversations(): Promise<Conversation[]> {
    return Promise.all(Object.keys(this.heads()).map((p) => this.getConversation(p)))
  }

  async delegateInbox(): Promise<string> {
    if (!this.id?.handle) throw new Error('claim a handle first')
    const gateway = (import.meta.env.VITE_GATEWAY_ADDR as `0x${string}`) || (this.id.address as `0x${string}`)
    const tx = await ens.delegateInbox(this.id.handle, gateway)
    return `authorizeTextRoles(eth.lortnoc.inbox → ${gateway.slice(0, 8)}…) tx ${tx.slice(0, 12)}… — gateway may write ONLY inbox; revocable.`
  }

  async verifyResolver(): Promise<{ ok: boolean; detail: string }> {
    try {
      const { ok, impl } = await ens.verifyResolver(
        (import.meta.env.VITE_LORTNOC_RESOLVER as `0x${string}`) ?? '0x0',
      )
      return { ok, detail: ok ? `verifyContract → ${impl} = PermissionedResolverImpl ✓` : `impl mismatch: ${impl}` }
    } catch (e) {
      return { ok: false, detail: String(e instanceof Error ? e.message : e) }
    }
  }
}
