// Handshake session state machine (extension/src/content/session.ts).
//
// Imported with a chrome.* stub, so the real persist/load path is exercised — that path is
// how a session survives a service-worker cycle, and a silent failure there presents to the
// user as "the extension forgot our key mid-conversation".
//
// Module state is a singleton, so tests reset() between cases rather than re-importing.
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { installChromeStub, eq } from '../lib/env.mjs'

const store = installChromeStub()

const session = await import('../../extension/src/content/session.ts')
const { parseFrame, FRAME } = await import('../../extension/src/content/handshake.ts')
const { genKeyPair, deriveConvKey, encrypt, tryDecrypt } = await import('../../extension/src/content/crypto.ts')

beforeEach(async () => {
  await session.reset()
  store.reset()
})

describe('state machine (§5.3 Tier-1)', () => {
  test('starts with no session and no key', () => {
    assert.equal(session.status(), 'none')
    assert.equal(session.convKey(), null)
  })

  test('startOffer moves to "offered" and emits a parseable OFFER frame', async () => {
    const frame = await session.startOffer()
    assert.equal(session.status(), 'offered')
    const parsed = parseFrame(frame)
    assert.ok(parsed)
    assert.equal(parsed.type, FRAME.OFFER)
    // Still no key: an offer alone establishes nothing.
    assert.equal(session.convKey(), null)
  })

  test('startOffer twice reuses the SAME keypair — the documented decrypt bug', async () => {
    // A second Connect click used to regenerate the keypair, so the pubkey the peer had
    // already answered no longer matched ours and neither side could read the other.
    const first = parseFrame(await session.startOffer()).pubkey
    const second = parseFrame(await session.startOffer()).pubkey
    assert.ok(eq(first, second), 'a second Connect click rotated our pubkey mid-handshake')
  })

  test('acceptOffer derives the key, establishes, and returns an ACK carrying OUR pubkey', async () => {
    const peer = genKeyPair()
    const ack = await session.acceptOffer(peer.pub)
    assert.equal(session.status(), 'established')
    assert.ok(session.convKey())
    const parsed = parseFrame(ack)
    assert.equal(parsed.type, FRAME.ACK)
    assert.ok(!eq(parsed.pubkey, peer.pub), 'the ACK echoed the PEER pubkey instead of ours')
    // The key we derived must match what the peer derives from the ACK.
    assert.ok(eq(session.convKey(), deriveConvKey(peer.priv, parsed.pubkey, peer.pub)))
  })

  test('onAck derives the same key the acceptOffer side derived', async () => {
    const peer = genKeyPair()
    const ourOffer = parseFrame(await session.startOffer()).pubkey
    const peerKey = deriveConvKey(peer.priv, ourOffer, peer.pub)
    await session.onAck(peer.pub)
    assert.equal(session.status(), 'established')
    assert.ok(eq(session.convKey(), peerKey))
    // And a real message crosses.
    assert.equal(tryDecrypt(session.convKey(), encrypt(peerKey, 'their message')), 'their message')
  })

  test('reset clears the key, the peer and the status', async () => {
    await session.acceptOffer(genKeyPair().pub)
    assert.equal(session.status(), 'established')
    await session.reset()
    assert.equal(session.status(), 'none')
    assert.equal(session.convKey(), null)
    assert.equal(session.isPeer(genKeyPair().pub), false)
  })
})

describe('identity checks — whose frame is this?', () => {
  test('isMine recognises our own frame echoed back into the chat', async () => {
    // Telegram selectors match outgoing bubbles too, so we decode our own OFFER. Acting on
    // it would key us to ourselves.
    const ourPub = parseFrame(await session.startOffer()).pubkey
    assert.equal(session.isMine(ourPub), true)
    assert.equal(session.isMine(genKeyPair().pub), false)
  })

  test('isMine is false before any keypair exists', () => {
    assert.equal(session.isMine(genKeyPair().pub), false)
  })

  test('isPeer distinguishes the established peer from a restarted one', async () => {
    const peer = genKeyPair()
    await session.acceptOffer(peer.pub)
    assert.equal(session.isPeer(peer.pub), true)
    assert.equal(session.isPeer(genKeyPair().pub), false, 'a new pubkey was mistaken for the current peer')
  })

  test('isMine / isPeer reject wrong-length input instead of throwing', () => {
    assert.equal(session.isMine(new Uint8Array(8)), false)
    assert.equal(session.isPeer(new Uint8Array(64)), false)
  })
})

