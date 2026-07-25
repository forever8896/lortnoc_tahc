// Live-backend config. ENS v2 on Sepolia (pinned 2026-06-29 deployment, CLAUDE.md §6.5)
// + Sui/Walrus/Seal testnet. Addresses verified against ensdomains/contracts-v2; still
// eth_getCode them before trusting a run.

export const ENS = {
  chainId: 11155111, // Sepolia
  rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
  parent: 'lortnoc.eth', // must be registered day-0 (see docs/LIVE-SETUP.md)
  // pinned deployment tag sepolia-deployment-2026-06-29
  permissionedResolverImpl: '0x7e4b2d59938930168024201752ee5503df402303',
  verifiableFactory: '0x118bc31a50d559f7015a8da26d54b3b030cdb70f',
  ethRegistry: '0x67b728a792e789a8978b30cf1b3b641f19354b43',
  ethRegistrar: '0xa4449a0dd2b83007553d9b1d28b583a46a805a30',
  universalResolver: '0x85edf8b6b7d4211e2b07aa687506b746357b92cf',
  userRegistryImpl: '0x840fa461059862ea466a711e8c98c8de732061c0',
} as const

// Set after day-0 setup (deploy LortnocRegistry + our resolver under lortnoc.eth).
// Until these are filled in, claim() throws a clear "setup not done" error.
export const LORTNOC = {
  registry: (import.meta.env.VITE_LORTNOC_REGISTRY as string) || '',
  resolver: (import.meta.env.VITE_LORTNOC_RESOLVER as string) || '', // shared resolver, or per-user proxy factory
} as const

export const SUI = {
  network: 'testnet' as const,
  rpc: 'https://fullnode.testnet.sui.io:443',
  // Set after `sui client publish` of contracts/move (ConversationHead + seal_approve).
  packageId: (import.meta.env.VITE_SUI_PACKAGE as string) || '',
  // Seal key servers (testnet) — fill from @mysten/seal testnet config.
  sealKeyServers: (import.meta.env.VITE_SEAL_SERVERS as string)?.split(',').filter(Boolean) || [],
} as const

// ENS text-record keys (§5.4)
export const REC = {
  pubkey: 'eth.lortnoc.pubkey',
  walrus: 'eth.lortnoc.walrus',
  inbox: 'eth.lortnoc.inbox',
} as const

export function assertEnsSetup(): void {
  if (!LORTNOC.resolver)
    throw new Error(
      'ENS live setup not done: register lortnoc.eth + deploy the resolver, then set VITE_LORTNOC_RESOLVER (see docs/LIVE-SETUP.md).',
    )
}
export function assertSuiSetup(): void {
  if (!SUI.packageId)
    throw new Error('Sui live setup not done: publish contracts/move and set VITE_SUI_PACKAGE (see docs/LIVE-SETUP.md).')
}
