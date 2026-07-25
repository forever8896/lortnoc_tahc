// LiveBackend — real ENS v2 (Sepolia) identity + Sui/Walrus store. Same Backend interface
// as the mock, so the UI is unchanged. Identity: sign with the EVM wallet → MS → keys; a
// Sui Ed25519 keypair is ALSO derived from MS (so storage needs no separate Sui wallet —
// fund that derived address with testnet SUI/WAL). Marked where live setup is required.
import type { Backend } from './backend'
import { fullHandle, shortName } from './backend'
import type { ClaimStage, Conversation, EnsStatus, Health, Identity, Message, RecordPerm } from './types'
import {
  deriveConvKey, deriveMasterSecret, deriveMessagingKey, deriveOwnerKey, fromHex, toHex, type KeyPair,
} from './crypto'
import { privateKeyToAccount } from 'viem/accounts'
import type { PrivateKeyAccount } from 'viem'
import * as ens from './live/ens'
import { sendMessage, readMessages, findHeads, sui } from './live/sui'
import { GATEWAY_ADDR, LORTNOC, REC, ensReady } from './live/config'
import { commitmentOf, generateTicket } from './live/proof'
import { fetchGroup, relayerReady, submitClaim } from './live/relayerClient'
import { deliverMembershipToExtension } from './live/extensionBridge'
import { isMember, membershipReady, zeroG } from './live/membership'
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { WAL_COIN_TYPE } from './live/config'

const ME = 'lortnoc.live.me.v1'
const HEADS = 'lortnoc.live.heads.v1' // peer handle -> Sui ConversationHead id (demo index)

export class LiveBackend implements Backend {
  private id: Identity | null = null
  private kp: KeyPair | null = null
  private ms: Uint8Array | null = null
  /** Signs as the handle owner. Held in memory only; re-derived from MS on every sign-in. */
  private owner: PrivateKeyAccount | null = null

  health(): Health {
    return { mode: 'live', ens: ensReady(), store: true }
  }

  async connect(): Promise<Identity> {
    const seed = await ens.signIdentity() // wallet sign (RFC 6979 deterministic)
    this.ms = deriveMasterSecret(seed)
    this.kp = deriveMessagingKey(this.ms)
    const { account } = await ens.walletClient()

    // The wallet that connected pays; a key derived from MS owns the handle. Keeping them apart
    // is what makes the payment and the handle unlinkable on-chain (§4, §8).
    this.owner = privateKeyToAccount(deriveOwnerKey(this.ms).privHex)

    // Handles are remembered against the OWNER address, since that is what holds them.
    const saved = JSON.parse(localStorage.getItem(ME) || '{}') as Record<string, string>
    this.id = {
      handle: saved[this.owner.address] ?? null,
      address: account,
      ownerAddress: this.owner.address,
      pubkeyHex: toHex(this.kp.pub),
    }
    return this.id
  }

  currentIdentity(): Identity | null {
    return this.id
  }

  masterSecret(): Uint8Array | null {
    return this.ms
  }

  async isHandleAvailable(name: string): Promise<boolean> {
    return ens.isAvailable(shortName(name))
  }

