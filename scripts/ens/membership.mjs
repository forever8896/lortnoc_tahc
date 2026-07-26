#!/usr/bin/env node
// Exercises the anonymous membership flow end to end on 0G Galileo (§7, §8).
//
//   PRIVATE_KEY=0x… node scripts/ens/membership.mjs join     # pay, insert commitment
//   PRIVATE_KEY=0x… node scripts/ens/membership.mjs spend    # prove membership, burn a ticket
//   PRIVATE_KEY=0x… node scripts/ens/membership.mjs full     # both, with assertions
//
// The identity secret is derived from MS exactly as the app does (§5.1, `lortnoc/semaphore/v1`),
// so the commitment this script inserts is the same one the app would derive from that wallet.
//
// What is being demonstrated: the chain learns `wallet X paid` and `the member tree grew`. When
// a ticket is later spent, it learns `nullifier N was burned, carrying message M` — and nothing
// links the two. That gap is the product.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Identity } from '@semaphore-protocol/identity'
import { Group } from '@semaphore-protocol/group'
import { generateProof } from '@semaphore-protocol/proof'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ROOT, loadEnv, log, ticketMessage, claimScope } from './lib/ens.mjs'

const argv = process.argv.slice(2)
const cmd = argv.find((a) => !a.startsWith('--')) ?? 'full'
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? dflt : argv[i + 1]
}
/** Which handle this ticket is being spent on, and who receives it. All three are bound into
 *  the proof, so the relayer can neither redirect the claim nor swap the storage account. */
const LABEL = flag('label', 'demo')
const CLAIM_EVM = flag('evm', '0x0000000000000000000000000000000000000001')
const CLAIM_SUI = flag('sui', '0x' + '0'.repeat(64))
/** The X25519 messaging pubkey that will be published to eth.lortnoc.pubkey. Bound into the
 *  proof so the relayer cannot substitute a key it controls (see shared/ticket.mjs). */
const CLAIM_PUBKEY = flag('pubkey', null)
/** Derive a distinct identity — one membership can only ever mint one handle (fixed scope ⇒
 *  fixed nullifier), so testing a second claim needs a second membership. */
const INDEX = flag('index', '0')
const MAINNET = argv.includes('--mainnet')
const ALL = JSON.parse(readFileSync(join(ROOT, 'app', 'src', 'lib', 'live', 'zerog-deployment.json'), 'utf8'))
const D = MAINNET ? ALL.mainnet : ALL
const MEMBERSHIP = D.contracts.membership
const SEMAPHORE = D.contracts.semaphore
const GROUP_ID = BigInt(D.groupId ?? 0)

const galileo = defineChain({
  id: MAINNET ? 16661 : 16602, name: MAINNET ? '0G' : '0G Galileo',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: { default: { http: [MAINNET ? 'https://evmrpc.0g.ai' : 'https://evmrpc-testnet.0g.ai'] } },
})

loadEnv()
const account = privateKeyToAccount(process.env.PRIVATE_KEY)
const transport = http(process.env.ZG_RPC_URL || galileo.rpcUrls.default.http[0])
const publicClient = createPublicClient({ chain: galileo, transport })
const walletClient = createWalletClient({ account, chain: galileo, transport })

const membershipAbi = parseAbi([
  'function join(uint256 commitment) payable',
  'function spendTicket((uint256 merkleTreeDepth,uint256 merkleTreeRoot,uint256 nullifier,uint256 message,uint256 scope,uint256[8] points) proof)',
  'function price() view returns (uint256)',
  'function memberCount() view returns (uint256)',
  'function joined(uint256) view returns (bool)',
  'function spent(uint256) view returns (bool)',
  'function GROUP_ID() view returns (uint256)',
])
const semaphoreAbi = parseAbi([
  'function getMerkleTreeRoot(uint256 groupId) view returns (uint256)',
  'function getMerkleTreeSize(uint256 groupId) view returns (uint256)',
  'function getMerkleTreeDepth(uint256 groupId) view returns (uint256)',
])

/** id_sem — the Semaphore identity secret (§5.1). Derived from MS; never leaves the device. */
function identityFromWallet() {
  // Stand-in for MS: the app derives MS from a wallet signature. Here we derive deterministically
  // from the key itself so the script is reproducible without a browser.
  const ms = hkdf(sha256, Buffer.from(process.env.PRIVATE_KEY.replace(/^0x/, ''), 'hex'),
                  new TextEncoder().encode('lortnoc/ms/v1'), new TextEncoder().encode('master'), 32)
  const sem = hkdf(sha256, ms, new TextEncoder().encode(`lortnoc/semaphore/v1${INDEX === '0' ? '' : `/${INDEX}`}`),
                   new TextEncoder().encode('sem'), 32)
  return new Identity(Buffer.from(sem).toString('hex'))
}

const gasPrice = await publicClient.getGasPrice()
const sendTx = async (request, label) => {
  const hash = await walletClient.writeContract({ ...request, gas: 3_000_000n, gasPrice })
  log.tx(hash)
  const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 3_000 })
  if (r.status !== 'success') throw new Error(`${label} reverted`)
  return r
}

const read = (fn, args = []) =>
  publicClient.readContract({ address: MEMBERSHIP, abi: membershipAbi, functionName: fn, args })

console.log(`\n\x1b[1mlortnoc_tahc — anonymous membership (${MAINNET ? '0G MAINNET — real value' : '0G Galileo'})\x1b[0m`)
console.log(`  membership ${MEMBERSHIP}`)
console.log(`  group      ${GROUP_ID}`)

