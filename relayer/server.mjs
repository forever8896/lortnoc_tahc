#!/usr/bin/env node
// lortnoc relayer — carries a burned membership ticket from 0G to a handle on Sepolia and a
// storage stipend on Sui (§8 Layer 1: payer ≠ claimer).
//
// It exists because no chain can read another's state. What that costs, stated plainly:
//
//   CANNOT forge a claim      — no burned ticket, nothing to relay.
//   CANNOT redirect a claim   — the proof's `message` binds (label, evm, sui, pubkey); change any
//                               one and the proof stops matching.
//   CANNOT read your messages — the pubkey is bound too, and the app re-checks it after claiming.
//   CAN censor or stall       — accepted. `spendTicket` is permissionless and the registrar's
//                               relayer set is a list, so anyone can run one of these.
//   Does NOT learn which payment funded a ticket — nobody does.
//
// The user never sends a transaction on Sepolia, and never burns their own ticket: if the paying
// wallet submitted `spendTicket` itself, an observer would see "X paid" and "X burned nullifier N"
// and the anonymity set would collapse to one, however large the crowd.
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import {
  createPublicClient, createWalletClient, defineChain, http, parseAbi, formatEther, getAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { SuiClient } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography'
import { ticketMessage } from '../shared/ticket.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'))

const ZG = readJson('app/src/lib/live/zerog-deployment.json').mainnet
const ENS_D = readJson('app/src/lib/live/ens-deployment.json')
const MEMBERSHIP = ZG.contracts.membership
const SEMAPHORE = ZG.contracts.semaphore
const GROUP_ID = BigInt(ZG.groupId ?? 0)
const REGISTRAR = ENS_D.lortnoc.registrar
const PARENT = ENS_D.lortnoc.parentName

const PORT = Number(process.env.PORT || 8080)
const SUI_RPC = process.env.SUI_RPC || 'https://sui-testnet-rpc.publicnode.com'
const SEPOLIA_RPC = process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com'
const WAL_TYPE = '0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL'
const SUI_STIPEND = BigInt(process.env.SUI_STIPEND ?? 50_000_000)
const WAL_STIPEND = BigInt(process.env.WAL_STIPEND ?? 50_000_000)
// The handle owner is a key derived from MS, so it arrives with nothing. It needs no gas to
// RECEIVE the handle — we pay for that — but it does need a little to manage its own records
// (delegate the inbox, revoke it, publish a pointer). Testnet ETH, fractions of a cent.
const ETH_STIPEND = BigInt(process.env.ETH_STIPEND ?? 2_000_000_000_000_000n) // 0.002 ETH

// Codec unlock: the SAME membership that buys the handle unlocks unlimited codec use — no second
// payment (that would be double-charging, since paying IS the 0G join). Having verified and burned
// the ticket on-chain, we already know this is a paid member, so we mint the codec's bearer token
// here, carrying the NULLIFIER (never the handle or payer, §8). Shared secret with the codec
// (CODEC_SECRET); if unset, we simply return no token and the codec stays free-tier.
const CODEC_SECRET = process.env.CODEC_SECRET || ''
const CODEC_TOKEN_TTL = Number(process.env.CODEC_TOKEN_TTL ?? 60 * 60 * 24 * 90) // 90 days

/** Mint a codec membership token — byte-compatible with codec/auth.py verify_membership:
 *  base64url(json).base64url(hmac-sha256(secret, body)), unpadded. */
function mintCodecToken(nullifier) {
  if (!CODEC_SECRET) return null
  const payload = { v: 1, nul: String(nullifier), exp: Math.floor(Date.now() / 1000) + CODEC_TOKEN_TTL }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', CODEC_SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

const zeroG = defineChain({
  id: 16661, name: '0G',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ZG_RPC || 'https://evmrpc.0g.ai'] } },
})

// ---- keys ---------------------------------------------------------------------------------
// Both are hot. Keep them thinly funded: a compromise costs gas, never user funds — this service
// cannot forge claims, cannot move membership fees, and cannot touch the member set.
const relayerKey = process.env.RELAYER_PRIVATE_KEY
if (!relayerKey) throw new Error('RELAYER_PRIVATE_KEY not set')
const account = privateKeyToAccount(relayerKey.startsWith('0x') ? relayerKey : `0x${relayerKey}`)

