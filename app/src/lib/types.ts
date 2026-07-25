// Canonical shapes (CLAUDE.md §5.4).

export type Handle = string // "<name>.lortnoctahc.eth"

export type Message = {
  v: 1
  from: Handle
  to: Handle
  ts: number // unix ms
  body: string
}

export type Conversation = {
  convId: string
  peer: Handle
  headBlobId?: string
  seq: number
  updatedAt: number
  messages: Message[]
}

export type Identity = {
  handle: Handle | null
  /** The connected wallet. This is the one that PAYS — it never owns the handle (§4). */
  address: string
  /** The address that owns the handle, derived from MS. Never sends a transaction to get it, and
   *  has no on-chain link to `address` — that link exists only inside MS, on this device. */
  ownerAddress: string
  pubkeyHex: string // X25519 messaging pubkey (eth.lortnoc.pubkey)
}

export type Health = { mode: 'demo' | 'live'; ens: boolean; store: boolean }

/** Where the paid claim has got to. Proving takes real seconds, so the UI narrates it rather
 *  than showing one long spinner. */
export type ClaimStage =
  | 'checking-membership'
  | 'loading-group'
  | 'proving'
  | 'relaying'
  | 'waiting-for-ens'
  | 'verifying-pubkey'
  | 'done'

/** A knock that opened — i.e. someone answered your question correctly (§6.8). */
export type OpenedKnock = {
  id: string
  /** Their X25519 key. A successful knock IS the key exchange, so this bootstraps K_conv. */
  pubkey: string
  from?: string
  intro: string
  ts: number
}

/** One text record and who may currently write it — read live off the resolver's EAC state. */
export type RecordPerm = {
  key: string
  value: string | null
  ownerCanWrite: boolean
  gatewayCanWrite: boolean
}

/** Everything the identity panel shows about the on-chain side of a handle. */
export type EnsStatus = {
  /** false = mock mode, or day-0 setup not done. */
  live: boolean
  handle: Handle | null
  /** The handle's own PermissionedResolver proxy. */
  resolver: string | null
  /** VerifiableFactory.verifyContract(resolver) matched the canonical implementation. */
  factoryVerified: boolean
  impl: string
  /** The address the inbox delegation is granted to. */
  gateway: string
  /** True once the gateway holds ROLE_SET_TEXT on the inbox record. */
  inboxDelegated: boolean
  perms: RecordPerm[]
  explorer: string | null
  /** The Sui account that pays for storage — derived from MS, so it is NOT the identity wallet
   *  and starts empty. Sending fails until it holds SUI (gas) and WAL (Walrus storage). */
  store?: {
    address: string
    sui: string
    wal: string
    ready: boolean
  }
}
