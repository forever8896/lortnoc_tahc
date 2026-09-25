// DM TIER — Lortnoc DM end to end, on real chains, with real wallets.
//
// This is the layer CLAUDE.md §2.1 recorded as having NO automated tier: §6.4 (Sui/Walrus/Seal)
// said "no automated tier" and §6.6 (native DM) had an empty test column. Everything below the UI
// was proven only by hand-run scripts, which is how a transport regression reaches a demo.
//
// What makes it end to end rather than a replica: it imports app/src/lib/live/sui.ts and calls the
// SAME sendMessage/readMessages the Messenger UI calls. The wallets are derived through
// shared/keys.mjs exactly as a signed-in user's are. Nothing here re-implements the product.
//
// TWO WALLETS, ONE FUNDED. Writing costs Sui gas plus WAL; reading costs nothing, because a
// reader only signs a Seal session key off-chain and fetches blobs over HTTP. So Alice writes and
// Bob reads, and the access-control cases come free. `node test/dm/fund.mjs` tops Alice up.
//
// Skips (never fails) when Alice is unfunded or the network is unreachable — the same contract
// the codec tier uses, so `npm test` stays green offline.
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { ALICE, BOB, MALLORY, convKeyBetween } from './identities.mjs'
import { deriveConvKey, fromHex } from '../../shared/keys.mjs'
import { SuiClient } from '../../app/node_modules/@mysten/sui/dist/esm/client/index.js'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const RPC = process.env.VITE_SUI_RPC || 'https://sui-testnet-rpc.publicnode.com'
/** Enough for a WHOLE RUN, not one message.
 *
 *  The balance is checked once, in `before`. A threshold sized for a single send let the tier
 *  start with "enough", then run dry midway and FAIL on a write — which reads as a product fault
 *  and is really just an empty wallet. A full run is ~57M SUI (four sends, each up to two txs
 *  plus a blob), so the bar is set above that and the tier skips honestly instead. */
const MIN_SUI = 80_000_000n
const MIN_WAL = 30_000_000n

let sendMessage, readMessages, skipReason = null
let ensSkip = null
/** Reused across tests so the conversation accumulates, like a real thread. */
let headId = null

before(async () => {
  try {
    ;({ sendMessage, readMessages } = await import('../../app/src/lib/live/sui.ts'))
  } catch (e) {
    skipReason = `app live/sui.ts would not load (${String(e).slice(0, 60)})`
    return
  }
  try {
    const sui = new SuiClient({ url: RPC })
    const balances = Object.fromEntries(
      (await sui.getAllBalances({ owner: ALICE.address })).map((b) => [b.coinType, BigInt(b.totalBalance)]),
    )
    const suiBal = balances['0x2::sui::SUI'] ?? 0n
    const walBal = Object.entries(balances).find(([t]) => t.endsWith('::wal::WAL'))?.[1] ?? 0n
    if (suiBal < MIN_SUI || walBal < MIN_WAL) {
      skipReason = `ALICE underfunded (SUI ${suiBal}, WAL ${walBal}) — run: node test/dm/fund.mjs`
    }
  } catch (e) {
    skipReason = `Sui testnet unreachable (${String(e).slice(0, 50)})`
  }
  if (skipReason) console.log(`\n  ⚠ DM tier skipped — ${skipReason}\n`)
})

const needsChain = () => (skipReason ? { skip: skipReason } : false)

/**
 * Read until the expected bodies show up, or give up.
 *
 * NOT test-flakiness papering: it is what the product does. A freshly written Walrus blob is not
 * instantly readable everywhere and a Sui object read can lag the transaction that wrote it, so
 * `readMessages` legitimately returns a short list for a moment. The Messenger POLLS for exactly
 * this reason (§6.6 — "poll head/inbox", realtime relay is roadmap), so a test that reads once is
 * testing a stricter contract than the product offers, and fails intermittently for a behaviour
 * that is correct. Observed: the append case passed and failed on consecutive runs.
 *
 * The retry is bounded, so a message that never arrives still fails the test.
 */
/**
 * Send, retrying transient upload-relay failures.
 *
 * Walrus's public upload relay intermittently answers 500, which is an outage in someone else's
 * service rather than anything about this code — the same write succeeds moments later. A test
 * that treats it as a product failure cries wolf; one that ignores write failures altogether
 * proves nothing. So: retry a bounded number of times, and let anything still failing through.
 */
