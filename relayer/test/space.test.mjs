// relayer POST /space (docs/PRD-universal.md §23.2) — the decision logic in relayer/space.mjs,
// driven with fake chain clients. No network, no key.
//   node --test relayer/test/        (or: node test/run.mjs relayer)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, encodeEventTopics, keccak256, stringToHex } from 'viem'
import {
  createSpaceHandler, validateSpaceRequest, findPurchase, rulesHashOf, SPACE_BOUGHT, CONFIRMATIONS,
} from '../space.mjs'

const SPACES = { 1: '0x87997f3ca40693fb1e0c3c6f39f0f3fe287b8c67', 11155111: '0xe0ef82657f1ca25c72b69e459a52635281b37592' }
const OWNER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const PAYER = '0x3333333333333333333333333333333333333333'
const ZERO = '0x0000000000000000000000000000000000000000'
const TOKEN = 'eip155:11155111/erc721:0xc85460a6690f8b06fdafd1b7730bdfa6261243f0'
const TX = `0x${'ab'.repeat(32)}`

function spaceLog({ address = SPACES[11155111], id = 1n, label = 'lentil-club', owner = OWNER, rulesHash = rulesHashOf(TOKEN) } = {}) {
  return {
    address,
    topics: encodeEventTopics({ abi: [SPACE_BOUGHT], eventName: 'SpaceBought', args: { id, spaceOwner: owner, payer: PAYER } }),
    data: encodeAbiParameters([{ type: 'string' }, { type: 'bytes32' }, { type: 'uint256' }], [label, rulesHash, 5_000_000_000_000_000n]),
  }
}

function receipt({ logs = [spaceLog()], status = 'success', blockNumber = 100n, blockHash = '0xb1' } = {}) {
  return { status, blockNumber, blockHash, logs }
}

/** A world where every dependency is scripted and every call is recorded. */
function world({ chainId = 11155111, rcpt = receipt(), head = 100n, holder = ZERO, mainnetTaken = false, claimFails = false, stipendFails = false, receipts } = {}) {
  const calls = { claim: [], stipend: [], reads: 0 }
  let headNow = head
  const reader = {
    async getTransactionReceipt() {
      calls.reads++
      if (receipts) return receipts.shift()
      if (!rcpt) throw new Error('TransactionReceiptNotFoundError')
      return rcpt
    },
    async getBlockNumber() {
      return headNow
    },
  }
  let owner = holder
  const handler = createSpaceHandler({
    readers: { [chainId]: reader },
    spaces: SPACES,
    branchName: 'space.lortnoctahc.eth',
    spaceOwnerOf: async () => owner,
    claimSpace: async (label, o, token) => {
      calls.claim.push({ label, owner: o, token })
      if (claimFails) throw new Error('claimSpaceFor reverted')
      owner = o
      return '0xclaim'
    },
    payStipend: async (o) => {
      calls.stipend.push(o)
      if (stipendFails) throw new Error('no gas')
      return '0xstipend'
    },
    mainnetTaken: async () => {
      if (mainnetTaken === 'error') throw new Error('rpc down')
      return mainnetTaken
    },
    confirmTimeoutMs: 30,
    pollMs: 5,
  })
  return { handler, calls, setHead: (h) => (headNow = h) }
}

const body = (over = {}) => ({ chainId: 11155111, txHash: TX, label: 'lentil-club', token: TOKEN, ...over })

// ---- the rules hash is the contract with the extension ------------------------------------------

test('rulesHash is keccak256(utf8("lortnoc/space/rules/v1|" + token))', () => {
  assert.equal(rulesHashOf(TOKEN), keccak256(stringToHex(`lortnoc/space/rules/v1|${TOKEN}`)))
  assert.equal(rulesHashOf(''), keccak256(stringToHex('lortnoc/space/rules/v1|')))
})

test('confirmations: 3 on mainnet, 1 on Sepolia', () => {
  assert.equal(CONFIRMATIONS[1], 3)
  assert.equal(CONFIRMATIONS[11155111], 1)
})

// ---- happy path ---------------------------------------------------------------------------------

test('a Sepolia purchase issues the space to the EVENT owner and pays the stipend', async () => {
  const { handler, calls } = world()
  const r = await handler(body())
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body, {
    name: 'lentil-club.space.lortnoctahc.eth', owner: OWNER, token: TOKEN, claimTx: '0xclaim',
    stipendTx: '0xstipend', chainId: 11155111, purchaseId: '1',
  })
  assert.deepEqual(calls.claim, [{ label: 'lentil-club', owner: OWNER, token: TOKEN }])
  assert.deepEqual(calls.stipend, [OWNER])
})