/** Accepts any of the three shapes a Sui key turns up in: the bech32 `suiprivkey1…` export, a
 *  raw 32-byte hex string, or a keystore entry (base64, 33 bytes, leading scheme flag). */
function suiKeypair() {
  const raw = process.env.SUI_TREASURY_KEY?.trim()
  if (!raw) return null
  if (raw.startsWith('suiprivkey')) {
    return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(raw).secretKey)
  }
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) {
    return Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(raw.replace(/^0x/, ''), 'hex')))
  }
  const bytes = Buffer.from(raw, 'base64')
  if (bytes.length === 33 && bytes[0] === 0x00) {
    return Ed25519Keypair.fromSecretKey(new Uint8Array(bytes.subarray(1)))
  }
  if (bytes.length === 32) return Ed25519Keypair.fromSecretKey(new Uint8Array(bytes))
  throw new Error(`SUI_TREASURY_KEY: unrecognised format (${bytes.length} bytes after base64 decode)`)
}
const suiSigner = suiKeypair()

const zg = createPublicClient({ chain: zeroG, transport: http(zeroG.rpcUrls.default.http[0]) })
const zgWallet = createWalletClient({ account, chain: zeroG, transport: http(zeroG.rpcUrls.default.http[0]) })
const eth = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) })
const ethWallet = createWalletClient({ account, chain: sepolia, transport: http(SEPOLIA_RPC) })
const sui = new SuiClient({ url: SUI_RPC })

const membershipAbi = parseAbi([
  'function spendTicket((uint256 merkleTreeDepth,uint256 merkleTreeRoot,uint256 nullifier,uint256 message,uint256 scope,uint256[8] points) proof)',
  'function spent(uint256 nullifier) view returns (bool)',
  'function memberCount() view returns (uint256)',
  'event Joined(uint256 indexed commitment, address indexed payer, uint256 memberCount)',
])
const semaphoreAbi = parseAbi(['function getMerkleTreeRoot(uint256 groupId) view returns (uint256)'])
const registrarAbi = parseAbi([
  'function claimFor(string label, string pubkey, address claimant) returns (address, uint256)',
  'function available(string label) view returns (bool)',
  'function isRelayer(address) view returns (bool)',
])

const app = express()
app.use(express.json({ limit: '256kb' }))
app.use((_req, res, next) => {
  res.set('access-control-allow-origin', '*')
  res.set('access-control-allow-headers', 'content-type')
  res.set('access-control-allow-methods', 'GET,POST,OPTIONS')
  next()
})
app.options('*', (_req, res) => res.sendStatus(204))

const log = (...a) => console.log(new Date().toISOString(), ...a)

// ---- GET /health --------------------------------------------------------------------------
// Deployment is not "done" until sepoliaAuthorized is true and the Sui balances are non-zero.
app.get('/health', async (_req, res) => {
  try {
    const [zgBal, ethBal, authorized, members] = await Promise.all([
      zg.getBalance({ address: account.address }),
      eth.getBalance({ address: account.address }),
      eth.readContract({ address: REGISTRAR, abi: registrarAbi, functionName: 'isRelayer', args: [account.address] }),
      zg.readContract({ address: MEMBERSHIP, abi: membershipAbi, functionName: 'memberCount' }),
    ])
    let suiBal = '0', walBal = '0'
    if (suiSigner) {
      const owner = suiSigner.toSuiAddress()
      const [s, w] = await Promise.all([
        sui.getBalance({ owner }),
        sui.getBalance({ owner, coinType: WAL_TYPE }).catch(() => ({ totalBalance: '0' })),
      ])
      suiBal = s.totalBalance
      walBal = w.totalBalance
    }
    const ok = authorized && ethBal > 0n && (!suiSigner || (BigInt(suiBal) > 0n && BigInt(walBal) > 0n))
    res.json({
      ok, relayer: account.address, sepoliaAuthorized: authorized,
      memberCount: members.toString(),
      balances: { zeroG: formatEther(zgBal), sepolia: formatEther(ethBal), sui: suiBal, wal: walBal },
      sui: suiSigner?.toSuiAddress() ?? null,
      contracts: { membership: MEMBERSHIP, registrar: REGISTRAR, parent: PARENT },
      codecTokens: !!CODEC_SECRET,
    })
  } catch (e) {
    res.status(503).json({ ok: false, error: String(e.message ?? e) })
  }
})

