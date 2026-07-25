// The app talks to ONE Backend interface. Two implementations:
//   - MockBackend: real E2E crypto (ECDH + AES-SIV) over a localStorage "network" — fully
//     functional and demoable with no chain access (two browser tabs share localStorage = two
//     users chatting).
//   - LiveBackend: real ENS v2 on Sepolia (viem, deployed contracts) + Sui/Walrus/Seal.
import type { Conversation, EnsStatus, Health, Identity, Message } from './types'

export interface Backend {
  health(): Health
  /** Connect / restore an identity (wallet-sign in live, seed in mock). */
  connect(): Promise<Identity>
  currentIdentity(): Identity | null
  /** Claim <name>.lortnoctahc.eth and publish the messaging pubkey. */
  claimHandle(name: string): Promise<Identity>
  isHandleAvailable(name: string): Promise<boolean>
  /** Resolve a peer handle → their X25519 pubkey hex (null if unknown). */
  resolvePubkey(handle: string): Promise<string | null>
  listConversations(): Promise<Conversation[]>
  getConversation(peer: string): Promise<Conversation>
  send(peer: string, body: string): Promise<Message>

  // ---- ENS v2 self-sovereignty surface (§6.5) --------------------------------------------------
  /** Live on-chain view of the handle: resolver, factory proof, per-record write permissions. */
  ensStatus(): Promise<EnsStatus>
  /** Grant (or revoke) write access to eth.lortnoc.inbox — and nothing else — for the gateway. */
  delegateInbox(grant: boolean): Promise<string>
}

export const HANDLE_SUFFIX = '.lortnoctahc.eth'
export const fullHandle = (name: string): string =>
  name.endsWith(HANDLE_SUFFIX) ? name : `${name}${HANDLE_SUFFIX}`
export const shortName = (handle: string): string =>
  handle.endsWith(HANDLE_SUFFIX) ? handle.slice(0, -HANDLE_SUFFIX.length) : handle
