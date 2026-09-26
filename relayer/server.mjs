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
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import {
  createPublicClient, createWalletClient, defineChain, http, parseAbi, formatEther, getAddress, keccak256, stringToHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet, sepolia } from 'viem/chains'
import { SuiClient } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography'
import { verifyMessage } from 'viem'
import { ticketMessage, claimScope } from '../shared/ticket.mjs'
import { createDemoMinter } from './demo.mjs'
import { createSpaceHandler, MAINNET, SEPOLIA } from './space.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'))

const ZG = readJson('app/src/lib/live/zerog-deployment.json').mainnet
const ENS_D = readJson('app/src/lib/live/ens-deployment.json')
const MEMBERSHIP = ZG.contracts.membership
const SEMAPHORE = ZG.contracts.semaphore
const GROUP_ID = BigInt(ZG.groupId ?? 0)
const REGISTRAR = ENS_D.lortnoc.registrar
const REGISTRY = ENS_D.lortnoc.registry
const UNIVERSAL_HELPER = ENS_D.ens.universalHelper
const PARENT = ENS_D.lortnoc.parentName
// Paid spaces (docs/PRD-universal.md §23): purchase contract per chain, ENS branch on Sepolia.
const SPACES_D = readJson('app/src/lib/live/spaces-deployment.json')
const SPACE_BRANCH = ENS_D.lortnoc.spaces ?? null

const PORT = Number(process.env.PORT || 8080)
const SUI_RPC = process.env.SUI_RPC || 'https://sui-testnet-rpc.publicnode.com'
const SEPOLIA_RPC = process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com'
// Mainnet is READ-ONLY here (SpaceBought receipts). This service never sends a mainnet tx.
const MAINNET_RPC = process.env.MAINNET_RPC || 'https://ethereum-rpc.publicnode.com'
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
const mainnetReader = createPublicClient({ chain: mainnet, transport: http(MAINNET_RPC) })

/** One Sepolia send at a time. /claim, /space and the stipends all sign with the same key, and
 *  two concurrent sends would race for the same nonce. */
let sepoliaQueue = Promise.resolve()
function sepoliaSerial(fn) {
  const run = sepoliaQueue.then(fn, fn)
  sepoliaQueue = run.catch(() => {})
  return run
}

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
const registryAbi = parseAbi(['function findOwner(string label) view returns (address)'])
const spaceRegistrarAbi = parseAbi([
  'function claimSpaceFor(string label, address spaceOwner, string token) returns (address, uint256)',
  'function isRelayer(address) view returns (bool)',
])
const spacesAbi = parseAbi(['function taken(bytes32 labelHash) view returns (bool)'])
const helperAbi = parseAbi(['function findExactOwner(bytes name) view returns (address)'])
const dnsEncode = (name) => {
  let o = '0x'
  for (const p of name.split('.').filter(Boolean)) {
    const b = new TextEncoder().encode(p)
    o += b.length.toString(16).padStart(2, '0') + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  }
  return `${o}00`
}
/** Sepolia fees with a floor on the tip: public RPCs sometimes suggest ~0, and a zero-tip tx can
 *  sit unmined forever — which here would stall a claim whose ticket is already burned. */