  /** One transaction: deploys the user's own resolver proxy, writes eth.lortnoc.pubkey, hands
   *  them every role on it, and registers the subname. See LortnocRegistrar.claim. */
  async claimHandle(name: string): Promise<Identity> {
    if (!this.kp || !this.id) throw new Error('connect first')
    const handle = fullHandle(name)
    // Free path: the connected wallet claims for itself, so payer and owner are the same here.
    // The paid path (claimHandlePaid) is the one that keeps them apart.
    await ens.claimHandle(shortName(handle), this.id.pubkeyHex)
    const saved = JSON.parse(localStorage.getItem(ME) || '{}') as Record<string, string>
    saved[this.id.address] = handle
    localStorage.setItem(ME, JSON.stringify(saved))
    this.id = { ...this.id, handle }
    // Second tx: publish where our conversation objects live, so peers can write to us.
    await this.publishSuiAddress()
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
  // Cached because deriving it costs an HKDF + two dynamic imports on every send.
  private suiKp: Ed25519Keypair | null = null

  private async suiSigner(): Promise<Ed25519Keypair> {
    if (this.suiKp) return this.suiKp
    if (!this.ms) throw new Error('no identity')
    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519')
    const { hkdf } = await import('@noble/hashes/hkdf.js')
    const { sha256 } = await import('@noble/hashes/sha2.js')
    const sk = hkdf(sha256, this.ms, new TextEncoder().encode('lortnoc/sui/ed25519/v1'), new Uint8Array(), 32)
    this.suiKp = Ed25519Keypair.fromSecretKey(sk)
    return this.suiKp
  }

  /** This device's Sui address — the one that must hold testnet SUI + WAL. */
  async suiAddress(): Promise<string> {
    return (await this.suiSigner()).toSuiAddress()
  }

  /** Publish our Sui address to ENS so peers can address a thread to us. Idempotent: skipped
   *  when the record already matches, so it costs one tx once per handle. */
  private async publishSuiAddress(): Promise<void> {
    if (!this.id?.handle) return
    const addr = await this.suiAddress()
    const current = await ens.readText(this.id.handle, REC.sui)
    if (current === addr) return
    await ens.setText(this.id.handle, REC.sui, addr, this.owner ?? undefined)
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
    // The head object gates append/seal_approve on member ADDRESSES, so we need the peer's Sui
    // address — resolved from their ENS record, the same directory their pubkey comes from.
    const peerSui = await ens.readText(peerH, REC.sui)
    if (!peerSui) {
      throw new Error(
        `${peerH} has not published a Sui address (${REC.sui}) yet — they need to open the app once.`,
      )
    }
    const key = this.convKeyFor(peerPub)
    const msg: Message = { v: 1, from: this.id.handle, to: peerH, ts: Date.now(), body }
    const signer = await this.suiSigner()
    const { headId } = await sendMessage(this.heads()[peerH] ?? null, key, msg, signer, peerSui)
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

  /** Local head index first, then on-chain discovery: a peer who was written TO has no local
   *  state, so without this the recipient's inbox would look empty. */
  async listConversations(): Promise<Conversation[]> {
    try {
      const mine = await findHeads(await this.suiAddress())
      const known = new Set(Object.values(this.heads()))
      for (const headId of mine) {
        if (known.has(headId)) continue
        const peerH = await this.peerOfHead(headId)
        if (peerH) this.setHead(peerH, headId)
      }
    } catch {
      /* discovery is best-effort — never block the inbox on it */
    }
    return Promise.all(Object.keys(this.heads()).map((p) => this.getConversation(p)))
  }

  /** Which participant of a head is NOT us. */
  private async peerOfHead(headId: string): Promise<string | null> {
    const o = await sui.getObject({ id: headId, options: { showContent: true } })
    const c = o.data?.content
    if (c?.dataType !== 'moveObject') return null
    const f = c.fields as { a?: string; b?: string }
    return [f.a, f.b].find((h) => h && h !== this.id?.handle) ?? null
  }

  // ---- paid, unlinkable claim (§7, §8) -----------------------------------------------------

  async paidClaimAvailable(): Promise<boolean> {
    if (!ensReady() || !membershipReady() || !this.ms) return false
    return relayerReady()
  }

  /**
   * The closing loop. We prove membership here, in this tab, and hand the proof to a relayer
   * which burns the ticket on 0G and issues the handle on Sepolia.
   *
   * The claimant must NEVER burn their own ticket: Semaphore hides which commitment a proof came
   * from, but not who submitted it. If the paying wallet burned it, an observer would see
   * "X paid" and "X burned nullifier N", and N names the handle — the anonymity set collapses to
   * one however large the crowd. So the relayer submits, and the user's on-chain footprint stays
   * exactly two transactions: the bridge and the payment.
   */
  async claimHandlePaid(name: string, onStage?: (s: ClaimStage) => void): Promise<Identity> {
    if (!this.ms || !this.kp || !this.id) throw new Error('connect first')
    const label = shortName(name)
    const handle = fullHandle(label)

    onStage?.('checking-membership')
    const commitment = await commitmentOf(this.ms)
    if (!(await isMember(commitment))) {
      throw new Error('no membership found for this identity — pay first')
    }

    onStage?.('loading-group')
    const group = await fetchGroup()
    await this.assertGroupMatchesChain(group.root)

    onStage?.('proving')
    const suiAddr = await this.suiAddress()
    const ticket = await generateTicket({
      ms: this.ms,
      members: group.members,
      label,
      evmAddr: this.id.ownerAddress,
      suiAddr,
      pubkeyHex: this.id.pubkeyHex,
    })

    onStage?.('relaying')
    const claimed = await submitClaim({
      label, evmAddr: this.id.ownerAddress, suiAddr, pubkey: this.id.pubkeyHex, ticket,
    })
    // Same membership unlocks the codec too — hand the token to the extension (§7/§8).
    if (claimed.codecToken) deliverMembershipToExtension(claimed.codecToken)

    onStage?.('waiting-for-ens')
    await pollFor(() => ens.resolvePubkey(handle), 120_000)

    // The relayer chose what to publish. It was bound into the proof, but verify anyway — if this
    // ever fails, someone published a key they control and could read everything sent to us.
    onStage?.('verifying-pubkey')
    const published = await ens.readText(handle, REC.pubkey)
    if (published?.toLowerCase() !== this.id.pubkeyHex.toLowerCase()) {
      throw new Error(
        `SECURITY: ${handle} publishes a pubkey that is not ours (${published}). Do not use this handle.`,
      )
    }

    const saved = JSON.parse(localStorage.getItem(ME) || '{}') as Record<string, string>
    saved[this.id.ownerAddress] = handle
    localStorage.setItem(ME, JSON.stringify(saved))
    this.id = { ...this.id, handle }
    await this.publishSuiAddress()

    onStage?.('done')
    return this.id
  }

  /** Never prove against a member set the relayer invented — the proof would simply fail
   *  on-chain, and "transaction reverted" is a terrible way to learn that. */
  private async assertGroupMatchesChain(root: string): Promise<void> {
    const zg = await import('./live/zerog-deployment.json')
    const semaphore = (zg.default ?? zg).mainnet?.contracts?.semaphore as `0x${string}` | undefined
    const groupId = BigInt((zg.default ?? zg).mainnet?.groupId ?? 0)
    if (!semaphore) return
    const onChain = await zeroG.readContract({
      address: semaphore,
      abi: [{
        type: 'function', name: 'getMerkleTreeRoot', stateMutability: 'view',
        inputs: [{ name: 'groupId', type: 'uint256' }], outputs: [{ type: 'uint256' }],
      }] as const,
      functionName: 'getMerkleTreeRoot',
      args: [groupId],
    })
    if (onChain.toString() !== root) {
      throw new Error('the relayer served a member set that does not match the chain — refusing to prove')
    }
  }

  // ---- ENS v2 self-sovereignty (§6.5) ------------------------------------------------------

  /** Reads the live EAC state off the user's own resolver. Every "can write" below is an
   *  `eth_call` through the real authorization path, not a guess from local state. */
  async ensStatus(): Promise<EnsStatus> {
    const handle = this.id?.handle ?? null
    const owner = (this.id?.ownerAddress ?? this.id?.address ?? '0x0') as `0x${string}`
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
      store: await this.storeStatus(),
    }
  }

  /** Balances of the MS-derived Sui account. Surfaced because it starts empty: without SUI for
   *  gas and WAL for storage, sending fails at the Walrus write with an opaque error. */
  private async storeStatus(): Promise<EnsStatus['store']> {
    try {
      const address = await this.suiAddress()
      const [sui_, wal] = await Promise.all([
        sui.getBalance({ owner: address }),
        sui.getBalance({ owner: address, coinType: WAL_COIN_TYPE }).catch(() => ({ totalBalance: '0' })),
      ])
      const fmt = (v: string, dp = 3) => (Number(v) / 1e9).toFixed(dp)
      return {
        address,
        sui: fmt(sui_.totalBalance),
        wal: fmt(wal.totalBalance),
        ready: BigInt(sui_.totalBalance) > 0n && BigInt(wal.totalBalance) > 0n,
      }
    } catch {
      return undefined
    }
  }

  /** authorizeTextRoles on ONE key. Grant → the gateway can rotate the inbox pointer and
   *  nothing else; revoke → it loses that in the same single transaction. */
  async delegateInbox(grant: boolean): Promise<string> {
    if (!this.id?.handle) throw new Error('claim a handle first')
    const tx = await ens.setTextDelegation(this.id.handle, REC.inbox, GATEWAY_ADDR, grant, this.owner ?? undefined)
    const verb = grant ? 'granted' : 'revoked'
    return (
      `${verb} ${REC.inbox} → ${GATEWAY_ADDR.slice(0, 8)}… on ${LORTNOC.parentName} ` +
      `(tx ${tx.slice(0, 12)}…)`
    )
  }
}

/** Poll until `read` returns something truthy, or give up. */
async function pollFor<T>(read: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const started = Date.now()
  for (;;) {
    const v = await read().catch(() => null)
    if (v) return v
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the chain to catch up')
    await new Promise((r) => setTimeout(r, 3000))
  }
}
