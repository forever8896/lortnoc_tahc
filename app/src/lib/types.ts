// Canonical shapes (CLAUDE.md §5.4).

export type Handle = string // "<name>.lortnoctahc.eth"

export type Message = {
  v: 1
  from: Handle
  to: Handle
  ts: number // unix ms
  body: string
}

/** Where a send has got to. Storing a message is a multi-second, multi-step journey (encrypt →
 *  Walrus blob → Sui head), and a composer that just freezes for that long reads as broken. */
export type SendStage = 'encrypting' | 'storing' | 'anchoring'

export const SEND_STAGE_LABEL: Record<SendStage, string> = {
  encrypting: 'encrypting on this device',
  storing: 'storing on Walrus',
  anchoring: 'anchoring on Sui',
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

/** One identity record, as this device derives it vs. as the handle actually publishes it.
 *
 *  This type exists because the two can silently disagree. `pubkey` and `sui` are written by the
 *  app, not the user (RECORD_SPECS marks them `owned: false`), and the sign-in self-heal that
 *  maintains them is silent-only — so when it cannot sign it returns without a word and the
 *  handle goes on advertising an identity the owner stopped using. Peers then address a dead
 *  account and every message they send is invisible to both sides, with no error anywhere.
 *  Measured in the field: a handle publishing a Sui address last used two months earlier. */
export type IdentityRepair = {
  key: string
  label: string
  /** What the handle publishes today. */
  onChain: string | null
  /** What this device derives from the master secret — the value that is actually in use. */
  expected: string
  status: 'ok' | 'repaired' | 'cannot-write' | 'failed'
  /** Why, when the status is not a happy one. Always says which key would be needed. */
  detail?: string
}
