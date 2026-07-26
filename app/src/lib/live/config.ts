// Live-backend config. ENS v2 on Sepolia (pinned deployment, CLAUDE.md §6.5) + Sui/Walrus/Seal
// testnet.
//
// Addresses are NOT hardcoded here — they come from ens-deployment.json, the single source of
// truth shared with the day-0 CLI (scripts/ens). `deploy.mjs` writes our own addresses into it,
// so shipping a live build is "run the script, rebuild" with nothing to copy by hand.
import deployment from './ens-deployment.json'

export const ENS = {
  chainId: deployment.chainId,
  tag: deployment.tag,
  rpc: (import.meta.env.VITE_SEPOLIA_RPC as string) || 'https://ethereum-sepolia-rpc.publicnode.com',
  /** A SEPARATE endpoint for eth_getLogs. The default RPC above answers calls fine but rejects
   *  log queries outright ("Archive requests require a personal token"), and log access is what
   *  lets a fresh browser discover which handle you already own. drpc's free tier serves them,
   *  capped at 10k-block ranges — hence the chunked scan in ens.handleOf(). */
  logsRpc: (import.meta.env.VITE_SEPOLIA_LOGS_RPC as string) || 'https://sepolia.drpc.org',
  /** drpc free-plan ceiling; ranges above this are rejected. */
  logSpan: 9_500n,
  ...deployment.ens,
} as const

export const LORTNOC = {
  /** `lortnoctahc.eth` — handles are issued beneath it. */
  parentName: deployment.lortnoc.parentName,
  /** `lortnoc.eth` — registered to the same owner, which is what makes the
   *  `eth.lortnoc.*` record namespace (§5.4) a name we actually control. */
  reservedName: deployment.lortnoc.reservedName,
  /** UserRegistry proxy slotted under the parent. Serves `<label>` → resolver. */
  registry: deployment.lortnoc.registry as `0x${string}` | '',
  /** Holds ROLE_REGISTRAR; the one-tx claim entrypoint. */
  registrar: deployment.lortnoc.registrar as `0x${string}` | '',
  /** Block the registrar was deployed in — the floor for the HandleClaimed scan that recovers
   *  "which handle is mine" from chain. Without it the scan would walk all of Sepolia. */
  registrarDeployBlock: BigInt(deployment.lortnoc.registrarDeployBlock ?? 0),
  deployedAt: deployment.lortnoc.deployedAt,
} as const

export const SUI = {
  network: 'testnet' as const,
  // NB: https://fullnode.testnet.sui.io:443 now 404s for JSON-RPC (the CLI uses another
  // transport). These public endpoints answer sui_getChainIdentifier -> 4c78adac.
  rpc: (import.meta.env.VITE_SUI_RPC as string) || 'https://sui-testnet-rpc.publicnode.com',
  // Set after `sui client publish` of contracts/move (ConversationHead + seal_approve).
  packageId:
    (import.meta.env.VITE_SUI_PACKAGE as string) ||
    // Published 2026-07-25 (contracts/move: ConversationHead + seal_approve).
    '0xb214da015f1f8f59fb9804f42185782f6f2ce34e398175b060fee266c8074faf',
  /** Walrus storage term for a message blob. */
  epochs: 3,
  /** Mysten's public testnet upload relay. Writing direct to storage nodes fails from most
   *  networks (NotEnoughBlobConfirmations); the relay fans out for us for a small SUI tip. */
  uploadRelay: 'https://upload-relay.testnet.walrus.space',
  /** Max tip in MIST we'll pay the relay per blob (it currently asks 105). */
  uploadRelayMaxTip: 1000,
  /** Read path. The SDK reads slivers direct from storage nodes — the same direct-node access
   *  that already fails for writes — so reads go through an aggregator, which serves the whole
   *  reconstructed blob over HTTP and sets `access-control-allow-origin: *`. More than one,
   *  because a single aggregator being down would otherwise look like an empty conversation. */
  aggregators: (import.meta.env.VITE_WALRUS_AGGREGATORS as string)?.split(',').filter(Boolean) || [
    'https://aggregator.walrus-testnet.walrus.space',
    'https://wal-aggregator-testnet.staketab.org',
    'https://walrus-testnet-aggregator.nodes.guru',
  ],
  // Seal key servers (testnet) — fill from @mysten/seal testnet config.
  sealKeyServers: (import.meta.env.VITE_SEAL_SERVERS as string)?.split(',').filter(Boolean) || [],
} as const

/** Testnet WAL — what Walrus charges for storage. Swap SUI→WAL at stake.walrus.site, or via
 *  the wal_exchange contract (see app/docs/LIVE-SETUP.md). */
export const WAL_COIN_TYPE =
  '0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL'

/** ENS text-record keys (§5.4). */
export const REC = {
  pubkey: 'eth.lortnoc.pubkey',
  walrus: 'eth.lortnoc.walrus',
  inbox: 'eth.lortnoc.inbox',
  discoverable: 'eth.lortnoc.discoverable',
  /** The holder's Sui address — where their ConversationHead objects live, and the address
   *  `seal_approve` / `append` gate on. Published so a peer can address a thread to them. */
  sui: 'eth.lortnoc.sui',
  /** Challenge-gated contact (§6.8): {prompt, salt, kdf} — the QUESTION, never the answer. */
  knock: 'eth.lortnoc.knock',
} as const

/** Every record the owner can publish, in the order the identity panel lists them. `owned` marks
 *  the ones a user edits directly; the rest are written by the app or a delegate. */
export const RECORD_SPECS = [
  { key: REC.pubkey, label: 'pubkey', hint: 'your X25519 messaging key — how people encrypt to you', owned: false },
  { key: REC.sui, label: 'sui', hint: 'storage account that holds your conversation objects', owned: false },
  { key: REC.inbox, label: 'inbox', hint: 'relay pointer — the record you can safely delegate', owned: true },
  { key: REC.walrus, label: 'walrus', hint: 'pointer to your encrypted vault manifest', owned: true },
  { key: REC.discoverable, label: 'discoverable', hint: 'ghost | unlisted | known | searchable | public', owned: true },
  { key: REC.knock, label: 'knock', hint: 'the question strangers must answer to reach you', owned: false },
] as const

/** EAC role bit for `setText` (PermissionedResolverLib.ROLE_SET_TEXT = 1<<4). */
export const ROLE_SET_TEXT = 1n << 4n

/** The address the inbox-delegation demo grants to. Defaults to a burn address: the demo proves
 *  the permission boundary by simulation, so the gateway never needs to hold funds. */
export const GATEWAY_ADDR = ((import.meta.env.VITE_GATEWAY_ADDR as string) ||
  '0x000000000000000000000000000000000000dEaD') as `0x${string}`

export const ensReady = (): boolean => !!LORTNOC.registry && !!LORTNOC.registrar

export function assertEnsSetup(): void {
  if (!ensReady())
    throw new Error(
      'ENS live setup not done. Run: PRIVATE_KEY=0x… node scripts/ens/deploy.mjs --yes ' +
        '(see app/docs/LIVE-SETUP.md), then rebuild.',
    )
}

export function assertSuiSetup(): void {
  if (!SUI.packageId)
    throw new Error('Sui live setup not done: publish contracts/move and set VITE_SUI_PACKAGE (see docs/LIVE-SETUP.md).')
}