test('an empty token (no gate) works when the purchase committed to it', async () => {
  const { handler } = world({ rcpt: receipt({ logs: [spaceLog({ rulesHash: rulesHashOf('') })] }) })
  const r = await handler(body({ token: '' }))
  assert.equal(r.status, 200)
  assert.equal(r.body.token, '')
})

test('a mainnet purchase waits for 3 confirmations and re-checks the block', async () => {
  const w = world({ chainId: 1, rcpt: receipt({ logs: [spaceLog({ address: SPACES[1] })] }), head: 102n })
  const r = await w.handler(body({ chainId: 1 }))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(w.calls.reads, 2, 'receipt re-read after confirmations')
})

// ---- idempotency --------------------------------------------------------------------------------

test('retrying after success is success, and never claims twice', async () => {
  const { handler, calls } = world()
  assert.equal((await handler(body())).status, 200)
  const again = await handler(body())
  assert.equal(again.status, 200)
  assert.equal(again.body.claimTx, null)
  assert.equal(calls.claim.length, 1)
})

test('a space already held by the buyer is success without a claim', async () => {
  const { handler, calls } = world({ holder: OWNER.toUpperCase().replace('0X', '0x') })
  const r = await handler(body())
  assert.equal(r.status, 200)
  assert.equal(r.body.claimTx, null)
  assert.equal(calls.claim.length, 0)
})

test('a space held by someone else is refused (409), never reported as success', async () => {
  const { handler, calls } = world({ holder: OTHER })
  const r = await handler(body())
  assert.equal(r.status, 409)
  assert.equal(r.body.holder, OTHER)
  assert.equal(calls.claim.length, 0)
  assert.equal(calls.stipend.length, 0)
})

test('concurrent requests for one label: the second gets 409 while the first is in flight', async () => {
  const { handler } = world()
  const [a, b] = await Promise.all([handler(body()), handler(body())])
  assert.deepEqual([a.status, b.status].sort(), [200, 409])
})

// ---- the purchase must be real, from the right contract, with the right rules --------------------

test('a SpaceBought from any OTHER contract is ignored', async () => {
  const { handler, calls } = world({ rcpt: receipt({ logs: [spaceLog({ address: OTHER })] }) })
  const r = await handler(body())
  assert.equal(r.status, 400)
  assert.match(r.body.error, /no SpaceBought/)
  assert.equal(calls.claim.length, 0)
})

test('the mainnet contract address does not count for a Sepolia chainId (and vice versa)', async () => {
  const w1 = world({ rcpt: receipt({ logs: [spaceLog({ address: SPACES[1] })] }) })
  assert.equal((await w1.handler(body())).status, 400)
  const w2 = world({ chainId: 1, head: 200n, rcpt: receipt({ logs: [spaceLog({ address: SPACES[11155111] })] }) })
  assert.equal((await w2.handler(body({ chainId: 1 }))).status, 400)
})

test('a purchase of a DIFFERENT label in the same tx does not count', async () => {
  const { handler, calls } = world({ rcpt: receipt({ logs: [spaceLog({ label: 'other-club' })] }) })
  assert.equal((await handler(body())).status, 400)
  assert.equal(calls.claim.length, 0)
})

test('the right label is picked out of a tx that bought several', async () => {
  const { handler, calls } = world({
    rcpt: receipt({ logs: [spaceLog({ label: 'other-club', owner: OTHER }), spaceLog({ id: 2n })] }),
  })
  const r = await handler(body())
  assert.equal(r.status, 200)
  assert.equal(r.body.purchaseId, '2')
  assert.equal(calls.claim[0].owner, OWNER)
})

test('a token that does not hash to the committed rulesHash is refused', async () => {
  const { handler, calls } = world()
  const r = await handler(body({ token: 'eip155:1/erc721:0x0000000000000000000000000000000000000bad' }))
  assert.equal(r.status, 400)
  assert.match(r.body.error, /rulesHash/)
  assert.equal(calls.claim.length, 0)
})

test('the token check is case-exact: rules are bytes, not addresses', async () => {
  const { handler } = world()
  const r = await handler(body({ token: TOKEN.replace('0xc854', '0xC854') }))
  assert.equal(r.status, 400)
})

