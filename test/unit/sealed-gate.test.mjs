// Sealed posts through the REAL gate (core + keyring + check modules): connect once, then every post
// the reader qualifies for opens — and nothing else does. World's network verdicts and the chain are
// faked (test/lib/world-fake.mjs, nft-fake.mjs); the gate's own decisions are real.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createGate } from '../../gate/core.mjs'
import { gateSealer, unlockRefs } from '../../shared/gateclient.mjs'
import { sealPost, openPost, sealedRef } from '../../shared/sealed.mjs'
import { genKeyPair, toHex } from '../../shared/keys.mjs'
import { genSigner } from '../../shared/member.mjs'
import { fakeWorld, proofFrom } from '../lib/world-fake.mjs'
import { fakeChain, wallet, COLLECTION } from '../lib/nft-fake.mjs'

function setup() {
  const chain = fakeChain()
  chain.ens.set('club.space.lortnoctahc.eth', { owner: '0x' + '11'.repeat(20), token: COLLECTION, bans: '' })
  const gate = createGate({ world: fakeWorld(), ensSpaces: chain.ensSpaces, holders: chain.holders })
  const post = async (path, body) => {
    try {
      if (path === '/seal') return gate.seal(body)
      if (path === '/unlock') return await gate.unlock(body)
    } catch (e) {
      return { error: e.message }
    }
  }
  const seal = (text, policy) => sealPost(text, policy, { gateSeal: gateSealer({ gatePub: gate.pub, post }) })
  const reader = () => {
    const key = toHex(genKeyPair().pub) // the keyring's key
    const member = genSigner()
    const r = { token: undefined, key, member }
    r.connectWorld = async (kind, country) => {
      const c = gate.keyring.worldChallenge({ kind, country, readerPub: key })
      const v = await gate.keyring.worldConnect({ sid: c.sid, readerPub: key, proof: proofFrom(c.request), token: r.token })
      if (v.token) r.token = v.token
      return v
    }
    r.connectWallet = async (account) => {
      const c = gate.keyring.walletChallenge({ readerPub: key })
      const v = await gate.keyring.walletConnect({ nonce: c.nonce, address: account.address, sig: await account.signMessage({ message: c.message }), token: r.token })
      if (v.token) r.token = v.token
      return v
    }
    /** What this reader sees of a page of posts: the texts that opened (others: nothing). */
    r.read = async (frames) => {
      const got = await unlockRefs({ post, token: r.token, refs: frames.map(sealedRef), memberPub: r.member.pub })
      const out = []
      for (const f of frames) {
        const u = got.get(toHex(sealedRef(f)))
        const o = await openPost(f, { gateShares: u?.shares ?? [] })
        if (o) out.push({ text: o.text, members: u?.members ?? [] })
      }
      return out
    }
    return r
  }
  return { gate, chain, seal, reader }
}

describe('sealed + gate — connect once, then see what you may', () => {
  test('a time capsule appears only once its time has come — no keyring needed', async () => {
    const s = setup()
    const past = await s.seal('opened', { check: 'after', after: Date.now() - 1000 })
    const future = await s.seal('not yet', { check: 'after', after: Date.now() + 3600_000 })
    assert.deepEqual((await s.reader().read([past, future])).map((x) => x.text), ['opened'])
  })
  test('verified humans: nothing until World ID is connected, then every such post', async () => {
    const s = setup()
    const posts = [await s.seal('h1', { check: 'human' }), await s.seal('h2', { check: 'human' })]
    const r = s.reader()
    assert.deepEqual(await r.read(posts), [])
    assert.ok((await r.connectWorld('poh')).token)
    assert.deepEqual((await r.read(posts)).map((x) => x.text), ['h1', 'h2'])
  })
  test('nationality: a Danish passport opens Danish posts, not Ukrainian ones', async () => {
    const s = setup()
    const dk = await s.seal('for danes', { check: 'human', preset: 'identity', country: 'DNK' })
    const ua = await s.seal('for ukrainians', { check: 'human', preset: 'identity', country: 'UKR' })
    const r = s.reader()
    const v = await r.connectWorld('nationality', 'DNK')
    assert.deepEqual(v.claims.nationalities, ['DNK'])
    assert.deepEqual((await r.read([dk, ua])).map((x) => x.text), ['for danes'])
  })
  test('a selfie credential does not satisfy a proof-of-human post', async () => {
    const s = setup()
    const p = await s.seal('orb only', { check: 'human' })
    const r = s.reader()
    await r.connectWorld('selfie')
    assert.deepEqual(await r.read([p]), [])
  })
  test('NFT holders: a connected wallet that holds the collection opens it and joins the space', async () => {
    const s = setup()
    const p = await s.seal('holders', { check: 'nft', space: '@club' })
    const holder = wallet()
    s.chain.balances.set(holder.address.toLowerCase(), 1n)
    const r = s.reader()
    assert.deepEqual(await r.read([p]), [])
    assert.deepEqual((await r.connectWallet(holder)).claims.wallets, [holder.address.toLowerCase()])
    const [o] = await r.read([p])
    assert.equal(o.text, 'holders')
    assert.match(o.members[0].memberId, /^member-/)
    const other = s.reader()
    await other.connectWallet(wallet())
    assert.deepEqual(await other.read([p]), [])
  })
  test('the ENS ban list shuts a holder out of sealed posts too', async () => {
    const s = setup()
    const p = await s.seal('holders', { check: 'nft', space: '@club' })
    const holder = wallet()
    s.chain.balances.set(holder.address.toLowerCase(), 1n)
    const r = s.reader()
    await r.connectWallet(holder)
    const [o] = await r.read([p])
    s.chain.ens.set('club.space.lortnoctahc.eth', { owner: '0x' + '11'.repeat(20), token: COLLECTION, bans: o.members[0].memberId })
    s.chain.ensSpaces.forget('@club')
    assert.deepEqual(await r.read([await s.seal('after the ban', { check: 'nft', space: '@club' })]), [])
  })
  test('AND across the gate and a passphrase: the gate alone cannot open it', async () => {
    const s = setup()
    const p = await s.seal('both', { and: [{ check: 'passphrase', passphrase: 'river copper lantern moss eleven' }, { check: 'human' }] })
    const r = s.reader()
    await r.connectWorld('poh')
    assert.deepEqual(await r.read([p]), []) // gate share alone: not enough
  })
  test('a wallet signature is single-use and must be from that wallet', async () => {
    const s = setup()
    const key = toHex(genKeyPair().pub)
    const a = wallet()
    const c = s.gate.keyring.walletChallenge({ readerPub: key })
    const forged = await wallet().signMessage({ message: c.message })
    assert.match((await s.gate.keyring.walletConnect({ nonce: c.nonce, address: a.address, sig: forged })).deny, /not from that wallet/)
    assert.match((await s.gate.keyring.walletConnect({ nonce: c.nonce, address: a.address, sig: await a.signMessage({ message: c.message }) })).deny, /already used/)
  })
  test('a World ID proof made for another keyring key is refused', async () => {
    const s = setup()
    const c = s.gate.keyring.worldChallenge({ kind: 'poh', readerPub: 'aa'.repeat(32) })
    assert.match((await s.gate.keyring.worldConnect({ sid: c.sid, readerPub: 'bb'.repeat(32), proof: proofFrom(c.request) })).deny, /another key/)
  })
  test('random refs (ordinary text on a page) are simply not answered', async () => {
    const s = setup()
    const got = await s.gate.unlock({ readerPub: 'cc'.repeat(32), refs: ['00'.repeat(8), '11'.repeat(8)] })
    assert.deepEqual(got.results, [])
  })
})
