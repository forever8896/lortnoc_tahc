#!/usr/bin/env node
// Day-0 ENS v2 setup for lortnoc_tahc, on Sepolia. Idempotent: safe to re-run after a failure,
// it skips whatever is already on-chain. Writes the resulting addresses into
// app/src/lib/live/ens-deployment.json, which is what switches the app's live mode on.
//
//   PRIVATE_KEY=0x... node scripts/ens/deploy.mjs          (or put PRIVATE_KEY in .env.local)
//   RPC_URL=http://127.0.0.1:8545 node scripts/ens/deploy.mjs --yes    (anvil fork dry-run)
//
// What it does:
//   1. preflight — the pinned ENS v2 addresses still have code, wallet is funded
//   2. mint MockUSDC (the .eth registrar is priced in an ERC-20, not ETH)
//   3. deploy LortnocRegistry — a UserRegistry proxy from the canonical VerifiableFactory
//   4. register lortnoctahc.eth (commit → wait 60s → reveal), subregistry = LortnocRegistry
//   5. register lortnoc.eth   — reserved, so the eth.lortnoc.* record namespace is ours
//   6. deploy LortnocRegistrar and give it ROLE_REGISTRAR, so any wallet can claim a handle
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { encodeFunctionData, keccak256, namehash, stringToHex, toHex, parseAbi } from 'viem'
import {
  ROOT, ENS, PARENT_NAME, PARENT_LABEL, RESERVED_NAME, RESERVED_LABEL,
  ALL_ROLES, ROLE_REGISTRAR, ROLE_REGISTRAR_ADMIN,
  registryAbi, factoryAbi, erc20Abi, ethRegistrarAbi, registrarAbi,
  clients, contracts, readDeployment, writeDeployment, send, sleep, log, fmt,
} from './lib/ens.mjs'

const args = process.argv.slice(2)
const YES = args.includes('--yes') || args.includes('-y')
const SKIP_RESERVED = args.includes('--skip-reserved')
/** Dry-run against an `anvil --fork-url <sepolia>` node: lets us warp past the commitment wait. */
const FORK = args.includes('--fork')

const DURATION = 31536000n // 1 year
const REGISTRY_SALT = keccak256(stringToHex('lortnoc/registry/v1'))
// Resume file: the commit-reveal secret must survive a crash between the two txs.
const STATE_PATH = join(ROOT, 'scripts', 'ens', '.deploy-state.json')
const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {}
const saveState = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n')

const ARTIFACT = join(ROOT, 'contracts', 'out', 'LortnocRegistrar.sol', 'LortnocRegistrar.json')

