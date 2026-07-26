// LiveBackend — real ENS v2 (Sepolia) identity + Sui/Walrus store. Same Backend interface
// as the mock, so the UI is unchanged. Identity: sign with the EVM wallet → MS → keys; a
// Sui Ed25519 keypair is ALSO derived from MS (so storage needs no separate Sui wallet —
// fund that derived address with testnet SUI/WAL). Marked where live setup is required.
import type { Backend } from './backend'
import { fullHandle, shortName } from './backend'
import type {
  ClaimStage, Conversation, EnsStatus, Health, Identity, Message, OpenedKnock, RecordPerm, SendStage,
} from './types'
import {
  deriveConvKey, deriveMasterSecret, deriveMessagingKey, deriveOwnerKey, fromHex, toHex, type KeyPair,
} from './crypto'
import { privateKeyToAccount } from 'viem/accounts'
import type { PrivateKeyAccount } from 'viem'
import * as ens from './live/ens'
import { sendMessage, readMessages, findHeads, sui } from './live/sui'
import { GATEWAY_ADDR, LORTNOC, REC, RECORD_SPECS, ensReady } from './live/config'
import { commitmentOf, generateTicket } from './live/proof'
import { fetchGroup, fetchKnocks, reissueCodecToken, relayerReady, sendKnock, submitClaim } from './live/relayerClient'
import { createKnockConfig, deriveKnockKey, openKnock, parseKnockConfig, sealKnock } from './live/knock'
import { deliverAndConfirm, redeliverMembershipToExtension, storedMembershipToken } from './live/extensionBridge'
import { isMember, membershipReady, zeroG } from './live/membership'
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { WAL_COIN_TYPE } from './live/config'

const ME = 'lortnoc.live.me.v1'
const HEADS = 'lortnoc.live.heads.v1' // peer handle -> Sui ConversationHead id (demo index)
/** sessionStorage (dies with the tab, never touches disk): MS, so a reload does not mean another
 *  wallet signature. */
const SESSION = 'lortnoc.live.session.v1'
/** sessionStorage: the knock key DERIVED from the answer — never the answer itself. Bound to the
 *  published salt, so re-publishing a question invalidates it automatically. Without this the
 *  inbox could not show a knock until you went and retyped the answer. */
const KNOCK_KEY = 'lortnoc.live.knockkey.v1'
/** Peers whose knock we opened. A conversation with no messages yet has no Sui head, so without
 *  this an accepted knock would leave no trace anywhere and "open conversation" would look like
 *  it did nothing. */