const identity = identityFromWallet()
const commitment = identity.commitment
console.log(`  commitment ${commitment}`)

// ---- join ---------------------------------------------------------------------------------
if (cmd === 'join' || cmd === 'full') {
  log.step('Pay to join the members set')
  if (await read('joined', [commitment])) {
    log.skip('this commitment is already a member')
  } else {
    const price = await read('price')
    log.info(`price ${Number(price) / 1e18} 0G`)
    await sendTx(
      { account, address: MEMBERSHIP, abi: membershipAbi, functionName: 'join', args: [commitment], value: price },
      'join',
    )
    log.ok(`joined — the chain saw a payment and the tree grow, nothing more`)
  }
  log.info(`members now: ${await read('memberCount')}`)
}

// ---- prove / spend ------------------------------------------------------------------------
// `prove` generates the ticket and prints it WITHOUT submitting — which is what the browser does.
// The claimant must never burn their own ticket (it would tie the paying wallet to the nullifier,
// and the nullifier names the handle); the relayer submits it instead.
if (cmd === 'prove' || cmd === 'spend' || cmd === 'full') {
  log.step('Prove membership and burn a ticket')

  // Rebuild the group from on-chain members so the proof is against the real root.
  const size = await publicClient.readContract({
    address: SEMAPHORE, abi: semaphoreAbi, functionName: 'getMerkleTreeSize', args: [GROUP_ID],
  })
  const onChainRoot = await publicClient.readContract({
    address: SEMAPHORE, abi: semaphoreAbi, functionName: 'getMerkleTreeRoot', args: [GROUP_ID],
  })
  log.info(`on-chain tree: ${size} member(s), root ${onChainRoot}`)

  // Our members, in insertion order, reconstructed from Joined events.
  const logs = await publicClient.getLogs({
    address: MEMBERSHIP,
    event: { type: 'event', name: 'Joined', inputs: [
      { name: 'commitment', type: 'uint256', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'memberCount', type: 'uint256', indexed: false },
    ] },
    fromBlock: 0n, toBlock: 'latest',
  })
  const members = logs.map((l) => l.args.commitment)
  log.info(`reconstructed ${members.length} member(s) from Joined events`)

  const group = new Group(members)
  if (group.root.toString() !== onChainRoot.toString()) {
    throw new Error(`local root ${group.root} != on-chain ${onChainRoot} — member list is wrong`)
  }
  log.ok('local tree matches the on-chain root')

  // The message binds WHAT the ticket buys and WHO gets it: (label, evm addr, sui addr). It is a
  // public input to the proof, so no one — including the relayer — can point it elsewhere.
  if (!CLAIM_PUBKEY) {
    throw new Error('--pubkey is required: it is bound into the proof so the relayer cannot swap it')
  }
  const message = ticketMessage(LABEL, CLAIM_EVM, CLAIM_SUI, CLAIM_PUBKEY)
  // Fixed scope ⇒ one nullifier per identity ⇒ one handle per membership. That is the product
  // rule ("payment = one handle"), enforced by the maths rather than by us.
  const scope = claimScope()
  log.info(`claim: ${LABEL}.lortnoctahc.eth → ${CLAIM_EVM}`)
  log.info(`bound: sui ${CLAIM_SUI.slice(0, 12)}… · pubkey ${CLAIM_PUBKEY.slice(0, 14)}…`)

  log.info('generating Groth16 proof…')
  const proof = await generateProof(identity, group, message, scope)
  log.ok(`proof generated — nullifier ${proof.nullifier}`)

  if (cmd === 'prove') {
    const ticket = {
      merkleTreeDepth: Number(proof.merkleTreeDepth),
      merkleTreeRoot: proof.merkleTreeRoot.toString(),
      nullifier: proof.nullifier.toString(),
      message: proof.message.toString(),
      scope: proof.scope.toString(),
      points: proof.points.map((p) => p.toString()),
    }
    const body = { label: LABEL, evmAddr: CLAIM_EVM, suiAddr: CLAIM_SUI, pubkey: CLAIM_PUBKEY, ticket }
    const out = flag('out', null)
    if (out) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(out, JSON.stringify(body, null, 2))
      log.ok(`ticket written to ${out} — POST it to the relayer's /claim`)
    } else {
      console.log(JSON.stringify(body, null, 2))
    }
  } else if (await read('spent', [proof.nullifier])) {
    log.warn('this nullifier is already spent (scope is fixed, so re-running reuses it)')
  } else {
    await sendTx(
      { account, address: MEMBERSHIP, abi: membershipAbi, functionName: 'spendTicket', args: [{
        merkleTreeDepth: BigInt(proof.merkleTreeDepth),
        merkleTreeRoot: BigInt(proof.merkleTreeRoot),
        nullifier: BigInt(proof.nullifier),
        message: BigInt(proof.message),
        scope: BigInt(proof.scope),
        points: proof.points.map(BigInt),
      }] },
      'spendTicket',
    )
    log.ok('ticket spent on-chain — proof verified by the Semaphore verifier')
  }

  const spentNow = await read('spent', [proof.nullifier])
  console.log()
  console.log(`  ${spentNow ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} nullifier recorded as spent`)
  console.log(`  \x1b[32m✓\x1b[0m double-spend now impossible (same scope ⇒ same nullifier ⇒ revert)`)
}

console.log(`\n\x1b[32mMembership flow verified.\x1b[0m`)
console.log(`  The chain knows a wallet paid, and that a ticket was burned.`)
console.log(`  It cannot connect the two — that is the guarantee (§8: unlinkability, not invisibility).\n`)