async function sepoliaFees() {
  const floor = 1_000_000_000n
  const f = await eth.estimateFeesPerGas()
  const tip = f.maxPriorityFeePerGas > floor ? f.maxPriorityFeePerGas : floor
  return { maxPriorityFeePerGas: tip, maxFeePerGas: f.maxFeePerGas + tip }
}

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
    const spacesAuthorized = SPACE_BRANCH
      ? await eth.readContract({ address: SPACE_BRANCH.registrar, abi: spaceRegistrarAbi, functionName: 'isRelayer', args: [account.address] })
      : null
    const ok = authorized && spacesAuthorized !== false && ethBal > 0n && (!suiSigner || (BigInt(suiBal) > 0n && BigInt(walBal) > 0n))
    res.json({
      ok, relayer: account.address, sepoliaAuthorized: authorized, spacesAuthorized,
      memberCount: members.toString(),
      balances: { zeroG: formatEther(zgBal), sepolia: formatEther(ethBal), sui: suiBal, wal: walBal },
      sui: suiSigner?.toSuiAddress() ?? null,
      contracts: {
        membership: MEMBERSHIP, registrar: REGISTRAR, parent: PARENT,
        spaceRegistrar: SPACE_BRANCH?.registrar ?? null,
        spaces: { [MAINNET]: SPACES_D.mainnet?.address ?? null, [SEPOLIA]: SPACES_D.sepolia?.address ?? null },
      },
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

    // 1b. The scope check. The nullifier is hash(identity, scope), and LortnocMembership.spendTicket
    // does NOT check the scope — so without this line one $1 membership proves under scope A, B,
    // C… and every proof carries a fresh, unspent nullifier: unlimited handles for one payment.
    // "One handle per membership" is only enforced by the maths if the scope is pinned HERE.
    if (BigInt(ticket.scope) !== claimScope()) {
      return res.status(400).json({ error: 'ticket scope is not the claim scope' })
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
      // Confirm by STATE, not by receipt. 0G propagates receipts slowly enough that
      // waitForTransactionReceipt throws for transactions that already succeeded — and here that
      // would mean reporting failure on a ticket we just burned, which is the one error that
      // costs the user something irreversible.
      await confirmSpent(proof.nullifier, spendTx)
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
      claimTx = await sepoliaSerial(async () => {
        const h = await ethWallet.writeContract({ ...request, ...(await sepoliaFees()) })
        const r = await eth.waitForTransactionReceipt({ hash: h })
        if (r.status !== 'success') throw new Error('claimFor reverted')
        return h
      })
      log(`issued ${label}.${PARENT} to ${evmAddr} (${claimTx})`)
    } else {
      // Idempotent retry path — but only if the label is OURS to skip. A label owned by anyone
      // else must not be reported as a successful claim.
      const holder = await eth.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'findOwner', args: [label] })
      if (holder.toLowerCase() !== evmAddr.toLowerCase()) {
        log(`${label} is held by ${holder}, not the claimant — refusing to report success`)
        return res.status(409).json({ error: 'label is owned by someone else', label, holder })
      }
      log(`${label} already issued to the claimant — skipping claimFor`)
    }
    // Confirm the way ENS's own tooling sees it (UniversalHelper from the canonical root), not by
    // receipt alone. Logged, not fatal: the registry write above already succeeded.
    try {
      const exact = await eth.readContract({ address: UNIVERSAL_HELPER, abi: helperAbi, functionName: 'findExactOwner', args: [dnsEncode(`${label}.${PARENT}`)] })
      if (exact.toLowerCase() !== evmAddr.toLowerCase()) log(`WARN ${label}.${PARENT}: findExactOwner=${exact}, expected ${evmAddr}`)
    } catch (e) {
      log(`findExactOwner check failed for ${label}: ${e.shortMessage ?? e.message}`)
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
  const hash = await sepoliaSerial(async () => {
    const h = await ethWallet.sendTransaction({ account, to: recipient, value: ETH_STIPEND, ...(await sepoliaFees()) })
    await eth.waitForTransactionReceipt({ hash: h })
    return h
  })
  log(`gas stipend ${formatEther(ETH_STIPEND)} ETH → ${recipient} (${hash})`)
  return hash
}