// ---- GET /group ---------------------------------------------------------------------------
// The member set, rebuilt from Joined events. Cached briefly because a browser hits this before
// every proof. The CLIENT MUST re-verify `root` against the chain — we are not to be trusted
// with the member set, and a forged one would produce proofs that simply fail.
let groupCache = { at: 0, body: null }
app.get('/group', async (_req, res) => {
  try {
    if (Date.now() - groupCache.at < 30_000 && groupCache.body) return res.json(groupCache.body)
    const logs = await zg.getLogs({
      address: MEMBERSHIP,
      event: membershipAbi.find((x) => x.type === 'event' && x.name === 'Joined'),
      fromBlock: 0n, toBlock: 'latest',
    })
    const members = logs.map((l) => l.args.commitment.toString())
    const root = await zg.readContract({
      address: SEMAPHORE, abi: semaphoreAbi, functionName: 'getMerkleTreeRoot', args: [GROUP_ID],
    })
    const body = { members, root: root.toString(), memberCount: members.length, groupId: GROUP_ID.toString() }
    groupCache = { at: Date.now(), body }
    res.json(body)
  } catch (e) {
    res.status(503).json({ error: String(e.message ?? e) })
  }
})

// ---- POST /claim --------------------------------------------------------------------------
// Idempotent on purpose: if we die between burning the ticket and issuing the handle, a retry —
// from this relayer or any other — finishes the job. The ticket is on-chain; it is the receipt.
const inFlight = new Map()

app.post('/claim', async (req, res) => {
  const { label, evmAddr, suiAddr, pubkey, ticket } = req.body ?? {}
  try {
    if (!label || !evmAddr || !suiAddr || !pubkey || !ticket) {
      return res.status(400).json({ error: 'label, evmAddr, suiAddr, pubkey and ticket are required' })
    }
    if (!/^[a-z0-9-]{3,32}$/.test(label) || label.startsWith('-') || label.endsWith('-')) {
      return res.status(400).json({ error: 'invalid label' })
    }
    if (inFlight.has(label)) return res.status(409).json({ error: 'a claim for this label is in flight' })
    inFlight.set(label, Date.now())

    // 1. The binding check. Cheap, and it defeats every redirection attempt at once.
    const expected = ticketMessage(label, evmAddr, suiAddr, pubkey)
    if (BigInt(ticket.message) !== expected) {
      return res.status(400).json({
        error: 'ticket message does not match this claim',
        detail: 'the proof binds (label, evmAddr, suiAddr, pubkey); one of them differs',
      })
    }

    const proof = {
      merkleTreeDepth: BigInt(ticket.merkleTreeDepth),
      merkleTreeRoot: BigInt(ticket.merkleTreeRoot),
      nullifier: BigInt(ticket.nullifier),
      message: BigInt(ticket.message),
      scope: BigInt(ticket.scope),
      points: ticket.points.map(BigInt),
    }

    // 2. Burn the ticket — unless a previous attempt already did.
    let spendTx = null
    const alreadySpent = await zg.readContract({
      address: MEMBERSHIP, abi: membershipAbi, functionName: 'spent', args: [proof.nullifier],
    })
    if (alreadySpent) {
      log(`ticket ${proof.nullifier} already spent — resuming`)
    } else {
      // 3. Simulate first so an invalid proof costs us nothing.
      try {
        await zg.simulateContract({
          account, address: MEMBERSHIP, abi: membershipAbi, functionName: 'spendTicket', args: [proof],
        })
      } catch (e) {
        return res.status(400).json({ error: 'proof rejected', detail: String(e.shortMessage ?? e.message) })
      }
      const gasPrice = await zg.getGasPrice()
      spendTx = await zgWallet.writeContract({
        account, address: MEMBERSHIP, abi: membershipAbi, functionName: 'spendTicket',
        args: [proof], gas: 3_000_000n, gasPrice,
      })
      const r = await zg.waitForTransactionReceipt({ hash: spendTx, timeout: 180_000, pollingInterval: 3_000 })
      if (r.status !== 'success') throw new Error('spendTicket reverted')
      log(`burned ticket ${proof.nullifier} (${spendTx})`)
    }

    // 4. Issue the handle. The claimant never signs anything on Sepolia.
    let claimTx = null
    const available = await eth.readContract({
      address: REGISTRAR, abi: registrarAbi, functionName: 'available', args: [label],
    })
    if (available) {
      const { request } = await eth.simulateContract({
        account, address: REGISTRAR, abi: registrarAbi, functionName: 'claimFor',
        args: [label, pubkey, getAddress(evmAddr)],
      })
      claimTx = await ethWallet.writeContract(request)
      const r = await eth.waitForTransactionReceipt({ hash: claimTx })
      if (r.status !== 'success') throw new Error('claimFor reverted')
      log(`issued ${label}.${PARENT} to ${evmAddr} (${claimTx})`)
    } else {
      log(`${label} already taken — skipping claimFor`)
    }

    // 5. Stipends. Best-effort on purpose: the handle is already issued, so a funding hiccup
    //    must not turn a successful claim into an error the user cannot act on.
    let stipendTx = null
    try {
      stipendTx = await payStipend(suiAddr)
    } catch (e) {
      log(`sui stipend failed for ${suiAddr}: ${e.message}`)
    }

    let gasTx = null
    try {
      gasTx = await payGasStipend(getAddress(evmAddr))
    } catch (e) {
      log(`gas stipend failed for ${evmAddr}: ${e.message}`)
    }

    // Same membership, second unlock: mint the codec token from the nullifier we just verified.
    const codecToken = mintCodecToken(proof.nullifier)

    res.json({ handle: `${label}.${PARENT}`, spendTx, claimTx, stipendTx, gasTx, codecToken })
  } catch (e) {
    log('claim failed', e)
    res.status(500).json({ error: String(e.shortMessage ?? e.message ?? e) })
  } finally {
    inFlight.delete(label)
  }
})

