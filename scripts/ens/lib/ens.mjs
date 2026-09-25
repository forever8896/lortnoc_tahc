// Shared plumbing for the day-0 ENS v2 scripts: clients, addresses, ABIs, constants.
// Addresses come from app/src/lib/live/ens-deployment.json so the app and the CLI can never
// drift apart — that file is the single source of truth for both.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  encodePacked,
  stringToHex,
  namehash,
  getContract,
  encodeAbiParameters,
  getAddress,
  encodeFunctionData,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..', '..', '..')
export const DEPLOYMENT_PATH = join(ROOT, 'app', 'src', 'lib', 'live', 'ens-deployment.json')

export function readDeployment() {
  return JSON.parse(readFileSync(DEPLOYMENT_PATH, 'utf8'))
}

export function writeDeployment(next) {
  writeFileSync(DEPLOYMENT_PATH, JSON.stringify(next, null, 2) + '\n')
}

export const D = readDeployment()
export const ENS = D.ens
export const PARENT_NAME = D.lortnoc.parentName // lortnoctahc.eth
export const PARENT_LABEL = PARENT_NAME.split('.')[0]
// lortnoc.eth was reserved on 06-29 and is deliberately NOT carried to 09-15: record keys are
// plain strings, so owning the prefix bought nothing.

// ---- role constants (verbatim from contracts-v2 @ sepolia-deployment-2026-09-15) ---------------

/** EACBaseRolesLib.ALL_ROLES — bit 0 of every nybble. */
export const ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111n
/** RegistryRolesLib.ROLE_REGISTRAR = 1<<0, admin = role<<128. */
export const ROLE_REGISTRAR = 1n
export const ROLE_REGISTRAR_ADMIN = ROLE_REGISTRAR << 128n
/** RegistryRolesLib.ROLE_SET_SUBREGISTRY = 1<<20, ROLE_SET_RESOLVER = 1<<24. */
export const ROLE_SET_SUBREGISTRY = 1n << 20n
export const ROLE_SET_RESOLVER = 1n << 24n
/** PermissionedResolverLib.ROLE_SET_TEXT = 1<<4, ROLE_SET_ADDRESS = 1<<0. */
export const ROLE_SET_TEXT = 1n << 4n
export const ROLE_SET_ADDRESS = 1n

/** Text record keys (CLAUDE.md §5.4). */
export const REC = {
  pubkey: 'eth.lortnoc.pubkey',
  walrus: 'eth.lortnoc.walrus',
  inbox: 'eth.lortnoc.inbox',
  discoverable: 'eth.lortnoc.discoverable',
  knock: 'eth.lortnoc.knock',
  sui: 'eth.lortnoc.sui',
}

// ---- ABIs (only what we call) -----------------------------------------------------------------