test('a reverted purchase tx is refused', async () => {
  const { handler } = world({ rcpt: receipt({ status: 'reverted' }) })
  assert.equal((await handler(body())).status, 400)
})

test('an unknown tx is 404', async () => {
  const { handler } = world({ rcpt: null })
  assert.equal((await handler(body())).status, 404)
})

// ---- confirmations & reorgs ---------------------------------------------------------------------

test('mainnet with too few confirmations answers 425 (retry) and claims nothing', async () => {
  const w = world({ chainId: 1, rcpt: receipt({ logs: [spaceLog({ address: SPACES[1] })] }), head: 101n })
  const r = await w.handler(body({ chainId: 1 }))
  assert.equal(r.status, 425)
  assert.equal(r.body.confirmations, 2)
  assert.equal(r.body.required, 3)
  assert.equal(w.calls.claim.length, 0)
})

test('a purchase reorged out while waiting is refused', async () => {
  const first = receipt({ logs: [spaceLog({ address: SPACES[1] })], blockHash: '0xaaa' })
  const second = { ...first, blockHash: '0xbbb' }
  const w = world({ chainId: 1, receipts: [first, second], head: 110n })
  const r = await w.handler(body({ chainId: 1 }))
  assert.equal(r.status, 409)
  assert.match(r.body.error, /reorganised/)
  assert.equal(w.calls.claim.length, 0)
})

// ---- the Sepolia demo path must not squat mainnet names -----------------------------------------

test('a Sepolia purchase of a label already bought on mainnet is refused', async () => {
  const { handler, calls } = world({ mainnetTaken: true })
  const r = await handler(body())
  assert.equal(r.status, 409)
  assert.equal(calls.claim.length, 0)
})

test('if the mainnet check cannot run, the Sepolia path fails closed (503)', async () => {
  const { handler, calls } = world({ mainnetTaken: 'error' })
  assert.equal((await handler(body())).status, 503)
  assert.equal(calls.claim.length, 0)
})

// ---- failures after the point of no return ------------------------------------------------------

test('a failed stipend does not turn a created space into an error', async () => {
  const { handler } = world({ stipendFails: true })
  const r = await handler(body())
  assert.equal(r.status, 200)
  assert.equal(r.body.stipendTx, null)
})

test('a failed claimSpaceFor is a 500 and releases the in-flight lock', async () => {
  const w = world({ claimFails: true })
  assert.equal((await w.handler(body())).status, 500)
  assert.equal((await w.handler(body())).status, 500, 'not 409: the lock was released')
})

// ---- input validation ---------------------------------------------------------------------------

test('input validation', () => {
  const bad = [
    [{ chainId: 5 }, /chainId/],
    [{ chainId: '1' }, /chainId/],
    [{ txHash: '0x1234' }, /txHash/],
    [{ txHash: undefined }, /txHash/],
    [{ label: 'ab' }, /label/],
    [{ label: '-abc' }, /label/],
    [{ label: 'abc-' }, /label/],
    [{ label: 'ABC' }, /label/],
    [{ label: 'a'.repeat(33) }, /label/],
    [{ token: undefined }, /token/],
    [{ token: 'eip155:1/erc1155:0x0000000000000000000000000000000000000001' }, /token/],
    [{ token: 'eip155:01/erc721:0x0000000000000000000000000000000000000001' }, /token/],
    [{ token: 'eip155:1/erc721:0x01' }, /token/],
    [{ token: `${TOKEN} ` }, /token/],
  ]
  for (const [over, re] of bad) {
    const v = validateSpaceRequest(body(over))
    assert.equal(v.ok, false, JSON.stringify(over))
    assert.match(v.error, re)
  }
  assert.equal(validateSpaceRequest(null).ok, false)
  assert.equal(validateSpaceRequest(body()).ok, true)
  assert.equal(validateSpaceRequest(body({ txHash: TX.toUpperCase().replace('0X', '0x') })).req.txHash, TX)
})

test('findPurchase skips undecodable logs from the right address', () => {
  const junk = { address: SPACES[11155111], topics: ['0x' + '00'.repeat(32)], data: '0x' }
  const p = findPurchase(receipt({ logs: [junk, spaceLog()] }), SPACES[11155111], 'lentil-club')
  assert.equal(p.owner, OWNER)
  assert.equal(p.id, 1n)
})
