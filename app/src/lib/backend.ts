// The app talks to ONE Backend interface. Two implementations:
//   - MockBackend: real E2E crypto (ECDH + AES-SIV) over a localStorage "network" — fully
//     functional and demoable with no chain access (two browser tabs share localStorage = two
//     users chatting).
//   - LiveBackend: real ENS v2 on Sepolia (viem, deployed contracts) + Sui/Walrus/Seal.
import type { ClaimStage, Conversation, EnsStatus, Health, Identity, Message, OpenedKnock } from './types'

export interface Backend {
  health(): Health
  /** Connect / restore an identity (wallet-sign in live, seed in mock). */
  connect(): Promise<Identity>
  currentIdentity(): Identity | null
  /** Resume a previous sign-in WITHOUT another wallet signature. Null when there is nothing to
   *  resume. Called once on load, before showing the connect screen. */
  restore(): Promise<Identity | null>
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
  /** Grant (or revoke) write access to ONE text record for an address. The ENS v2 flagship:
   *  least-privilege, per-record, revocable in a single transaction. */
  delegateRecord(key: string, to: string, grant: boolean): Promise<string>

  /** Write one of your own text records. */
  setRecord(key: string, value: string): Promise<string>

  /** Unlock unlimited codec use in the Telegram extension using the membership already paid for.
   *  'no-extension' means nothing was listening — not that it failed. */
  unlockExtension(): Promise<'unlocked' | 'no-extension' | 'not-a-member'>

  /** Re-offer a stored codec token to the extension. No-op when there is none. */
  redeliverCodecToken?(): void

  // ---- knock: challenge-gated contact (§6.8) ---------------------------------------------------
  /** Publish a question. The answer is used to derive a key and then forgotten — it is never
   *  stored, never sent, and never published. */
  setKnock(prompt: string, answer: string): Promise<string>
  /** The question a handle asks of strangers, if any. Null when they accept open contact. */
  peerKnockPrompt(handle: string): Promise<string | null>

  /** Knock on someone's door: derive their key from your answer and send a sealed introduction. */
  sendKnock(toHandle: string, answer: string, intro: string): Promise<'sent' | 'no-knock'>
  /** Open your pending knocks with your own answer. Wrong-answer knocks stay invisible. */
  readKnocks(answer: string): Promise<OpenedKnock[]>
  /** Knocks openable with the key cached from the last publish/check — so the inbox can surface
   *  them on its own instead of waiting for you to retype the answer somewhere you'd have to
   *  know to look. Empty when no key is cached (nothing is ever derived from a stored answer:
   *  we cache the derived key, never the answer). */
  pendingKnocks(): Promise<OpenedKnock[]>
  /** Can the inbox open knocks right now?
   *   'none'   — no question published, so nobody can knock
   *   'armed'  — a key is cached; pendingKnocks() will surface arrivals on its own
   *   'locked' — a question is published but this tab has no key, so knocks cannot be read yet
   *  Deliberately says nothing about how many sealed knocks are waiting: revealing that would
   *  tell you wrong answers had arrived, which §6.8 promises it never will. */
  knockState(): Promise<'none' | 'armed' | 'locked'>
  /** Accept a knock: remember that this peer is through the door. They knocked and answered, so
   *  the conversation exists from now on even before a first message — it appears in the list,
   *  and their own gate no longer applies to us (a knock we opened is mutual consent; making the
   *  recipient counter-knock to reply would be absurd). */
  acceptKnock(handle: string): Promise<void>

  /** The master secret, for deriving the Semaphore membership identity (§5.1). Null in mock
   *  mode and before sign-in. Never leaves the device. */
  masterSecret(): Uint8Array | null

  /** Is the paid, unlinkable claim path usable right now? (live mode + membership deployed +
   *  relayer answering). False ⇒ fall back to the free path. */
  paidClaimAvailable(): Promise<boolean>

  /** Claim via the paid path: prove membership, hand the ticket to a relayer, and let IT issue
   *  the handle — so the wallet that receives it never signs anything on Sepolia. */
  claimHandlePaid(name: string, onStage?: (s: ClaimStage) => void): Promise<Identity>
}

export const HANDLE_SUFFIX = '.lortnoctahc.eth'
export const fullHandle = (name: string): string =>
  name.endsWith(HANDLE_SUFFIX) ? name : `${name}${HANDLE_SUFFIX}`
export const shortName = (handle: string): string =>
  handle.endsWith(HANDLE_SUFFIX) ? handle.slice(0, -HANDLE_SUFFIX.length) : handle