describe('persistence across a service-worker cycle', () => {
  test('an established session survives loadSession()', async () => {
    const peer = genKeyPair()
    await session.acceptOffer(peer.pub)
    const before = session.convKey()

    await session.reset() // simulate the worker being torn down (in-memory state lost)
    // reset() also wrote the cleared state, so re-seed storage the way a live session would
    // have left it, then reload.
    await session.acceptOffer(peer.pub)
    const key = session.convKey()
    await session.loadSession()
    assert.equal(session.status(), 'established')
    assert.ok(eq(session.convKey(), key))
    assert.ok(before.length === 64 && key.length === 64)
  })

  test('key material goes to storage.session, never storage.local (§ ephemeral keys)', async () => {
    await session.acceptOffer(genKeyPair().pub)
    assert.ok(store.peek('session', 'hs'), 'handshake state is not in storage.session')
    assert.equal(store.peek('local', 'hs'), undefined, 'key material leaked into storage.local (survives browser close)')
  })

  test('loadSession on a cold profile leaves the state machine at "none"', async () => {
    store.reset()
    await session.loadSession()
    assert.equal(session.status(), 'none')
  })
})

describe('reconnect semantics', () => {
  test('re-establishing with a restarted peer replaces the key', async () => {
    const peerV1 = genKeyPair()
    await session.acceptOffer(peerV1.pub)
    const k1 = session.convKey()

    const peerV2 = genKeyPair() // peer reinstalled → brand new keypair
    await session.acceptOffer(peerV2.pub)
    assert.ok(!eq(session.convKey(), k1), 'the stale key survived a peer restart')
    assert.equal(session.isPeer(peerV2.pub), true)
  })

  test('reset() clears the replay guard so a ONE-SIDED reconnect completes (EXT-1)', async () => {
    // The regression this guards, end to end:
    //   1. Alice and Bob are established; their keys mismatch.
    //   2. Alice alone hits Disconnect → Connect (what the toast tells her to do).
    //   3. Bob never reset, so his ACK carries the SAME pubkey as the first handshake.
    //   4. If the guard survived Alice's reset, that ACK reads as "already handled" and is
    //      dropped — Alice hangs in 'offered' forever with no error anywhere.
    const bob = genKeyPair()

    // First handshake: Alice offers, Bob acks.
    await session.startOffer()
    assert.equal(session.alreadyHandled(FRAME.ACK, bob.pub), false, 'first ACK should be new')
    await session.onAck(bob.pub)
    assert.equal(session.status(), 'established')

    // Alice disconnects and reconnects. Bob does not.
    await session.reset()
    await session.startOffer()

    // Bob's ACK arrives with his unchanged pubkey. It must NOT be treated as a replay.
    assert.equal(
      session.alreadyHandled(FRAME.ACK, bob.pub),
      false,
      'the peer ACK was dropped as already-handled — the one-sided reconnect hangs',
    )
    await session.onAck(bob.pub)
    assert.equal(session.status(), 'established', 'reconnect did not complete')
    assert.ok(session.convKey())
  })

  test('the replay guard still suppresses a genuine duplicate within one session', () => {
    // The guard exists because inbound.reset() re-scans and re-decodes the OFFER/ACK bubbles
    // still on screen. Clearing it on reset must not weaken that.
    const peer = genKeyPair()
    assert.equal(session.alreadyHandled(FRAME.OFFER, peer.pub), false)
    assert.equal(session.alreadyHandled(FRAME.OFFER, peer.pub), true, 'a replayed OFFER was re-processed')
    assert.equal(session.alreadyHandled(FRAME.OFFER, peer.pub), true)
  })

  test('the guard distinguishes frame type and pubkey', () => {
    const a = genKeyPair()
    const b = genKeyPair()
    assert.equal(session.alreadyHandled(FRAME.OFFER, a.pub), false)
    assert.equal(session.alreadyHandled(FRAME.ACK, a.pub), false, 'an ACK was confused with an OFFER')
    assert.equal(session.alreadyHandled(FRAME.OFFER, b.pub), false, 'a different peer was confused with the first')
  })

  test('clearHandledFrames lets a restarted peer re-offer without being suppressed', () => {
    const peer = genKeyPair()
    assert.equal(session.alreadyHandled(FRAME.OFFER, peer.pub), false)
    session.clearHandledFrames()
    assert.equal(session.alreadyHandled(FRAME.OFFER, peer.pub), false, 'clear did not forget the frame')
  })
})
