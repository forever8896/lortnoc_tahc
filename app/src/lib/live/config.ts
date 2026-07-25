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
  deployedAt: deployment.lortnoc.deployedAt,
} as const

export const SUI = {
  network: 'testnet' as const,
  rpc: 'https://fullnode.testnet.sui.io:443',
  // Set after `sui client publish` of contracts/move (ConversationHead + seal_approve).
  packageId: (import.meta.env.VITE_SUI_PACKAGE as string) || '',
  // Seal key servers (testnet) — fill from @mysten/seal testnet config.
  sealKeyServers: (import.meta.env.VITE_SEAL_SERVERS as string)?.split(',').filter(Boolean) || [],
} as const

/** ENS text-record keys (§5.4). */
export const REC = {
  pubkey: 'eth.lortnoc.pubkey',
  walrus: 'eth.lortnoc.walrus',
  inbox: 'eth.lortnoc.inbox',
  discoverable: 'eth.lortnoc.discoverable',
} as const

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