/** Give the freshly-minted owner enough Sepolia gas to manage its own records. Skipped if it
 *  already holds some, so a retry never double-pays. */
async function payGasStipend(recipient) {
  const balance = await eth.getBalance({ address: recipient })
  if (balance >= ETH_STIPEND / 2n) {
    log(`gas stipend skipped — ${recipient} already holds ${formatEther(balance)} ETH`)
    return null
  }
  const hash = await ethWallet.sendTransaction({ account, to: recipient, value: ETH_STIPEND })
  await eth.waitForTransactionReceipt({ hash })
  log(`gas stipend ${formatEther(ETH_STIPEND)} ETH → ${recipient} (${hash})`)
  return hash
}

async function payStipend(recipient) {
  if (!suiSigner) throw new Error('SUI_TREASURY_KEY not configured')
  const owner = suiSigner.toSuiAddress()
  const tx = new Transaction()
  const [suiCoin] = tx.splitCoins(tx.gas, [SUI_STIPEND])
  const wal = await sui.getCoins({ owner, coinType: WAL_TYPE })
  if (!wal.data.length) throw new Error('treasury holds no WAL')
  const primary = wal.data[0].coinObjectId
  if (wal.data.length > 1) {
    tx.mergeCoins(tx.object(primary), wal.data.slice(1).map((c) => tx.object(c.coinObjectId)))
  }
  const [walCoin] = tx.splitCoins(tx.object(primary), [WAL_STIPEND])
  tx.transferObjects([suiCoin, walCoin], recipient)

  const res = await sui.signAndExecuteTransaction({
    transaction: tx, signer: suiSigner, options: { showEffects: true },
  })
  await sui.waitForTransaction({ digest: res.digest })
  if (res.effects?.status.status !== 'success') throw new Error(res.effects?.status.error ?? 'stipend failed')
  log(`stipend → ${recipient} (${res.digest})`)
  return res.digest
}

app.listen(PORT, '0.0.0.0', () => {
  log(`lortnoc relayer on :${PORT}`)
  log(`  relayer  ${account.address}`)
  log(`  sui      ${suiSigner?.toSuiAddress() ?? '(not configured)'}`)
  log(`  0G       ${MEMBERSHIP}`)
  log(`  registrar ${REGISTRAR}`)
})
