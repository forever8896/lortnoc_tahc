// LiveBackend — real ENS v2 (Sepolia) identity + Sui/Walrus store. Same Backend interface
// as the mock, so the UI is unchanged. Identity: sign with the EVM wallet → MS → keys; a
// Sui Ed25519 keypair is ALSO derived from MS (so storage needs no separate Sui wallet —
// fund that derived address with testnet SUI/WAL). Marked where live setup is required.
import type { Backend } from './backend'
import { fullHandle, shortName } from './backend'
import type { Conversation, EnsStatus, Health, Identity, Message, RecordPerm } from './types'
import { deriveConvKey, deriveMasterSecret, deriveMessagingKey, fromHex, toHex, type KeyPair } from './crypto'
import * as ens from './live/ens'
import { sendMessage, readMessages, sui } from './live/sui'
import { GATEWAY_ADDR, LORTNOC, REC, ensReady } from './live/config'

const ME = 'lortnoc.live.me.v1'
const HEADS = 'lortnoc.live.heads.v1' // peer handle -> Sui ConversationHead id (demo index)

export class LiveBackend implements Backend {
  private id: Identity | null = null
  private kp: KeyPair | null = null
  private ms: Uint8Array | null = null

  health(): Health {
    return { mode: 'live', ens: ensReady(), store: true }
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
    return ens.isAvailable(shortName(name))
  }

  /** One transaction: deploys the user's own resolver proxy, writes eth.lortnoc.pubkey, hands
   *  them every role on it, and registers the subname. See LortnocRegistrar.claim. */
  async claimHandle(name: string): Promise<Identity> {
    if (!this.kp || !this.id) throw new Error('connect first')
    const handle = fullHandle(name)
    await ens.claimHandle(shortName(handle), this.id.pubkeyHex)
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

  // ---- ENS v2 self-sovereignty (§6.5) ------------------------------------------------------

  /** Reads the live EAC state off the user's own resolver. Every "can write" below is an
   *  `eth_call` through the real authorization path, not a guess from local state. */
  async ensStatus(): Promise<EnsStatus> {
    const handle = this.id?.handle ?? null
    const owner = (this.id?.address ?? '0x0') as `0x${string}`
    const base: EnsStatus = {
      live: ensReady(),
      handle,
      resolver: null,
      factoryVerified: false,
      impl: '',
      gateway: GATEWAY_ADDR,
      inboxDelegated: false,
      perms: [],
      explorer: null,
    }
    if (!handle || !ensReady()) return base

    const { ok, resolver, impl } = await ens.verifyResolver(handle)
    if (!resolver) return base

    const keys = [REC.pubkey, REC.inbox, REC.walrus]
    const perms: RecordPerm[] = await Promise.all(
      keys.map(async (key) => ({
        key,
        value: await ens.readText(handle, key),
        ownerCanWrite: await ens.canWriteText(handle, owner, key),
        gatewayCanWrite: await ens.canWriteText(handle, GATEWAY_ADDR, key),
      })),
    )

    return {
      ...base,
      resolver,
      factoryVerified: ok,
      impl,
      inboxDelegated: await ens.hasTextRole(handle, GATEWAY_ADDR, REC.inbox),
      perms,
      explorer: `https://sepolia.etherscan.io/address/${resolver}`,
    }
  }

  /** authorizeTextRoles on ONE key. Grant → the gateway can rotate the inbox pointer and
   *  nothing else; revoke → it loses that in the same single transaction. */
  async delegateInbox(grant: boolean): Promise<string> {
    if (!this.id?.handle) throw new Error('claim a handle first')
    const tx = await ens.setTextDelegation(this.id.handle, REC.inbox, GATEWAY_ADDR, grant)
    const verb = grant ? 'granted' : 'revoked'
    return (
      `${verb} ${REC.inbox} → ${GATEWAY_ADDR.slice(0, 8)}… on ${LORTNOC.parentName} ` +
      `(tx ${tx.slice(0, 12)}…)`
    )
  }
}