async function main() {
  const { publicClient, walletClient, account, rpc } = clients()
  const c = contracts(publicClient, walletClient)
  const deployment = readDeployment()

  console.log(`\n\x1b[1mlortnoc_tahc — ENS v2 day-0 setup\x1b[0m`)
  console.log(`  rpc      ${rpc}`)
  console.log(`  deployer ${account.address}`)
  console.log(`  parent   ${PARENT_NAME}   reserved ${RESERVED_NAME}`)

  // ---- 1. preflight ---------------------------------------------------------------------------
  log.step('Preflight — pinned ENS v2 addresses and wallet')
  const chainId = await publicClient.getChainId()
  if (chainId !== deployment.chainId) {
    throw new Error(`chain id ${chainId} != expected ${deployment.chainId} (wrong RPC?)`)
  }
  for (const [name, address] of Object.entries(ENS)) {
    const code = await publicClient.getBytecode({ address })
    if (!code || code === '0x') {
      throw new Error(
        `${name} (${address}) has no code on chain ${chainId}. The pinned deployment ` +
          `${deployment.tag} may have rotated — re-check contracts/deployments/sepolia.`,
      )
    }
  }
  log.ok(`${Object.keys(ENS).length} contracts verified at tag ${deployment.tag}`)

  const balance = await publicClient.getBalance({ address: account.address })
  log.info(`ETH balance ${(Number(balance) / 1e18).toFixed(4)}`)
  if (balance < 10n ** 16n) throw new Error('wallet has < 0.01 ETH — top up before deploying')

  const [basePrice, premium] = await c.registrar.read.getRegisterPrice([PARENT_LABEL, DURATION, ENS.mockUSDC])
  const price = basePrice + premium
  log.info(`registration price ${fmt.usdc(price)} / year / name`)

  if (!YES) {
    console.log(`\n  This spends real Sepolia gas from ${account.address}.`)
    console.log(`  Re-run with --yes to proceed.\n`)
    process.exit(0)
  }

  // ---- 2. MockUSDC ----------------------------------------------------------------------------
  log.step('MockUSDC — the .eth registrar is ERC-20 priced')
  const needed = price * (SKIP_RESERVED ? 1n : 2n) * 2n // 2x headroom
  let usdc = await c.usdc.read.balanceOf([account.address])
  if (usdc < needed) {
    const { request } = await publicClient.simulateContract({
      account, address: ENS.mockUSDC, abi: erc20Abi, functionName: 'mint',
      args: [account.address, needed],
    })
    await send(publicClient, walletClient, request, 'mint')
    usdc = await c.usdc.read.balanceOf([account.address])
    log.ok(`minted → balance ${fmt.usdc(usdc)}`)
  } else {
    log.skip(`balance ${fmt.usdc(usdc)}`)
  }

  const allowance = await c.usdc.read.allowance([account.address, ENS.ethRegistrar])
  if (allowance < needed) {
    const { request } = await publicClient.simulateContract({
      account, address: ENS.mockUSDC, abi: erc20Abi, functionName: 'approve',
      args: [ENS.ethRegistrar, needed * 10n],
    })
    await send(publicClient, walletClient, request, 'approve')
    log.ok('registrar approved to spend USDC')
  } else {
    log.skip('registrar already approved')
  }

  // ---- 3. LortnocRegistry (UserRegistry proxy) -------------------------------------------------
  log.step('LortnocRegistry — UserRegistry proxy via VerifiableFactory')
  let registryAddr = deployment.lortnoc.registry
  if (registryAddr && (await publicClient.getBytecode({ address: registryAddr }))) {
    log.skip(`at ${registryAddr}`)
  } else {
    const initData = encodeFunctionData({
      abi: registryAbi, functionName: 'initialize', args: [account.address, ALL_ROLES],
    })
    const { result, request } = await publicClient.simulateContract({
      account, address: ENS.verifiableFactory, abi: factoryAbi, functionName: 'deployProxy',
      args: [ENS.userRegistryImpl, BigInt(REGISTRY_SALT), initData],
    })
    registryAddr = result
    await send(publicClient, walletClient, request, 'deployProxy(UserRegistry)')
    const impl = await publicClient.readContract({
      address: ENS.verifiableFactory, abi: factoryAbi, functionName: 'verifyContract', args: [registryAddr],
    })
    if (impl.toLowerCase() !== ENS.userRegistryImpl.toLowerCase()) {
      throw new Error(`verifyContract mismatch: ${impl} != ${ENS.userRegistryImpl}`)
    }
    log.ok(`deployed ${registryAddr} (verifyContract → UserRegistryImpl ✓)`)
    deployment.lortnoc.registry = registryAddr
    writeDeployment(deployment)
  }

  // ---- 4/5. register the .eth names ------------------------------------------------------------
  const ZERO = '0x0000000000000000000000000000000000000000'
  const registerName = async (label, subregistry) => {
    log.step(`Register ${label}.eth` + (subregistry === ZERO ? ' (reserved)' : ` → subregistry ${fmt.addr(subregistry)}`))
    const owner = await c.ethRegistry.read.findOwner([label])
    if (owner !== '0x0000000000000000000000000000000000000000') {
      if (owner.toLowerCase() !== account.address.toLowerCase()) {
        throw new Error(`${label}.eth is owned by ${owner}, not us — pick another name`)
      }
      log.skip(`already owned by ${fmt.addr(owner)}`)
      return
    }

    const key = `commit:${label}`
    let secret = state[key]?.secret
    if (!secret) {
      secret = toHex(crypto.getRandomValues(new Uint8Array(32)))
      state[key] = { secret }
      saveState()
    }

    const commitment = await c.registrar.read.makeCommitment([
      label, account.address, secret, subregistry, '0x0000000000000000000000000000000000000000',
      DURATION, '0x0000000000000000000000000000000000000000000000000000000000000000',
    ])

    let committedAt = await c.registrar.read.commitmentAt([commitment])
    if (committedAt === 0n) {
      const { request } = await publicClient.simulateContract({
        account, address: ENS.ethRegistrar, abi: ethRegistrarAbi, functionName: 'commit', args: [commitment],
      })
      await send(publicClient, walletClient, request, 'commit')
      committedAt = await c.registrar.read.commitmentAt([commitment])
      log.ok(`committed at ${committedAt}`)
    } else {
      log.skip(`commitment exists (t=${committedAt})`)
    }

    const minAge = await c.registrar.read.MIN_COMMITMENT_AGE()
    const readyAt = Number(committedAt + minAge)
    for (;;) {
      const now = Number((await publicClient.getBlock()).timestamp)
      if (now >= readyAt) break
      const wait = readyAt - now + 2
      if (FORK) {
        // Anvil only stamps a new block when one is mined, so real sleeping never advances it.
        await publicClient.request({ method: 'evm_increaseTime', params: [`0x${wait.toString(16)}`] })
        await publicClient.request({ method: 'evm_mine', params: [] })
        log.info(`fork: warped ${wait}s past the commitment age`)
      } else {
        log.info(`waiting ${wait}s for the commitment to mature…`)
        await sleep(wait * 1000)
      }
    }

    const { request } = await publicClient.simulateContract({
      account, address: ENS.ethRegistrar, abi: ethRegistrarAbi, functionName: 'register',
      args: [
        label, account.address, secret, subregistry, '0x0000000000000000000000000000000000000000',
        DURATION, ENS.mockUSDC, '0x0000000000000000000000000000000000000000000000000000000000000000',
      ],
    })
    await send(publicClient, walletClient, request, 'register')
    delete state[key]
    saveState()
    log.ok(`${label}.eth registered to ${fmt.addr(account.address)}`)
  }

  await registerName(PARENT_LABEL, registryAddr)
  if (!SKIP_RESERVED) {
    await registerName(RESERVED_LABEL, '0x0000000000000000000000000000000000000000')
  }

  // ---- 6. wire the hierarchy -------------------------------------------------------------------
  log.step(`Slot LortnocRegistry under ${PARENT_NAME}`)
  const sub = await c.ethRegistry.read.getSubregistry([PARENT_LABEL])
  if (sub.toLowerCase() === registryAddr.toLowerCase()) {
    log.skip(`${PARENT_NAME} → ${fmt.addr(registryAddr)}`)
  } else {
    const tokenId = await c.ethRegistry.read.findTokenId([PARENT_LABEL])
    const { request } = await publicClient.simulateContract({
      account, address: ENS.ethRegistry, abi: registryAbi, functionName: 'setSubregistry',
      args: [tokenId, registryAddr],
    })
    await send(publicClient, walletClient, request, 'setSubregistry')
    log.ok(`${PARENT_NAME} → ${registryAddr}`)
  }

  // Make the registry self-describing so getParent() answers correctly.
  const [parentAddr] = await publicClient.readContract({
    address: registryAddr, abi: registryAbi, functionName: 'getParent',
  })
  if (parentAddr.toLowerCase() !== ENS.ethRegistry.toLowerCase()) {
    const { request } = await publicClient.simulateContract({
      account, address: registryAddr, abi: registryAbi, functionName: 'setParent',
      args: [ENS.ethRegistry, PARENT_LABEL],
    })
    await send(publicClient, walletClient, request, 'setParent')
    log.ok(`registry.getParent() → ETHRegistry / ${PARENT_LABEL}`)
  } else {
    log.skip('registry parent already set')
  }

  // ---- 7. LortnocRegistrar ---------------------------------------------------------------------
  log.step('LortnocRegistrar — permissionless handle issuance')
  let registrarAddr = deployment.lortnoc.registrar
  if (registrarAddr && (await publicClient.getBytecode({ address: registrarAddr }))) {
    log.skip(`at ${registrarAddr}`)
  } else {
    if (!existsSync(ARTIFACT)) throw new Error(`build the contract first: (cd contracts && forge build)`)
    const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'))
    const hash = await walletClient.deployContract({
      abi: parseAbi([
        'constructor(address registry, address factory, address resolverImpl, bytes32 parentNode, address owner)',
      ]),
      bytecode: artifact.bytecode.object,
      args: [registryAddr, ENS.verifiableFactory, ENS.permissionedResolverImpl, namehash(PARENT_NAME), account.address],
    })
    log.tx(hash)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error('LortnocRegistrar deploy reverted')
    registrarAddr = receipt.contractAddress
    log.ok(`deployed ${registrarAddr}`)
    deployment.lortnoc.registrar = registrarAddr
    writeDeployment(deployment)
  }

  log.step('Grant ROLE_REGISTRAR to LortnocRegistrar')
  const roles = ROLE_REGISTRAR | ROLE_REGISTRAR_ADMIN
  const hasRole = await publicClient.readContract({
    address: registryAddr, abi: registryAbi, functionName: 'hasRootRoles', args: [roles, registrarAddr],
  })
  if (hasRole) {
    log.skip('registrar already holds ROLE_REGISTRAR')
  } else {
    const { request } = await publicClient.simulateContract({
      account, address: registryAddr, abi: registryAbi, functionName: 'grantRootRoles',
      args: [roles, registrarAddr],
    })
    await send(publicClient, walletClient, request, 'grantRootRoles')
    log.ok('LortnocRegistrar may now issue subnames — and nothing else')
  }

  // ---- done ------------------------------------------------------------------------------------
  deployment.lortnoc.deployedAt = new Date().toISOString()
  deployment.lortnoc.deployer = account.address
  writeDeployment(deployment)

  const openToAll = await publicClient.readContract({
    address: registrarAddr, abi: registrarAbi, functionName: 'available', args: ['satoshi'],
  })

  console.log(`\n\x1b[1m\x1b[32mDay-0 complete.\x1b[0m`)
  console.log(`  parent      ${PARENT_NAME}`)
  console.log(`  registry    ${registryAddr}`)
  console.log(`  registrar   ${registrarAddr}`)
  console.log(`  claimable   ${openToAll ? 'yes — any wallet can claim a handle' : 'NO (check gate/roles)'}`)
  console.log(`\n  Written to app/src/lib/live/ens-deployment.json — the app's live mode is now armed.`)
  console.log(`  Next: node scripts/ens/claim.mjs <handle>   (or run the app with ?live)\n`)
}

main().catch((e) => {
  console.error(`\n\x1b[31merror:\x1b[0m ${e.shortMessage || e.message}`)
  if (e.metaMessages) console.error(e.metaMessages.join('\n'))
  process.exit(1)
})
