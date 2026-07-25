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
  address: string // identity wallet address (public)
  pubkeyHex: string // X25519 messaging pubkey (eth.lortnoc.pubkey)
}

export type Health = { mode: 'demo' | 'live'; ens: boolean; store: boolean }

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
}
