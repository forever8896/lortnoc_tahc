// Handshake session: our ephemeral keypair + the ECDH-derived conversation key.
// For the demo this is a single active session (matches the global-toggle model). It
// lives in memory and is mirrored to storage.session (cleared on browser close) so it
// survives service-worker cycles — never written to disk (ephemeral key material).
import { genKeyPair, deriveConvKey, type KeyPair } from './crypto'
import { buildFrame, FRAME } from './handshake'

export type Status = 'none' | 'offered' | 'established'

type Session = {
  keyPair: KeyPair | null
  peerPub: Uint8Array | null
  convKey: Uint8Array | null
  status: Status
}

const s: Session = { keyPair: null, peerPub: null, convKey: null, status: 'none' }

/**
 * Handshake replay guard: every OFFER/ACK frame is acted on AT MOST ONCE, keyed by
 * `type:pubkey`. Without it, the `inbound.reset()` re-scan that follows a successful
 * handshake re-decodes the OFFER/ACK bubbles still on screen and re-fires the accept banner
 * → an infinite handshake loop that resends frames.
 *
 * It lives HERE, next to the state it guards, because it is part of the session's lifetime.
 * It used to be module state in content/index.ts, where nothing cleared it on reset — so a
 * one-sided Disconnect→Connect hung forever: the resetting side sent a fresh OFFER, the peer
 * (who had not reset) re-established and ACKed with its UNCHANGED pubkey, and that ACK was
 * dropped as "already handled" from the first handshake. Status stayed 'offered', no error
 * surfaced, and the 25-second timeout blamed the other side. That is precisely the recovery
 * the key-mismatch toast tells users to perform.
 */
const handledFrames = new Set<string>()

const frameKey = (type: number, pub: Uint8Array): string =>
  `${type}:${Array.from(pub, (b) => b.toString(16).padStart(2, '0')).join('')}`

/** True if this exact frame was already acted on. Records it either way. */
export function alreadyHandled(type: number, pub: Uint8Array): boolean {
  const k = frameKey(type, pub)
  if (handledFrames.has(k)) return true
  handledFrames.add(k)
  return false
}

/** Forget every seen frame — used when the peer restarts and we re-establish from scratch. */
export function clearHandledFrames(): void {
  handledFrames.clear()
}

const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u))
const unb64 = (x: string): Uint8Array => Uint8Array.from(atob(x), (c) => c.charCodeAt(0))

async function persist(): Promise<void> {
  await chrome.storage.session.set({
    hs: {
      priv: s.keyPair ? b64(s.keyPair.priv) : null,
      pub: s.keyPair ? b64(s.keyPair.pub) : null,
      peerPub: s.peerPub ? b64(s.peerPub) : null,
      convKey: s.convKey ? b64(s.convKey) : null,
      status: s.status,
    },
  })
}

export async function loadSession(): Promise<void> {
  const got = (await chrome.storage.session.get('hs')).hs as
    | { priv: string | null; pub: string | null; peerPub: string | null; convKey: string | null; status: Status }
    | undefined
  if (!got) return
  s.keyPair = got.priv && got.pub ? { priv: unb64(got.priv), pub: unb64(got.pub) } : null
  s.peerPub = got.peerPub ? unb64(got.peerPub) : null
  s.convKey = got.convKey ? unb64(got.convKey) : null
  s.status = got.status ?? 'none'
}

export function status(): Status {
  return s.status
}

/** True if this pubkey is our own — used to ignore our own handshake frames echoed
 *  back into the chat (selectors match both incoming and outgoing bubbles). */
export function isMine(pub: Uint8Array): boolean {
  if (!s.keyPair) return false
  const me = s.keyPair.pub
  if (me.length !== pub.length) return false
  for (let i = 0; i < me.length; i++) if (me[i] !== pub[i]) return false
  return true
}

/** Is this the peer we are currently established with? A different pubkey means they restarted. */
export function isPeer(pub: Uint8Array): boolean {
  if (!s.peerPub || s.peerPub.length !== pub.length) return false
  for (let i = 0; i < s.peerPub.length; i++) if (s.peerPub[i] !== pub[i]) return false
  return true
}

/** The ECDH conversation key — the only key there is. */
export function convKey(): Uint8Array | null {
  return s.convKey
}

function ensureKeyPair(): KeyPair {
  if (!s.keyPair) s.keyPair = genKeyPair()
  return s.keyPair
}

/** Start a handshake: returns the OFFER frame bytes to send as cover text. */
export async function startOffer(): Promise<Uint8Array> {
  const kp = ensureKeyPair()
  s.status = 'offered'
  await persist()
  return buildFrame(FRAME.OFFER, kp.pub)
}

/** Peer accepted our offer (we received their ACK): derive the shared key. */
export async function onAck(peerPub: Uint8Array): Promise<boolean> {
  const kp = ensureKeyPair()
  s.peerPub = peerPub
  s.convKey = deriveConvKey(kp.priv, peerPub, kp.pub)
  s.status = 'established'
  await persist()
  return true
}

/**
 * We received an OFFER. Derive the shared key and return the ACK frame bytes to send
 * back (caller decides whether to send now, e.g. after a one-tap Accept).
 */
export async function acceptOffer(peerPub: Uint8Array): Promise<Uint8Array> {
  const kp = ensureKeyPair()
  s.peerPub = peerPub
  s.convKey = deriveConvKey(kp.priv, peerPub, kp.pub)
  s.status = 'established'
  await persist()
  return buildFrame(FRAME.ACK, kp.pub)
}

export async function reset(): Promise<void> {
  s.keyPair = null
  s.peerPub = null
  s.convKey = null
  s.status = 'none'
  // MUST clear the replay guard too. Disconnect means "forget this conversation entirely";
  // leaving stale frame keys behind is what made a one-sided reconnect hang forever.
  handledFrames.clear()
  await persist()
}