/** Poll `spent(nullifier)` until the burn is visible. The nullifier is the receipt. */
async function confirmSpent(nullifier, hash, timeoutMs = 5 * 60_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const spent = await zg
      .readContract({ address: MEMBERSHIP, abi: membershipAbi, functionName: 'spent', args: [nullifier] })
      .catch(() => false)
    if (spent) return
    try {
      const r = await zg.getTransactionReceipt({ hash })
      if (r.status === 'reverted') throw new Error(`spendTicket reverted (${hash})`)
    } catch (e) {
      if (String(e.message ?? '').includes('reverted')) throw e
      // receipt not propagated yet — that is normal on 0G, keep waiting
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  throw new Error(`spendTicket ${hash} not confirmed within 5 minutes — retry to resume`)
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

// ---- POST /space (docs/PRD-universal.md §23.2) ------------------------------------------------
// A `SpaceBought` purchase (mainnet = real money, Sepolia = demos) becomes
// `<label>.space.lortnoctahc.eth`. The decision lives in space.mjs (tested in relayer/test/);
// this only supplies the chain clients. Logs carry label/owner/chain — never the caller's IP.
const handleSpace = SPACE_BRANCH
  ? createSpaceHandler({
      readers: { [MAINNET]: mainnetReader, [SEPOLIA]: eth },
      spaces: Object.fromEntries(
        [[MAINNET, SPACES_D.mainnet?.address], [SEPOLIA, SPACES_D.sepolia?.address]].filter(([, a]) => a),
      ),
      branchName: SPACE_BRANCH.branchName ?? `space.${PARENT}`,
      spaceOwnerOf: (label) =>
        eth.readContract({ address: SPACE_BRANCH.registry, abi: registryAbi, functionName: 'findOwner', args: [label] }),
      claimSpace: async (label, owner, token) => {
        const { request } = await eth.simulateContract({
          account, address: SPACE_BRANCH.registrar, abi: spaceRegistrarAbi, functionName: 'claimSpaceFor',
          args: [label, getAddress(owner), token],
        })
        return sepoliaSerial(async () => {
          const h = await ethWallet.writeContract({ ...request, ...(await sepoliaFees()) })
          const r = await eth.waitForTransactionReceipt({ hash: h })
          if (r.status !== 'success') throw new Error('claimSpaceFor reverted')
          return h
        })
      },
      payStipend: (owner) => payGasStipend(getAddress(owner)),
      mainnetTaken: SPACES_D.mainnet?.address
        ? (label) => mainnetReader.readContract({
            address: SPACES_D.mainnet.address, abi: spacesAbi, functionName: 'taken', args: [keccak256(stringToHex(label))],
          })
        : undefined,
      log,
    })
  : null

// ---- demo passes (relayer/demo.mjs): testnet NFTs so anyone can try a holders-only space -------
const DEMO_PASS = ENS_D.lortnoc.spaces?.demoPass
const demoMint = DEMO_PASS
  ? createDemoMinter({
      log,
      // one after another; each send returns once the node has accepted it, so the next picks the next nonce
      mintTo: (to) => ethWallet.writeContract({
        address: DEMO_PASS, abi: parseAbi(['function mintTo(address) returns (uint256)']), functionName: 'mintTo', args: [to],
      }),
    })
  : null
app.post('/demo/mint', async (req, res) => {
  if (!demoMint) return res.status(503).json({ error: 'no demo pass deployed' })
  const r = await demoMint(req.body, req.ip ?? '?')
  res.status(r.status).json({ ...r.body, collection: `eip155:11155111/erc721:${DEMO_PASS.toLowerCase()}` })
})

app.post('/space', async (req, res) => {
  if (!handleSpace) return res.status(503).json({ error: 'spaces are not deployed (ens-deployment.json lortnoc.spaces)' })
  const r = await handleSpace(req.body)
  res.status(r.status).json(r.body)
})

/**
 * POST /codec-token — re-issue the codec capability to someone who already paid.
 *
 * The token is handed to the extension by postMessage at the moment of a claim. If the extension
 * was not installed and listening on that page in that instant it was gone for good, and the only
 * recourse was paying a second time — which is not an answer.
 *
 * We deliberately do NOT accept a nullifier. Nullifiers are public on-chain, so one proves
 * nothing, and having the client re-derive it would couple us to Semaphore's internal formula.
 * Instead the caller supplies the four values their ticket committed to; we recompute the binding,
 * find the burned ticket whose `message` equals it, and require a signature from the address the
 * handle went to. The caller must therefore know the exact bound values AND control that address.
 */
app.post('/codec-token', async (req, res) => {
  const { label, evmAddr, suiAddr, pubkey, signature } = req.body ?? {}
  try {
    if (!CODEC_SECRET) return res.status(503).json({ error: 'codec tokens are not configured' })
    if (!label || !evmAddr || !suiAddr || !pubkey || !signature) {
      return res.status(400).json({ error: 'label, evmAddr, suiAddr, pubkey and signature are required' })
    }

    // 1. Find the burned ticket that committed to exactly these values.
    const expected = ticketMessage(label, evmAddr, suiAddr, pubkey)
    const logs = await zg.getLogs({
      address: MEMBERSHIP,
      event: {
        type: 'event', name: 'TicketSpent',
        inputs: [
          { name: 'nullifier', type: 'uint256', indexed: true },
          { name: 'message', type: 'uint256', indexed: false },
          { name: 'relayer', type: 'address', indexed: true },
        ],
      },
      fromBlock: 0n, toBlock: 'latest',
    })
    const burned = logs.find((l) => l.args.message === expected)
    if (!burned) return res.status(403).json({ error: 'no paid claim matches those values' })

    // 2. And the caller must control the address the handle went to.
    const ok = await verifyMessage({
      address: getAddress(evmAddr),
      message: `lortnoc codec token for ${label}`,
      signature,
    }).catch(() => false)
    if (!ok) return res.status(403).json({ error: 'signature does not match the claimant address' })

    log(`re-issued codec token for ${label} (${evmAddr})`)
    res.json({ codecToken: mintCodecToken(burned.args.nullifier) })
  } catch (e) {
    log('codec-token failed', e)
    res.status(500).json({ error: String(e.shortMessage ?? e.message ?? e) })
  }
})

// ---- knock relay (§6.8) --------------------------------------------------------------------
//
// Knocks are sealed with a key derived from an answer we never see, to a question we never see
// the answer to. This endpoint stores opaque blobs and hands them to whoever asks for a handle's
// inbox — it cannot read one, and cannot tell a correct knock from a wrong-answer one.
//
// The rate limit is load-bearing rather than hygiene: an answer like "the bar we met at" is
// low-entropy, and the ONLY thing making guessing expensive is that each attempt costs an
// Argon2id derivation and a round trip through here (§6.8 "online-only, rate-limited").
const KNOCK_TTL_MS = 7 * 24 * 60 * 60 * 1000
const KNOCK_MAX_PER_HANDLE = 50
const KNOCK_RATE_PER_MIN = 6
const knocks = new Map() // handle -> [{ id, sealed, ts }]
const knockHits = new Map() // ip|handle -> [timestamps]

// A knock the recipient has not opened yet exists in exactly one place: here. That made a plain
// in-memory Map a data-loss bug wearing a 7-day TTL — every restart silently dropped pending
// knocks, and the sender was told "sent" while the recipient would never see anything. Nobody
// would ever find out, because a knock is unreadable and unattributable by design.
//
// So: persist the blobs. They stay opaque — this file holds exactly what the endpoint already
// serves to anyone who asks (§6.8: pending knocks are public precisely because they are
// unreadable without the answer), so writing it down leaks nothing new.
//
// /data is a mounted volume when one exists and survives a deploy; /tmp survives only a process
// restart. Both beat losing them on every crash. Set KNOCK_STORE to override.
const KNOCK_STORE =
  process.env.KNOCK_STORE ?? (existsSync('/data') ? '/data/knocks.json' : '/tmp/lortnoc-knocks.json')

function loadKnocks() {
  try {
    if (!existsSync(KNOCK_STORE)) return
    const now = Date.now()
    let kept = 0
    for (const [handle, list] of Object.entries(JSON.parse(readFileSync(KNOCK_STORE, 'utf8')))) {
      const live = list.filter((k) => now - k.ts < KNOCK_TTL_MS)
      if (live.length) {
        knocks.set(handle, live)
        kept += live.length
      }
    }
    log(`knock store: ${kept} pending restored from ${KNOCK_STORE}`)
  } catch (e) {
    // A corrupt store must not stop the relayer from doing its real job (claims). Losing knocks
    // is bad; refusing to issue handles is worse.
    log(`knock store: could not restore (${e.message}) — starting empty`)
  }
}

/** Write via a temp file + rename so a crash mid-write cannot leave a truncated store behind. */
function persistKnocks() {
  try {
    const tmp = `${KNOCK_STORE}.tmp`
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(knocks)))
    renameSync(tmp, KNOCK_STORE)
  } catch (e) {
    log(`knock store: write failed (${e.message}) — knocks are memory-only until this clears`)
  }
}

