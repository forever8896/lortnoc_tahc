#!/usr/bin/env node
// LIVE: an NFT-gated ENS space, read side, on real Sepolia (docs/PRD-universal.md §23). The chain half
// (buy → /space → records → moderator) is proven by research-tokyo/migration/live/space-e2e.mjs; this
// proves the half readers touch, with nothing faked:
//
//   buy a space on Sepolia LortnocSpaces → relayer POST /space mints <label>.space.lortnoctahc.eth
//   mint a LortnocDemoPass to a throwaway holder
//   lock a post to "NFT holders of @label" through the REAL gate (real ENS reads, real balanceOf)
//   holder opens it and becomes a member · a wallet without the pass is refused
//   the member gets a post countersigned
//   the OWNER bans that member by writing the ENS record — with the extension's own ensWrite.ts
//   the same holder is refused on the next post, and can no longer get a post countersigned
//
//   node gate/nft-live.mjs      (spends Sepolia ETH from the deployer key; prints no secret)
import { createGate } from './core.mjs'
import { createEnsSpaces } from './ens-spaces.mjs'
import { createHolders } from './holders.mjs'
import { gateDepositor, gateReleaser } from '../shared/gateclient.mjs'
import { sealMessage, openMessage } from '../shared/webframe.mjs'
import { genSigner, sign, MSG, contentHash } from '../shared/member.mjs'
import { encodeFunctionData, keccak256, stringToHex, createPublicClient, http, formatEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { clients, sendTx, readDeployment, ROOT } from '../scripts/ens/lib/ens.mjs'
import { writeBan } from '../extension-everywhere/src/shared/ensWrite.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const RELAYER = process.env.RELAYER ?? 'https://lortnoc-relayer.fly.dev'
const S = readDeployment().lortnoc.spaces
const SPACES = JSON.parse(readFileSync(join(ROOT, 'app/src/lib/live/spaces-deployment.json'), 'utf8')).sepolia.address
const RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
const pc = createPublicClient({ chain: sepolia, transport: http(RPC) })
const { publicClient: dpc, walletClient: deployer } = clients()

let failures = 0
const t0 = Date.now()
const check = (ok, m) => (console.log(`  ${ok ? '✓' : '✗'} ${m}`), ok || failures++)
const step = (m) => console.log(`\n[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)

const label = `nft-${Math.random().toString(36).slice(2, 8)}`
const space = `@${label}`
const token = `eip155:11155111/erc721:${S.demoPass.toLowerCase()}`
const ownerPriv = generatePrivateKey()
const owner = privateKeyToAccount(ownerPriv)
const holder = privateKeyToAccount(generatePrivateKey())
const stranger = privateKeyToAccount(generatePrivateKey())
console.log(`space ${label}.${S.branchName}\n  owner  ${owner.address}\n  holder ${holder.address}\n  token  ${token}`)

// 1. buy + relayer
step('buySpace on Sepolia, then relayer POST /space')
const buyAbi = [{ type: 'function', name: 'buySpace', stateMutability: 'payable', inputs: [{ type: 'string' }, { type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'price', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }]
const price = await dpc.readContract({ address: SPACES, abi: buyAbi, functionName: 'price' })
const rules = keccak256(stringToHex(`lortnoc/space/rules/v1|${token}`))
const buy = await sendTx(dpc, deployer, { to: SPACES, value: price, data: encodeFunctionData({ abi: buyAbi, functionName: 'buySpace', args: [label, owner.address, rules] }) }, 'buySpace')
console.log(`  paid ${formatEther(price)} ETH  ${buy.transactionHash}`)
let made
for (let i = 0; i < 20 && !made?.name; i++) {
  made = await fetch(`${RELAYER}/space`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chainId: 11155111, txHash: buy.transactionHash, label, token }) }).then((r) => r.json()).catch((e) => ({ error: String(e) }))
  if (!made?.name) await new Promise((r) => setTimeout(r, 6000))
}
check(!!made?.name, `relayer created ${made?.name ?? JSON.stringify(made)}`)
if (!made?.name) process.exit(1)

// 2. a pass for the holder
step('mint a LortnocDemoPass to the holder')
const passAbi = [{ type: 'function', name: 'mintTo', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }]
await sendTx(dpc, deployer, { to: S.demoPass, data: encodeFunctionData({ abi: passAbi, functionName: 'mintTo', args: [holder.address] }) }, 'mintTo')

// 3. the real gate, reading real ENS + real balances
step('gate over real ENS + real balanceOf')
const ensSpaces = createEnsSpaces({ rpc: RPC })
const holders = createHolders({ ensSpaces })
const gate = createGate({ ensSpaces, holders })
const sp = await ensSpaces.get(space)
check(sp.exists && sp.owner.toLowerCase() === owner.address.toLowerCase(), `ENS owner (findExactOwner) = buyer's owner key`)
check(sp.token === token, `ENS token record = ${sp.token}`)

const post = async (path, body) => {
  try {
    return path === '/deposit' ? gate.deposit(body) : path === '/challenge' ? await gate.challenge(body) : await gate.release(body)
  } catch (e) {
    return { error: e.message }
  }
}
const deposit = gateDepositor({ gatePub: gate.pub, post })
const lock = (text) => sealMessage(text, { check: 'nft', space }, { deposit })
const memberKey = genSigner()
const reader = (account) => {
  const log = { member: null, denials: [] }
  const release = gateReleaser({
    post,
    extraFor: () => ({ memberPub: memberKey.pub }),
    onRelease: (r) => (log.member = r.member ?? log.member),
    onDeny: (d) => log.denials.push(d.deny),
    proofFor: async ({ check: c, ref, readerPub, policyHash }) => {
      if (c !== 'nft') return undefined
      const ch = await post('/challenge', { ref, readerPub, policyHash })
      if (!ch.request) throw new Error(ch.deny ?? 'no challenge')
      return { nonce: ch.request.nonce, address: account.address, sig: await account.signMessage({ message: ch.request.message }) }
    },
  })
  return { log, open: (f) => openMessage(f, { release }) }
}

step('readers')
const first = await lock('holders only: meet at the usual place')
const h = reader(holder)
check((await h.open(first)) === 'holders only: meet at the usual place', 'the holder opens the post')
const memberId = h.log.member?.memberId
check(/^member-[0-9a-f]{12}$/.test(memberId ?? ''), `the holder is now ${memberId}`)
const s = reader(stranger)
check((await s.open(first)) === null, `a wallet without the pass is refused (${s.log.denials.at(-1)})`)

const attest = (text) => {
  const hash = contentHash(text)
  return gate.spaces.attest({ space, memberId, contentHash: hash, sig: sign(memberKey.priv, MSG.authorRequest(space, memberId, hash)) })
}
check(!!(await attest('signed before the ban')).sig, 'the member gets a post countersigned')

// 4. the owner bans through ENS, with the extension's code
step('owner writes the ban to ENS (extension ensWrite.ts)')
const ownerBal = await pc.getBalance({ address: owner.address })
check(ownerBal > 0n, `owner has ${formatEther(ownerBal)} ETH from the relayer's stipend`)
const banTx = await writeBan(label, memberId, ownerPriv)
console.log(`  ${banTx}`)
ensSpaces.forget(space) // the gate caches for 20 s; skip the wait
check((await ensSpaces.get(space)).bans.has(memberId), `ENS eth.lortnoc.space.bans contains ${memberId}`)

step('after the ban')
const second = await lock('after the ban')
const again = reader(holder)
check((await again.open(second)) === null, `the same holder is refused (${again.log.denials.at(-1)})`)
check(/banned/.test((await attest('signed after the ban')).deny ?? ''), 'and can no longer get posts countersigned')

console.log(failures ? `\n✗ ${failures} check(s) failed` : `\n✓ all checks passed — ${made.name}`)
process.exit(failures ? 1 : 0)
