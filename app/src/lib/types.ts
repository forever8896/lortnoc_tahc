// Canonical shapes (CLAUDE.md §5.4).

export type Handle = string // "<name>.lortnoc.eth"

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