function rateLimited(bucket) {
  const now = Date.now()
  const hits = (knockHits.get(bucket) ?? []).filter((t) => now - t < 60_000)
  hits.push(now)
  knockHits.set(bucket, hits)
  return hits.length > KNOCK_RATE_PER_MIN
}

/** POST /knock { toHandle, sealed } — deliver a sealed knock. */
app.post('/knock', (req, res) => {
  const { toHandle, sealed } = req.body ?? {}
  if (!toHandle || !sealed) return res.status(400).json({ error: 'toHandle and sealed are required' })
  if (typeof sealed !== 'string' || sealed.length > 4096) {
    return res.status(400).json({ error: 'sealed must be a base64 string under 4KB' })
  }
  const ip = req.headers['fly-client-ip'] ?? req.ip ?? 'local'
  if (rateLimited(`${ip}|${toHandle}`)) {
    return res.status(429).json({ error: 'too many knocks — slow down', retryAfter: 60 })
  }

  const now = Date.now()
  const list = (knocks.get(toHandle) ?? []).filter((k) => now - k.ts < KNOCK_TTL_MS)
  list.push({ id: `${now}-${Math.round(now % 1e6)}-${list.length}`, sealed, ts: now })
  // Oldest-out, so a flood cannot bury real knocks indefinitely.
  knocks.set(toHandle, list.slice(-KNOCK_MAX_PER_HANDLE))
  persistKnocks()
  log(`knock -> ${toHandle} (${list.length} pending)`)
  res.json({ ok: true, pending: Math.min(list.length, KNOCK_MAX_PER_HANDLE) })
})

