// The app talks to ONE Backend interface. Two implementations:
//   - MockBackend: real E2E crypto (ECDH + AES-SIV) over a localStorage "network" — fully
//     functional and demoable NOW (two browser tabs share localStorage = two users chatting).
//   - LiveBackend: real ENS (viem) + Sui/Walrus/Seal. Wired against the SDKs; the on-chain
//     txs are validated in-browser with a wallet (see live.ts).
import type { Conversation, Health, Identity, Message } from './types'

export interface Backend {
  health(): Health
  /** Connect / restore an identity (wallet-sign in live, seed in mock). */
  connect(): Promise<Identity>
  currentIdentity(): Identity | null
  /** Claim <name>.lortnoc.eth and publish the messaging pubkey. */
  claimHandle(name: string): Promise<Identity>
  isHandleAvailable(name: string): Promise<boolean>
  /** Resolve a peer handle → their X25519 pubkey hex (null if unknown). */
  resolvePubkey(handle: string): Promise<string | null>
  listConversations(): Promise<Conversation[]>
  getConversation(peer: string): Promise<Conversation>
  send(peer: string, body: string): Promise<Message>
  /** ENS creative-use demos (live only; mock returns a narrated result). */
  delegateInbox(): Promise<string>
  verifyResolver(): Promise<{ ok: boolean; detail: string }>
}

export const HANDLE_SUFFIX = '.lortnoc.eth'
export const fullHandle = (name: string): string =>
  name.endsWith(HANDLE_SUFFIX) ? name : `${name}${HANDLE_SUFFIX}`
