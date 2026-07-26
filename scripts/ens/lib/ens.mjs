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
export const RESERVED_NAME = D.lortnoc.reservedName // lortnoc.eth
export const PARENT_LABEL = PARENT_NAME.split('.')[0]
export const RESERVED_LABEL = RESERVED_NAME.split('.')[0]

// ---- role constants (verbatim from the pinned deployment source) -----------------------------

/** EACBaseRolesLib.ALL_ROLES — bit 0 of every nybble. */
export const ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111n
/** RegistryRolesLib.ROLE_REGISTRAR = 1<<0, admin = role<<128. */
export const ROLE_REGISTRAR = 1n
export const ROLE_REGISTRAR_ADMIN = ROLE_REGISTRAR << 128n
/** RegistryRolesLib.ROLE_SET_SUBREGISTRY = 1<<20, ROLE_SET_RESOLVER = 1<<24. */
export const ROLE_SET_SUBREGISTRY = 1n << 20n
export const ROLE_SET_RESOLVER = 1n << 24n
/** PermissionedResolverLib.ROLE_SET_TEXT = 1<<4. */
export const ROLE_SET_TEXT = 1n << 4n

/** Text record keys (CLAUDE.md §5.4). */
export const REC = {
  pubkey: 'eth.lortnoc.pubkey',
  walrus: 'eth.lortnoc.walrus',
  inbox: 'eth.lortnoc.inbox',
  discoverable: 'eth.lortnoc.discoverable',
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
  { type: 'function', name: 'initialize', stateMutability: 'nonpayable', inputs: [{ name: 'rootAccount', type: 'address' }, { name: 'roleBitmap', type: 'uint256' }], outputs: [] },
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

export const resolverAbi = [
  { type: 'function', name: 'text', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'setText', stateMutability: 'nonpayable', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }, { name: 'value', type: 'string' }], outputs: [] },
  { type: 'function', name: 'authorizeTextRoles', stateMutability: 'nonpayable', inputs: [{ name: 'toName', type: 'bytes' }, { name: 'key', type: 'string' }, { name: 'account', type: 'address' }, { name: 'grant', type: 'bool' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'hasRootRoles', stateMutability: 'view', inputs: [{ name: 'roleBitmap', type: 'uint256' }, { name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'hasRoles', stateMutability: 'view', inputs: [{ name: 'resource', type: 'uint256' }, { name: 'roleBitmap', type: 'uint256' }, { name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
]

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

/** Send a tx and wait, with a readable failure. */
export async function send(publicClient, walletClient, request, label) {
  const hash = await walletClient.writeContract(request)
  log.tx(hash)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${label} reverted (tx ${hash})`)
  return receipt
}