/** GET /knocks/:handle — every sealed knock waiting. Public on purpose: they are unreadable
 *  without the answer, and gating this would mean knowing who is allowed to look. */
app.get('/knocks/:handle', (req, res) => {
  const now = Date.now()
  const before = knocks.get(req.params.handle)?.length ?? 0
  const list = (knocks.get(req.params.handle) ?? []).filter((k) => now - k.ts < KNOCK_TTL_MS)
  knocks.set(req.params.handle, list)
  if (before !== list.length) persistKnocks() // expiry is a state change worth keeping
  // Logged WITHOUT the caller's IP (§8 Layer 4: the gateway must not be able to correlate people)
  // and only when something is actually waiting. This one line is what turns "the recipient sees
  // nothing" from a guess into a fact: it says whether their client is polling at all.
  if (list.length) log(`knocks? ${req.params.handle} -> ${list.length} served`)
  res.json({ knocks: list })
})

loadKnocks()

app.listen(PORT, '0.0.0.0', () => {
  log(`lortnoc relayer on :${PORT}`)
  log(`  knocks   ${KNOCK_STORE}`)
  log(`  relayer  ${account.address}`)
  log(`  sui      ${suiSigner?.toSuiAddress() ?? '(not configured)'}`)
  log(`  0G       ${MEMBERSHIP}`)
  log(`  registrar ${REGISTRAR}`)
  log(`  spaces   ${SPACE_BRANCH?.registrar ?? '(not deployed)'}`)
})