const ACCEPTED = 'lortnoc.live.accepted.v1'

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
    const { account } = await ens.walletClient()
    const id = this.hydrate(deriveMasterSecret(seed), account)
    await this.recoverHandle()
    // Survive a reload without re-signing. sessionStorage, NOT localStorage: this is MS, and it
    // dies with the tab rather than sitting on disk. Re-signing produces the same MS anyway
    // (RFC 6979), so this is a convenience cache, never the system of record.
    sessionStorage.setItem(SESSION, JSON.stringify({ ms: toHex(this.ms!), address: account }))
    return id
  }

  /** Resume without a signature. Nothing here can prompt the wallet — it must be safe to run
   *  unattended on every page load. */
  async restore(): Promise<Identity | null> {
    let saved: { ms?: string; address?: string } | null = null
    try {
      saved = JSON.parse(sessionStorage.getItem(SESSION) || 'null')
    } catch {
      /* corrupt entry — fall through to a normal sign-in */
    }
    if (!saved?.ms || !saved.address) return null
    try {
      const id = this.hydrate(fromHex(saved.ms), saved.address as `0x${string}`)
      await this.recoverHandle()
      return this.id ?? id
    } catch (e) {
      console.warn('[lortnoc] could not resume the session; sign in again:', e)
      sessionStorage.removeItem(SESSION)
      return null
    }
  }

  /** Everything derived from MS, in one place, so connect and restore cannot drift apart. */
  private hydrate(ms: Uint8Array, account: `0x${string}`): Identity {
    this.ms = ms
    this.kp = deriveMessagingKey(ms)

    // The wallet that connected pays; a key derived from MS owns the handle. Keeping them apart
    // is what makes the payment and the handle unlinkable on-chain (§4, §8).
    this.owner = privateKeyToAccount(deriveOwnerKey(ms).privHex)

    // Handles are remembered against the OWNER address, since that is what holds them.
    const saved = JSON.parse(localStorage.getItem(ME) || '{}') as Record<string, string>
    const id: Identity = {
      handle: saved[this.owner.address] ?? null,
      address: account,
      ownerAddress: this.owner.address,
      pubkeyHex: toHex(this.kp.pub),
    }
    this.id = id

    // Self-heal: publishing the Sui address used to be attempted only during a claim, so if that
    // one write failed the handle was left permanently unable to receive messages — peers resolve
    // this record to know where to write. It is idempotent (a matching record costs one eth_call),
    // and silent-only, so a repair never interrupts sign-in with a wallet popup.
    void this.publishSuiAddress(true).catch((e) =>
      console.warn('[lortnoc] could not publish the Sui address (will retry next sign-in):', e),
    )
    return id
  }

  currentIdentity(): Identity | null {
    return this.id
  }

  /**
   * If the local note doesn't say which handle is ours, ask the chain.
   *
   * The note is a localStorage entry written at claim time, so it is per-origin and per-browser:
   * a new domain, a second device or a cleared cache all made a claimed handle disappear and the
   * app cheerfully offered to issue another one. Ownership lives on-chain — read it from there.
   *
   * Checks BOTH addresses because the two claim paths differ: the paid claim hands the handle to
   * the MS-derived owner, the free claim leaves it with the connected wallet.
   */
  private async recoverHandle(): Promise<void> {
    if (!this.id || this.id.handle) return
    const candidates = [this.owner?.address, this.id.address].filter(Boolean) as `0x${string}`[]
    for (const addr of candidates) {
      try {
        const handle = await ens.handleOf(addr)
        if (!handle) continue
        this.id = { ...this.id, handle }
        const saved = JSON.parse(localStorage.getItem(ME) || '{}') as Record<string, string>
        saved[addr] = handle
        localStorage.setItem(ME, JSON.stringify(saved))
        return
      } catch (e) {
        console.warn('[lortnoc] handle recovery failed for', addr, e)
      }
    }
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

  /** Cache successful resolutions. Every poll resolved every peer's pubkey through
   *  UniversalResolver (a multi-hop, CCIP-capable read) — the single heaviest repeated cost in
   *  the loop. Misses are NOT cached: a peer who has not claimed yet may claim at any moment. */
  private pubkeys = new Map<string, string>()

  async resolvePubkey(handle: string): Promise<string | null> {
    const h = fullHandle(handle)
    const hit = this.pubkeys.get(h)
    if (hit) return hit
    const got = await ens.resolvePubkey(h)
    if (got) this.pubkeys.set(h, got)
    return got
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
  private async publishSuiAddress(silentOnly = false): Promise<void> {
    if (!this.id?.handle) return
    const addr = await this.suiAddress()
    const current = await ens.readText(this.id.handle, REC.sui)
    if (current === addr) return
    // Which key owns the handle depends on how it was claimed: the paid path hands it to the
    // MS-derived owner, the free path leaves it with the connected wallet. Ask the resolver
    // instead of assuming — signing with the wrong one reverts for lack of a role.
    const owner = this.owner
    const canSignLocally =
      !!owner && (await ens.canWriteText(this.id.handle, owner.address, REC.sui))
    // Signing locally is silent; falling back to the wallet pops a confirmation, which is
    // unwelcome in the middle of signing in. Repair quietly or leave it for an explicit action.
    if (!canSignLocally && silentOnly) return
    await ens.setText(this.id.handle, REC.sui, addr, canSignLocally ? owner : undefined)
  }

  private heads(): Record<string, string> {
    return JSON.parse(localStorage.getItem(HEADS) || '{}')
  }
  private setHead(peer: string, id: string): void {
    const h = this.heads()
    h[peer] = id
    localStorage.setItem(HEADS, JSON.stringify(h))
  }

  async send(peer: string, body: string, onStage?: (s: SendStage) => void): Promise<Message> {
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
    onStage?.('encrypting')
    const key = this.convKeyFor(peerPub)
    const msg: Message = { v: 1, from: this.id.handle, to: peerH, ts: Date.now(), body }
    const signer = await this.suiSigner()
    const { headId } = await sendMessage(this.heads()[peerH] ?? null, key, msg, signer, peerSui, onStage)
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
  /** Last time we scanned Sui events for heads we participate in. */
  private lastDiscovery = 0

  async listConversations(): Promise<Conversation[]> {
    // Discovery costs an event query plus a getObject per head found — far too heavy to repeat on
    // every poll, and it only matters when a NEW conversation appears. Throttled; the messages in
    // known conversations still refresh at full speed.
    try {
      if (Date.now() - this.lastDiscovery > 30_000) {
        this.lastDiscovery = Date.now()
        await this.discoverHeads()
      }
    } catch {
      /* discovery is best-effort — never block the inbox on it */
    }
    const peers = new Set([...Object.keys(this.heads()), ...this.accepted()])
    // Per-peer failures must not take the inbox down with them: one handle that stops resolving
    // would otherwise reject the whole Promise.all and blank every conversation.
    const results = await Promise.allSettled([...peers].map((p) => this.getConversation(p)))
    return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  }

  /** Find heads we participate in that this device has no local note for — how a second device,
   *  or the person who was written TO, discovers a thread at all. */
  private async discoverHeads(): Promise<void> {
    const mine = await findHeads(await this.suiAddress())
    const known = new Set(Object.values(this.heads()))
    for (const headId of mine) {
      if (known.has(headId)) continue
      const peerH = await this.peerOfHead(headId)
      if (peerH) this.setHead(peerH, headId)
    }
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
    // Same membership unlocks the codec too — hand the token to the extension (§7/§8) and keep
    // a copy, so installing the extension later is enough to unlock it.
    if (claimed.codecToken) void deliverAndConfirm(claimed.codecToken)

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

  /**
   * Unlock the codec in the extension.
   *
   * Uses the token we kept from the claim if we have one. If we do not — the usual case, since it
   * used to be posted once and stored nowhere — we ask the relayer to re-issue it. That requires
   * proving we control the address the handle went to, which we can do because K_own is derived
   * from MS and lives right here.
   *
   * Returns what actually happened, because "we posted a message into the void" and "the
   * extension confirmed" are different outcomes and the UI should not conflate them.
   */
  async unlockExtension(): Promise<'unlocked' | 'no-extension' | 'not-a-member'> {
    if (!this.id?.handle || !this.ms || !this.owner) throw new Error('claim a handle first')

    let token = storedMembershipToken()
    if (!token) {
      // We hold every value the ticket committed to, and K_own signs as the address it went to —
      // enough for the relayer to find the claim and re-issue. No nullifier derivation needed.
      const label = shortName(this.id.handle)
      const suiAddr = await this.suiAddress()
      const signature = await this.owner.signMessage({ message: `lortnoc codec token for ${label}` })
      const { codecToken } = await reissueCodecToken({
        label, evmAddr: this.id.ownerAddress, suiAddr, pubkey: this.id.pubkeyHex, signature,
      }).catch(() => ({ codecToken: null }))
      if (!codecToken) return 'not-a-member'
      token = codecToken
    }
    return (await deliverAndConfirm(token)) ? 'unlocked' : 'no-extension'
  }

  /** Re-offer a stored token on load, so the extension picks it up without being asked. */
  redeliverCodecToken(): void {
    redeliverMembershipToExtension()
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

    const keys = RECORD_SPECS.map((r) => r.key)
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

  /** authorizeTextRoles on ONE key, for any address. This is the ENS v2 flagship: the grantee
   *  can write that record and nothing else, and one transaction takes it back. */
  async delegateRecord(key: string, to: string, grant: boolean): Promise<string> {
    if (!this.id?.handle) throw new Error('claim a handle first')
    const tx = await ens.setTextDelegation(
      this.id.handle, key, to as `0x${string}`, grant, this.owner ?? undefined,
    )
    return `${grant ? 'granted' : 'revoked'} ${key} → ${to.slice(0, 8)}… (tx ${tx.slice(0, 12)}…)`
  }

  /** Write one of your own records. Signed by the derived owner, not the connected wallet. */
  async setRecord(key: string, value: string): Promise<string> {
    if (!this.id?.handle) throw new Error('claim a handle first')
    const tx = await ens.setText(this.id.handle, key, value, this.owner ?? undefined)
    return `${key} updated (tx ${tx.slice(0, 12)}…)`
  }

  // ---- knock (§6.8) -------------------------------------------------------------------------

  /** Publish the QUESTION. The answer derives a key here and is then dropped on the floor — we
   *  never store it, never send it, and nothing published commits to it, so there is nothing to
   *  attack offline. */
  async setKnock(prompt: string, answer: string): Promise<string> {
    if (!this.id?.handle) throw new Error('claim a handle first')
    if (!answer.trim()) throw new Error('an answer is required — it never leaves this device')
    const config = createKnockConfig(prompt)
    const key = await deriveKnockKey(answer, config) // fail early if the answer is unusable
    const tx = await ens.setText(this.id.handle, REC.knock, JSON.stringify(config), this.owner ?? undefined)
    // Cache the derived key so the inbox can open knocks by itself. The answer is still dropped
    // on the floor here — the key it produced is what we keep, and only for this tab.
    this.cacheKnockKey(config.salt, key)
    this.myKnock = { at: Date.now(), config } // new salt takes effect at once, not in 60s
    return `knock published — "${config.prompt}" (tx ${tx.slice(0, 12)}…)`
  }

  async peerKnockPrompt(handle: string): Promise<string | null> {
    // Someone whose knock we opened is already through: they proved the answer and handed us
    // their key. Asking us to knock back before we can reply would gate our own doorway.
    if (this.accepted().includes(fullHandle(handle))) return null
    const config = parseKnockConfig(await ens.readText(fullHandle(handle), REC.knock))
    return config?.prompt ?? null
  }

  private accepted(): string[] {
    try {
      return JSON.parse(localStorage.getItem(ACCEPTED) || '[]') as string[]
    } catch {
      return []
    }
  }

  async acceptKnock(handle: string): Promise<void> {
    const h = fullHandle(handle)
    const list = this.accepted()
    if (!list.includes(h)) localStorage.setItem(ACCEPTED, JSON.stringify([...list, h]))
  }

  /** Knock on someone's door. Their published question tells us the salt and KDF; our answer
   *  produces the key. A wrong answer still "sends" — it simply never opens, and they are never
   *  told it arrived. */
  async sendKnock(toHandle: string, answer: string, intro: string): Promise<'sent' | 'no-knock'> {
    if (!this.id) throw new Error('connect first')
    // An introduction is the whole point: the recipient decides whether to open the door based on
    // it, and an empty one gives them nothing to decide with.
    if (!intro.trim()) throw new Error('say who you are — an empty introduction tells them nothing')
    const handle = fullHandle(toHandle)
    const config = parseKnockConfig(await ens.readText(handle, REC.knock))
    if (!config) return 'no-knock'

    const key = await deriveKnockKey(answer, config)
    const sealed = sealKnock(key, {
      v: 1,
      pubkey: this.id.pubkeyHex,
      from: this.id.handle ?? undefined,
      intro: intro.slice(0, 280),
      ts: Date.now(),
    })
    await sendKnock(handle, sealed)
    return 'sent'
  }

  /** Try our own answer against every pending knock. One Argon2id derivation covers all of them,
   *  because the key depends on our salt and answer, not on the sender. */
  async readKnocks(answer: string): Promise<OpenedKnock[]> {
    if (!this.id?.handle) throw new Error('claim a handle first')
    const config = parseKnockConfig(await ens.readText(this.id.handle, REC.knock))
    if (!config) throw new Error('you have not published a knock question yet')

    const key = await deriveKnockKey(answer, config)
    this.cacheKnockKey(config.salt, key) // the inbox can poll from here on, no retyping
    return this.openWith(key, this.id.handle)
  }

  /** The same read, but with the cached key and no answer prompt. Silent by design: if nothing is
   *  cached, or the salt moved on, it simply reports nothing rather than nagging. */
  async pendingKnocks(): Promise<OpenedKnock[]> {
    if (!this.id?.handle) return []
    const config = await this.myKnockConfig()
    if (!config) return []
    const key = this.cachedKnockKey(config.salt)
    if (!key) return []
    try {
      return await this.openWith(key, this.id.handle)
    } catch {
      return [] // the inbox must never break because the relay hiccuped
    }
  }

  /** Our own knock config, cached: it is read twice per poll (state + pending) and changes only
   *  when we publish, which goes through setKnock and can invalidate it directly. */
  private myKnock: { at: number; config: ReturnType<typeof parseKnockConfig> } | null = null

  private async myKnockConfig(): Promise<ReturnType<typeof parseKnockConfig>> {
    if (!this.id?.handle) return null
    if (this.myKnock && Date.now() - this.myKnock.at < 60_000) return this.myKnock.config
    const config = parseKnockConfig(await ens.readText(this.id.handle, REC.knock))
    this.myKnock = { at: Date.now(), config }
    return config
  }

  async knockState(): Promise<'none' | 'armed' | 'locked'> {
    const config = await this.myKnockConfig()
    if (!config) return 'none'
    return this.cachedKnockKey(config.salt) ? 'armed' : 'locked'
  }

  private async openWith(key: Uint8Array, handle: string): Promise<OpenedKnock[]> {
    const { knocks } = await fetchKnocks(handle)
    const opened: OpenedKnock[] = []
    for (const k of knocks) {
      const payload = openKnock(key, k.sealed)
      // A failed open is indistinguishable from a knock meant for a different answer, and both
      // are simply skipped — never surfaced, never counted.
      if (payload) opened.push({ id: k.id, pubkey: payload.pubkey, from: payload.from, intro: payload.intro, ts: payload.ts })
    }
    return opened.sort((a, b) => b.ts - a.ts)
  }

  private cacheKnockKey(salt: string, key: Uint8Array): void {
    sessionStorage.setItem(KNOCK_KEY, JSON.stringify({ salt, key: toHex(key) }))
  }

  private cachedKnockKey(salt: string): Uint8Array | null {
    try {
      const got = JSON.parse(sessionStorage.getItem(KNOCK_KEY) || 'null') as
        | { salt?: string; key?: string }
        | null
      // Salt mismatch = the question was re-published, so this key opens nothing. Drop it rather
      // than silently returning an empty inbox forever.
      if (!got?.key || got.salt !== salt) return null
      return fromHex(got.key)
    } catch {
      return null
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