async function sendWithRetry(...args) {
  let last
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await sendMessage(...args)
    } catch (e) {
      last = e
      const transient = e?.status === 500 || /internal client error|fetch failed|timeout/i.test(String(e?.message ?? e))
      if (!transient) throw e
      console.log(`      walrus relay hiccup (${e?.status ?? 'network'}), retrying…`)
      await new Promise((r) => setTimeout(r, 4000))
    }
  }
  throw last
}

async function readUntil(head, convKey, signer, expected, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  let bodies = []
  for (;;) {
    bodies = (await readMessages(head, convKey, signer)).map((m) => m.body)
    if (expected.every((e) => bodies.includes(e))) return bodies
    if (Date.now() > deadline) return bodies
    await new Promise((r) => setTimeout(r, 3000))
  }
}

// ---------------------------------------------------------------------------
// Key agreement — free, and the precondition for everything below
// ---------------------------------------------------------------------------
describe('two wallets agree a conversation key with no handshake (§5.3 Tier 2)', () => {
  test('both sides derive the SAME key from opposite directions', () => {
    // The property the whole DM design rests on: ECDH is symmetric, so no secret is ever
    // transmitted and there is no handshake to fail. If this breaks, each side reads only its
    // own messages — silently, with no error anywhere.
    assert.deepEqual(convKeyBetween(ALICE, BOB), convKeyBetween(BOB, ALICE))
  })

  test('a third party derives a DIFFERENT key', () => {
    assert.notDeepEqual(convKeyBetween(ALICE, BOB), convKeyBetween(ALICE, MALLORY))
    assert.notDeepEqual(convKeyBetween(ALICE, BOB), convKeyBetween(MALLORY, BOB))
  })

  test('the Sui account and the messaging key come from ONE master secret', () => {
    // "A wallet owning a handle" means exactly this: the key the handle advertises and the
    // account that pays for storage are the same identity. Deriving them separately would let
    // them drift and the failure would look like "the other person cannot read me".
    assert.match(ALICE.address, /^0x[0-9a-f]{64}$/)
    assert.equal(ALICE.pubHex.length, 64)
    assert.notEqual(ALICE.address, BOB.address)
    assert.notEqual(ALICE.pubHex, BOB.pubHex)
  })
})

// ---------------------------------------------------------------------------
// Discovery — "message a NAME", which is the actual product
// ---------------------------------------------------------------------------
describe('a handle resolves to the wallet behind it (§5.3 Tier 2, §6.5)', () => {
  let ens, cfg
  before(async () => {
    try {
      ens = await import('../../app/src/lib/live/ens.ts')
      cfg = await import('../../app/src/lib/live/config.ts')
    } catch (e) {
      ensSkip = `ens module would not load (${String(e).slice(0, 50)})`
    }
  })

  test('alice.lortnoctahc.eth publishes the key her wallet actually derives', async (t) => {
    if (ensSkip) return t.skip(ensSkip)
    const pub = await ens.resolvePubkey('alice.lortnoctahc.eth')
    // The whole point of the directory: a stranger who has never met Alice gets the SAME key she
    // derives from her master secret. If these drift, nobody can message her and nothing errors.
    assert.equal(pub, ALICE.pubHex, 'published pubkey does not match ALICE')
  })

  test('...and the Sui address the head will gate on', async (t) => {
    if (ensSkip) return t.skip(ensSkip)
    // seal_approve checks member ADDRESSES, so a handle without this record is unmessageable —
    // live.ts::send refuses outright rather than writing something the peer could never open.
    assert.equal(await ens.readText('alice.lortnoctahc.eth', cfg.REC.sui), ALICE.address)
    assert.equal(await ens.readText('bob.lortnoctahc.eth', cfg.REC.sui), BOB.address)
  })

  test('a conversation key derived from the RESOLVED key matches the local one', async (t) => {
    if (ensSkip) return t.skip(ensSkip)
    // This is the join between discovery and crypto. Alice looks Bob up by name, derives a key
    // from what ENS returned, and it equals the key Bob derives from his own secret — with no
    // handshake and nothing exchanged.
    const resolved = await ens.resolvePubkey('bob.lortnoctahc.eth')
    const fromDirectory = deriveConvKey(ALICE.msg.priv, fromHex(resolved), ALICE.msg.pub)
    assert.deepEqual(fromDirectory, convKeyBetween(BOB, ALICE))
  })
})

