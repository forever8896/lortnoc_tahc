#!/usr/bin/env node
// Bridge native ETH → native 0G through LI.FI, from the CLI.
//
//   PRIVATE_KEY=0x… node scripts/ens/bridge.mjs --amount 0.0035 [--from 1]
//
// Same API and the same route the app's Membership screen puts users through, so running this
// is a live rehearsal of the user-facing bridge rather than a separate code path.
import { createPublicClient, createWalletClient, http, defineChain, formatEther, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet, base, arbitrum, optimism } from 'viem/chains'
import { loadEnv, log } from './lib/ens.mjs'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1] }
const AMOUNT = parseEther(argOf('amount', '0.0035'))
const FROM_CHAIN = Number(argOf('from', '1'))
const YES = args.includes('--yes') || args.includes('-y')

const CHAINS = { 1: mainnet, 8453: base, 42161: arbitrum, 10: optimism }
const chain = CHAINS[FROM_CHAIN]
if (!chain) throw new Error(`unsupported source chain ${FROM_CHAIN}`)

const zeroG = defineChain({
  id: 16661, name: '0G',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: { default: { http: ['https://evmrpc.0g.ai'] } },
})

loadEnv()
const account = privateKeyToAccount(process.env.PRIVATE_KEY)
const src = createPublicClient({ chain, transport: http() })
const wallet = createWalletClient({ account, chain, transport: http() })
const dst = createPublicClient({ chain: zeroG, transport: http(zeroG.rpcUrls.default.http[0]) })

console.log(`\n\x1b[1mLI.FI bridge → 0G\x1b[0m`)
console.log(`  from    ${chain.name} (${chain.id})`)
console.log(`  account ${account.address}`)
console.log(`  amount  ${formatEther(AMOUNT)} ETH`)

const before = await dst.getBalance({ address: account.address })
log.info(`0G balance before: ${formatEther(before)} 0G`)

log.step('Quote')
const url =
  `https://li.quest/v1/quote?fromChain=${FROM_CHAIN}&toChain=16661` +
  `&fromToken=0x0000000000000000000000000000000000000000` +
  `&toToken=0x0000000000000000000000000000000000000000` +
  `&fromAmount=${AMOUNT}&fromAddress=${account.address}`
const quote = await (await fetch(url)).json()
if (quote.message) throw new Error(`no route: ${quote.message}`)

const e = quote.estimate
const gasUsd = (e.gasCosts ?? []).reduce((s, g) => s + Number(g.amountUSD ?? 0), 0)
log.ok(`${quote.tool}: ${formatEther(AMOUNT)} ETH ($${Number(e.fromAmountUSD).toFixed(2)}) → ` +
       `${(Number(e.toAmount) / 1e18).toFixed(3)} 0G ($${Number(e.toAmountUSD).toFixed(2)})`)
log.info(`~${e.executionDuration}s · gas ≈ $${gasUsd.toFixed(2)}`)

if (!YES) {
  console.log(`\n  Re-run with --yes to send.\n`)
  process.exit(0)
}

log.step('Send')
const t = quote.transactionRequest
const hash = await wallet.sendTransaction({
  account, to: t.to, data: t.data, value: BigInt(t.value),
  gas: t.gasLimit ? BigInt(t.gasLimit) : undefined,
})
log.tx(hash)
const receipt = await src.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success') throw new Error('source transaction reverted')
log.ok(`confirmed on ${chain.name} — now waiting for 0G to credit`)

log.step('Wait for delivery')
// The source tx confirming is NOT the finish line; funds land on 0G a few seconds later.
const started = Date.now()
for (;;) {
  const s = await (
    await fetch(`https://li.quest/v1/status?txHash=${hash}&fromChain=${FROM_CHAIN}&toChain=16661`)
  ).json().catch(() => ({}))
  const elapsed = Math.round((Date.now() - started) / 1000)
  const now = await dst.getBalance({ address: account.address })

  if (now > before) {
    log.ok(`delivered after ${elapsed}s — received ${formatEther(now - before)} 0G`)
    console.log(`\n\x1b[32m0G balance: ${formatEther(now)} 0G\x1b[0m\n`)
    break
  }
  if (s.status === 'FAILED') throw new Error('bridge reported FAILED')
  if (elapsed > 600) throw new Error('timed out after 10 minutes — check li.fi/scan')
  log.info(`${s.status ?? 'PENDING'} — ${elapsed}s`)
  await new Promise((r) => setTimeout(r, 5000))
}