export const ethRegistrarAbi = [
  { type: 'function', name: 'isAvailable', stateMutability: 'view', inputs: [{ name: 'label', type: 'string' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getRegisterPrice', stateMutability: 'view', inputs: [{ name: 'label', type: 'string' }, { name: 'duration', type: 'uint64' }, { name: 'paymentToken', type: 'address' }], outputs: [{ type: 'uint256' }, { type: 'uint256' }] },
  { type: 'function', name: 'makeCommitment', stateMutability: 'pure', inputs: [{ name: 'label', type: 'string' }, { name: 'owner', type: 'address' }, { name: 'secret', type: 'bytes32' }, { name: 'subregistry', type: 'address' }, { name: 'resolver', type: 'address' }, { name: 'duration', type: 'uint64' }, { name: 'referrer', type: 'bytes32' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'commit', stateMutability: 'nonpayable', inputs: [{ name: 'commitment', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'commitmentAt', stateMutability: 'view', inputs: [{ name: 'commitment', type: 'bytes32' }], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'register', stateMutability: 'nonpayable', inputs: [{ name: 'label', type: 'string' }, { name: 'owner', type: 'address' }, { name: 'secret', type: 'bytes32' }, { name: 'subregistry', type: 'address' }, { name: 'resolver', type: 'address' }, { name: 'duration', type: 'uint64' }, { name: 'paymentToken', type: 'address' }, { name: 'referrer', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'MIN_COMMITMENT_AGE', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'MAX_COMMITMENT_AGE', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
]

export const registryAbi = [
  { type: 'function', name: 'register', stateMutability: 'nonpayable', inputs: [{ name: 'label', type: 'string' }, { name: 'owner', type: 'address' }, { name: 'registry', type: 'address' }, { name: 'resolver', type: 'address' }, { name: 'roleBitmap', type: 'uint256' }, { name: 'expiry', type: 'uint64' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'findOwner', stateMutability: 'view', inputs: [{ name: 'label', type: 'string' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'findTokenId', stateMutability: 'view', inputs: [{ name: 'label', type: 'string' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'findExpiry', stateMutability: 'view', inputs: [{ name: 'label', type: 'string' }], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'getResolver', stateMutability: 'view', inputs: [{ name: 'label', type: 'string' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getSubregistry', stateMutability: 'view', inputs: [{ name: 'label', type: 'string' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'setSubregistry', stateMutability: 'nonpayable', inputs: [{ name: 'anyId', type: 'uint256' }, { name: 'registry', type: 'address' }], outputs: [] },
  { type: 'function', name: 'setResolver', stateMutability: 'nonpayable', inputs: [{ name: 'anyId', type: 'uint256' }, { name: 'resolver', type: 'address' }], outputs: [] },
  // 09-15: initialize(Grant[] grants) — was (address rootAccount, uint256 roleBitmap).
  { type: 'function', name: 'initialize', stateMutability: 'nonpayable', inputs: [{ name: 'grants', type: 'tuple[]', components: [{ name: 'account', type: 'address' }, { name: 'roleBitmap', type: 'uint256' }] }], outputs: [] },
  { type: 'function', name: 'grantRootRoles', stateMutability: 'nonpayable', inputs: [{ name: 'roleBitmap', type: 'uint256' }, { name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'revokeRootRoles', stateMutability: 'nonpayable', inputs: [{ name: 'roleBitmap', type: 'uint256' }, { name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'hasRootRoles', stateMutability: 'view', inputs: [{ name: 'roleBitmap', type: 'uint256' }, { name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getParent', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }, { type: 'string' }] },
  { type: 'function', name: 'setParent', stateMutability: 'nonpayable', inputs: [{ name: 'parent', type: 'address' }, { name: 'label', type: 'string' }], outputs: [] },
]

export const factoryAbi = [
  { type: 'function', name: 'deployProxy', stateMutability: 'nonpayable', inputs: [{ name: 'implementation', type: 'address' }, { name: 'salt', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'verifyContract', stateMutability: 'view', inputs: [{ name: 'proxy', type: 'address' }], outputs: [{ type: 'address' }] },
  { type: 'event', name: 'ProxyDeployed', inputs: [{ name: 'sender', type: 'address', indexed: true }, { name: 'proxyAddress', type: 'address', indexed: true }, { name: 'salt', type: 'uint256', indexed: false }, { name: 'implementation', type: 'address', indexed: false }] },
]

// 09-15 PermissionedResolver. Setters take the DNS-encoded NAME; there are NO direct text()/addr()
// getters any more — read through the UniversalResolver (viem getEnsText / getEnsAddress).
// authorizeTextRoles/setAlias/clearRecords are gone: delegate with grantSetterRoles(setter, account)
// and undo with the generic EAC revokeRoles(resource = keccak256(key), ROLE_SET_TEXT, account).
const GRANT_TUPLE = { type: 'tuple[]', components: [{ name: 'account', type: 'address' }, { name: 'roleBitmap', type: 'uint256' }] }
export const resolverAbi = [
  { type: 'function', name: 'initialize', stateMutability: 'nonpayable', inputs: [{ name: 'grants', ...GRANT_TUPLE }, { name: 'calls', type: 'bytes[]' }], outputs: [] },
  { type: 'function', name: 'setText', stateMutability: 'nonpayable', inputs: [{ name: 'name', type: 'bytes' }, { name: 'key', type: 'string' }, { name: 'value', type: 'string' }], outputs: [] },
  { type: 'function', name: 'setAddress', stateMutability: 'nonpayable', inputs: [{ name: 'name', type: 'bytes' }, { name: 'coinType', type: 'uint256' }, { name: 'addressBytes', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'grantSetterRoles', stateMutability: 'nonpayable', inputs: [{ name: 'setter', type: 'bytes' }, { name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'revokeRoles', stateMutability: 'nonpayable', inputs: [{ name: 'resource', type: 'uint256' }, { name: 'roleBitmap', type: 'uint256' }, { name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'hasRoles', stateMutability: 'view', inputs: [{ name: 'resource', type: 'uint256' }, { name: 'roleBitmap', type: 'uint256' }, { name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'hasRootRoles', stateMutability: 'view', inputs: [{ name: 'roleBitmap', type: 'uint256' }, { name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'roles', stateMutability: 'view', inputs: [{ name: 'resource', type: 'uint256' }, { name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'supportsInterface', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes4' }], outputs: [{ type: 'bool' }] },
]

/** UniversalHelper @09-15 — ownership as ENS's own tooling computes it. */
export const helperAbi = [
  { type: 'function', name: 'findExactOwner', stateMutability: 'view', inputs: [{ name: 'name', type: 'bytes' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'ROOT_REGISTRY', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
]

/** Per-resolver EAC resource of a text key (09-15: keccak256(key), NOT keccak(node, keccak(key))). */
export const textResource = (key) => BigInt(keccak256(stringToHex(key)))

export const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
]

export const registrarAbi = [
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [{ name: 'label', type: 'string' }, { name: 'pubkey', type: 'string' }], outputs: [{ type: 'address' }, { type: 'uint256' }] },
  { type: 'function', name: 'claimFor', stateMutability: 'nonpayable', inputs: [{ name: 'label', type: 'string' }, { name: 'pubkey', type: 'string' }, { name: 'claimant', type: 'address' }], outputs: [{ type: 'address' }, { type: 'uint256' }] },
  { type: 'function', name: 'available', stateMutability: 'view', inputs: [{ name: 'label', type: 'string' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'nodeOf', stateMutability: 'view', inputs: [{ name: 'label', type: 'string' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'gate', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'REGISTRY', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'PARENT_NODE', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'setRelayer', stateMutability: 'nonpayable', inputs: [{ name: 'relayer', type: 'address' }, { name: 'allowed', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'isRelayer', stateMutability: 'view', inputs: [{ name: 'relayer', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'dnsNameOf', stateMutability: 'view', inputs: [{ name: 'label', type: 'string' }], outputs: [{ type: 'bytes' }] },
  { type: 'function', name: 'migrationOpen', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'migrate', stateMutability: 'nonpayable', inputs: [{ name: 'label', type: 'string' }, { name: 'pubkey', type: 'string' }, { name: 'claimant', type: 'address' }, { name: 'keys', type: 'string[]' }, { name: 'values', type: 'string[]' }], outputs: [{ type: 'address' }, { type: 'uint256' }] },
  { type: 'function', name: 'closeMigration', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'event', name: 'HandleClaimed', inputs: [{ name: 'label', type: 'string', indexed: false }, { name: 'claimant', type: 'address', indexed: true }, { name: 'resolver', type: 'address', indexed: true }, { name: 'tokenId', type: 'uint256', indexed: false }, { name: 'node', type: 'bytes32', indexed: false }] },
]

// ---- env / clients ----------------------------------------------------------------------------

/** Load .env.local from the repo root without a dependency. Never logs values. */
export function loadEnv() {
  for (const f of ['.env.local', '.env']) {
    try {
      for (const line of readFileSync(join(ROOT, f), 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
        }
      }
    } catch {
      /* optional */
    }
  }
}

export const DEFAULT_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'

export function clients({ requireKey = true } = {}) {
  loadEnv()
  const rpc = process.env.RPC_URL || DEFAULT_RPC
  // A fork (anvil) reports the Sepolia chain id, so the same chain object is correct there.
  const transport = http(rpc)
  const publicClient = createPublicClient({ chain: sepolia, transport })
  if (!requireKey) return { publicClient, rpc }

  const pk = process.env.PRIVATE_KEY
  if (!pk) {
    throw new Error(
      'PRIVATE_KEY is not set. Put it in .env.local at the repo root (gitignored) or pass it inline:\n' +
        '  PRIVATE_KEY=0x... node scripts/ens/deploy.mjs',
    )
  }
  const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`)
  const walletClient = createWalletClient({ account, chain: sepolia, transport })
  return { publicClient, walletClient, account, rpc }
}

// ---- helpers ----------------------------------------------------------------------------------

export const contracts = (publicClient, walletClient) => ({
  registrar: getContract({ address: ENS.ethRegistrar, abi: ethRegistrarAbi, client: { public: publicClient, wallet: walletClient } }),
  ethRegistry: getContract({ address: ENS.ethRegistry, abi: registryAbi, client: { public: publicClient, wallet: walletClient } }),
  factory: getContract({ address: ENS.verifiableFactory, abi: factoryAbi, client: { public: publicClient, wallet: walletClient } }),
  usdc: getContract({ address: ENS.mockUSDC, abi: erc20Abi, client: { public: publicClient, wallet: walletClient } }),
})

/** namehash of a subname, computed the way the contract does it. */
export const subnode = (parent, label) =>
  keccak256(encodePacked(['bytes32', 'bytes32'], [namehash(parent), keccak256(stringToHex(label))]))

/** DNS-encode a name for the resolver's `toName` arguments. */
export function dnsEncode(name) {
  let out = '0x'
  for (const part of name.split('.').filter(Boolean)) {
    const bytes = new TextEncoder().encode(part)
    out += bytes.length.toString(16).padStart(2, '0')
    for (const b of bytes) out += b.toString(16).padStart(2, '0')
  }
  return out + '00'
}


// Canonical, shared with the app and the relayer — see shared/ticket.mjs.
export { ticketMessage, claimScope } from '../../../shared/ticket.mjs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const fmt = {
  usdc: (v) => `${(Number(v) / 1e6).toFixed(6)} USDC`,
  addr: (a) => (a ? `${a.slice(0, 10)}…${a.slice(-6)}` : '—'),
}

let step = 0
export const log = {
  step: (msg) => console.log(`\n\x1b[1m[${++step}] ${msg}\x1b[0m`),
  info: (msg) => console.log(`    ${msg}`),
  ok: (msg) => console.log(`    \x1b[32m✓\x1b[0m ${msg}`),
  skip: (msg) => console.log(`    \x1b[90m·\x1b[0m ${msg} \x1b[90m(already done)\x1b[0m`),
  warn: (msg) => console.log(`    \x1b[33m!\x1b[0m ${msg}`),
  tx: (hash) => console.log(`    \x1b[90m  ${hash}\x1b[0m`),
}

/**
 * Fees with a floor on the tip. Public Sepolia RPCs sometimes suggest a ZERO priority fee, and a
 * zero-tip tx can sit in the mempool forever. MIN_TIP_GWEI (default 1) is the floor.
 */
export async function fees(publicClient, bump = 1) {
  const floor = BigInt(Math.round(Number(process.env.MIN_TIP_GWEI ?? 1) * 1e9))
  const block = await publicClient.getBlock()
  const base = block.baseFeePerGas ?? 1_000_000_000n
  let tip = 0n
  try { tip = await publicClient.estimateMaxPriorityFeePerGas() } catch { /* fall to floor */ }
  if (tip < floor) tip = floor
  const k = BigInt(Math.round(bump * 1000))
  tip = (tip * k) / 1000n
  const maxFeePerGas = ((base * 2n + tip) * k) / 1000n
  return { maxFeePerGas, maxPriorityFeePerGas: tip }
}

/**
 * Send raw calldata and wait. If it is not mined within `timeoutMs`, REPLACE it at the same nonce
 * with +30% fees (never a second tx at a new nonce — that is how a stuck tx becomes a double spend).
 */
export async function sendTx(publicClient, walletClient, { to, data, value }, label, { timeoutMs = 150_000, tries = 4 } = {}) {
  const account = walletClient.account
  const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
  const est = await publicClient.estimateGas({ account, to, data, value })
  const gas = (est * 125n) / 100n + 20_000n
  const hashes = []
  let bump = 1
  for (let i = 0; i < tries; i++) {
    const f = await fees(publicClient, bump)
    const hash = await walletClient.sendTransaction({ account, to, data, value, gas, nonce, ...f, chain: walletClient.chain })
    hashes.push(hash)
    log.tx(`${hash}${i ? ` (replacement #${i}, tip ${Number(f.maxPriorityFeePerGas) / 1e9} gwei)` : ''}`)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      for (const h of hashes) {
        const r = await publicClient.getTransactionReceipt({ hash: h }).catch(() => null)
        if (r) {
          if (r.status !== 'success') throw new Error(`${label} reverted (tx ${h})`)
          return r
        }
      }
      // Our nonce consumed by some OTHER tx (e.g. mined replacement we lost track of)?
      const latest = await publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' })
      if (latest > nonce) {
        await sleep(4000)
        for (const h of hashes) {
          const r = await publicClient.getTransactionReceipt({ hash: h }).catch(() => null)
          if (r) { if (r.status !== 'success') throw new Error(`${label} reverted (tx ${h})`); return r }
        }
        throw new Error(`${label}: nonce ${nonce} was consumed by a tx we did not send — stop and inspect`)
      }
      await sleep(4000)
    }
    log.warn(`${label}: not mined after ${timeoutMs / 1000}s — replacing at nonce ${nonce}`)
    bump *= 1.3
  }
  throw new Error(`${label}: still unmined after ${tries} attempts (hashes ${hashes.join(', ')})`)
}

/** Send a simulated contract request and wait, with a readable failure (fee floor + replace-by-nonce). */
export async function send(publicClient, walletClient, request, label) {
  const data = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args })
  return sendTx(publicClient, walletClient, { to: request.address, data, value: request.value }, label)
}