// ---------------------------------------------------------------------------
// The real transport — Seal encrypt → Walrus blob → Sui head → read back
// ---------------------------------------------------------------------------
describe('a message survives the real Sui/Walrus/Seal round trip (§6.4, §6.6)', () => {
  const BODY = `dm tier ${new Date().toISOString()}`

  test('Alice sends: a head is created and a blob written', { skip: needsChain() }, async (t) => {
    if (skipReason) return t.skip(skipReason)
    const stages = []
    const msg = { v: 1, from: 'alice.lortnoctahc.eth', to: 'bob.lortnoctahc.eth', ts: Date.now(), body: BODY }
    const res = await sendWithRetry(
      null, convKeyBetween(ALICE, BOB), msg, ALICE.signer, BOB.address, (s) => stages.push(s),
    )
    assert.match(res.headId, /^0x[0-9a-f]{64}$/, 'a ConversationHead object must exist on Sui')
    assert.ok(res.blobId, 'a Walrus blob id must come back')
    // The stage callback is what the UI renders; a send that reports nothing looks like a hang.
    assert.ok(stages.length > 0, `expected send stages, got ${JSON.stringify(stages)}`)
    headId = res.headId
    console.log(`      head ${res.headId.slice(0, 18)}…  blob ${String(res.blobId).slice(0, 18)}…  stages: ${stages.join(' → ')}`)
  })

  test('Bob reads it back — plaintext recovered, no funds needed', { skip: needsChain() }, async (t) => {
    if (skipReason) return t.skip(skipReason)
    assert.ok(headId, 'the send test must run first')
    const bodies = await readUntil(headId, convKeyBetween(BOB, ALICE), BOB.signer, [BODY])
    assert.ok(bodies.includes(BODY), `Bob did not recover the message; got ${JSON.stringify(bodies)}`)
  })

  test('Mallory cannot read it — the on-chain policy refuses her', { skip: needsChain() }, async (t) => {
    if (skipReason) return t.skip(skipReason)
    assert.ok(headId, 'the send test must run first')

    // RUN IN A CHILD PROCESS, and this is the whole point of the test rather than a detail.
    //
    // Seal decides access, not the conversation key: readMessages only uses convKey for pre-Seal
    // blobs, so a stranger is stopped by `seal_approve` asserting `head.members.contains(sender)`.
    // But sui.ts holds ONE module-level SealClient, and a SealClient CACHES derived key shares —
    // so once Bob's read has succeeded in this process, Mallory's decrypt is served from that
    // cache and "the stranger is refused" passes for the wrong reason. It passed here first time
    // round, which is exactly the trap CLAUDE.md §6.4 gotcha 4 warns about: "use a fresh client".
    //
    // A child process is the only honest fresh client, since the cache is module state.
    const here = dirname(fileURLToPath(import.meta.url))
    const out = execFileSync(
      process.execPath,
      [
        '--import', resolve(here, '../lib/resolve-ts.mjs'),
        '-e',
        `Promise.all([import(${JSON.stringify(resolve(here, 'identities.mjs'))}),` +
        ` import(${JSON.stringify(resolve(here, '../../app/src/lib/live/sui.ts'))})])` +
        `.then(async ([ids, sui]) => {` +
        `  const got = await sui.readMessages(${JSON.stringify(headId)},` +
        `    ids.convKeyBetween(ids.MALLORY, ids.ALICE), ids.MALLORY.signer);` +
        `  console.log('RESULT:' + JSON.stringify(got.map(m => m.body)));` +
        `}).catch(e => { console.log('RESULT:[]'); });`,
      ],
      { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const line = out.split('\n').find((l) => l.startsWith('RESULT:'))
    assert.ok(line, `child produced no result: ${out.slice(-200)}`)
    const bodies = JSON.parse(line.slice('RESULT:'.length))
    assert.ok(!bodies.includes(BODY), `a stranger read the conversation: ${JSON.stringify(bodies)}`)
  })

  test('a second message appends to the SAME head (a thread, not a new conversation)',
    { skip: needsChain() }, async (t) => {
    if (skipReason) return t.skip(skipReason)
    assert.ok(headId, 'the send test must run first')
    const second = `dm tier follow-up ${Date.now()}`
    const res = await sendWithRetry(
      headId, convKeyBetween(ALICE, BOB),
      { v: 1, from: 'alice.lortnoctahc.eth', to: 'bob.lortnoctahc.eth', ts: Date.now(), body: second },
      ALICE.signer, BOB.address,
    )
    assert.equal(res.headId, headId, 'appending must reuse the head, not create another')
    const bodies = await readUntil(headId, convKeyBetween(BOB, ALICE), BOB.signer, [BODY, second])
    assert.ok(bodies.includes(BODY) && bodies.includes(second), `thread lost a message: ${JSON.stringify(bodies)}`)
    // Ordering is what makes it a conversation rather than a bag of messages.
    assert.ok(bodies.indexOf(BODY) < bodies.indexOf(second), 'messages came back out of order')
  })
})

// ---------------------------------------------------------------------------
// The product flow: address a peer by NAME, with nothing known in advance
// ---------------------------------------------------------------------------
describe('Alice messages "bob.lortnoctahc.eth" knowing only the name', () => {
  test('resolve → derive → send → Bob reads it', { skip: needsChain() }, async (t) => {
    if (skipReason) return t.skip(skipReason)
    const ens = await import('../../app/src/lib/live/ens.ts')
    const cfg = await import('../../app/src/lib/live/config.ts')

    // Everything the sender needs comes off the directory, exactly as live.ts::send does it.
    // Nothing here is taken from the local BOB object except the assertion at the end.
    const peerPub = await ens.resolvePubkey('bob.lortnoctahc.eth')
    const peerSui = await ens.readText('bob.lortnoctahc.eth', cfg.REC.sui)
    assert.ok(peerPub && peerSui, 'bob.lortnoctahc.eth is not messageable')

    const key = deriveConvKey(ALICE.msg.priv, fromHex(peerPub), ALICE.msg.pub)
    const body = `by-name ${Date.now()}`
    const res = await sendWithRetry(
      null, key,
      { v: 1, from: 'alice.lortnoctahc.eth', to: 'bob.lortnoctahc.eth', ts: Date.now(), body },
      ALICE.signer, peerSui,
    )
    assert.match(res.headId, /^0x[0-9a-f]{64}$/)

    const bodies = await readUntil(res.headId, convKeyBetween(BOB, ALICE), BOB.signer, [body])
    assert.ok(bodies.includes(body), `Bob did not receive the by-name message: ${JSON.stringify(bodies)}`)
  })
})

// ---------------------------------------------------------------------------
// Inbox discovery — KNOWN BROKEN, tracked here so it cannot be forgotten
// ---------------------------------------------------------------------------
describe('the recipient can discover a conversation they did not start', () => {
  test('findHeads() locates the shared head by membership', { skip: needsChain() }, async (t) => {
    if (skipReason) return t.skip(skipReason)
    const { findHeads } = await import('../../app/src/lib/live/sui.ts')

    // This was BROKEN and is now fixed, which is why it asserts rather than tolerates.
    // findHeads used sui.queryEvents(); public Sui fullnodes now answer "Method not found. JSON-RPC
    // on public fullnodes has been deprecated" for every event query. It is the only way the app
    // finds a conversation somebody else started, so a peer who was messaged first saw an EMPTY
    // INBOX — exactly what findHeads exists to prevent. It now reads events over Sui GraphQL.
    //
    // Asserting BOB is the point: Alice has local state for threads she started, Bob has none.
    // Discovery is the only thing standing between him and an empty screen.
    const heads = await findHeads(BOB.address)
    assert.ok(Array.isArray(heads), 'findHeads must return a list, not throw')
    assert.ok(heads.length > 0, 'Bob discovered no conversations — inbox discovery is broken again')

    const mine = await findHeads(ALICE.address)
    assert.ok(mine.some((h) => heads.includes(h)), 'no head found that BOTH of them belong to')
  })
})
