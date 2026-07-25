#!/usr/bin/env node
// Send ETH on Ethereum Sepolia from a private key you supply at runtime.
//
//   PRIVATE_KEY=0x... node send-sepolia.mjs --amount 0.9
//   PRIVATE_KEY=0x... node send-sepolia.mjs --all           # sweep everything minus gas
//   PRIVATE_KEY=0x... node send-sepolia.mjs --amount 0.9 --to 0xabc... --yes
//
// The key is read from the PRIVATE_KEY env var (or a --key flag, which is
// discouraged — it lands in your shell history and in `ps`). It is never
// written to disk and never leaves this process except as a local signature.

import { ethers } from 'ethers'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

const DEFAULT_TO = '0x61eE2fBcf2841d9094e2D42406Dd4f83a7981Bb8'
const DEFAULT_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
const SEPOLIA_CHAIN_ID = 11155111n

// ---- args ------------------------------------------------------------------

function parseArgs(argv) {
  const out = { yes: false, all: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--yes' || a === '-y') out.yes = true
    else if (a === '--all') out.all = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a.startsWith('--')) {
      const [flag, inline] = a.split('=')
      const key = flag.slice(2)
      const val = inline !== undefined ? inline : argv[++i]
      if (val === undefined) fail(`flag ${flag} needs a value`)
      out[key] = val
    } else fail(`unexpected argument: ${a}`)
  }
  return out
}

function fail(msg) {
  console.error(`error: ${msg}`)
  process.exit(1)
}

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  console.log(`
send-sepolia — move ETH out of a wallet on Ethereum Sepolia

  PRIVATE_KEY=0x...  node send-sepolia.mjs --amount 0.9
  PRIVATE_KEY=0x...  node send-sepolia.mjs --all

Flags
  --amount <eth>   amount to send, in ETH (e.g. 0.9)
  --all            send the entire balance minus the gas cost of this tx
  --to <address>   recipient (default ${DEFAULT_TO})
  --rpc <url>      Sepolia RPC (default ${DEFAULT_RPC}, or RPC_URL env)
  --key <0x...>    private key (prefer the PRIVATE_KEY env var instead)
  --yes, -y        skip the confirmation prompt
`)
  process.exit(0)
}

const rawKey = process.env.PRIVATE_KEY || args.key
if (!rawKey) fail('no private key — set PRIVATE_KEY=0x... in the environment (or pass --key)')
if (args.key) console.warn('warning: --key puts your private key in shell history and `ps`; PRIVATE_KEY env is safer\n')

const privateKey = rawKey.trim().startsWith('0x') ? rawKey.trim() : `0x${rawKey.trim()}`
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) fail('private key must be 32 bytes of hex (64 hex chars, 0x optional)')

if (!args.all && !args.amount) fail('specify --amount <eth> or --all')
if (args.all && args.amount) fail('use either --amount or --all, not both')

const to = ethers.getAddress(args.to || DEFAULT_TO)
const rpcUrl = args.rpc || process.env.RPC_URL || DEFAULT_RPC

// ---- send ------------------------------------------------------------------

const provider = new ethers.JsonRpcProvider(rpcUrl)
const wallet = new ethers.Wallet(privateKey, provider)

const net = await provider.getNetwork()
if (net.chainId !== SEPOLIA_CHAIN_ID) {
  fail(`RPC is chain ${net.chainId}, expected Sepolia (${SEPOLIA_CHAIN_ID}) — check --rpc`)
}

const balance = await provider.getBalance(wallet.address)
const fee = await provider.getFeeData()

// Pad the priority fee a little so the tx doesn't sit in the mempool on a busy testnet.
const maxPriorityFeePerGas = (fee.maxPriorityFeePerGas ?? ethers.parseUnits('1', 'gwei'))
const baseFee = fee.maxFeePerGas ?? ethers.parseUnits('20', 'gwei')
const maxFeePerGas = baseFee + maxPriorityFeePerGas

const gasLimit = 21000n                      // plain ETH transfer to an EOA
const maxGasCost = gasLimit * maxFeePerGas   // worst case; the refund of unused basefee comes back

const value = args.all ? balance - maxGasCost : ethers.parseEther(String(args.amount))

console.log(`network   Sepolia (${net.chainId})`)
console.log(`rpc       ${rpcUrl}`)
console.log(`from      ${wallet.address}`)
console.log(`to        ${to}`)
console.log(`balance   ${ethers.formatEther(balance)} ETH`)
console.log(`sending   ${ethers.formatEther(value)} ETH`)
console.log(`max gas   ${ethers.formatEther(maxGasCost)} ETH (${gasLimit} @ ${ethers.formatUnits(maxFeePerGas, 'gwei')} gwei)`)

if (value <= 0n) fail('nothing to send — balance does not cover the gas cost')
if (value + maxGasCost > balance) {
  fail(`insufficient funds: need ${ethers.formatEther(value + maxGasCost)} ETH (amount + max gas), have ${ethers.formatEther(balance)} ETH`)
}

if (!args.yes) {
  const rl = createInterface({ input: stdin, output: stdout })
  const answer = await rl.question('\nsend? type "yes" to confirm: ')
  rl.close()
  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('aborted — nothing was sent')
    process.exit(0)
  }
}

const tx = await wallet.sendTransaction({
  to,
  value,
  gasLimit,
  maxFeePerGas,
  maxPriorityFeePerGas,
  chainId: SEPOLIA_CHAIN_ID,
})

console.log(`\nsent      ${tx.hash}`)
console.log(`explorer  https://sepolia.etherscan.io/tx/${tx.hash}`)
console.log('waiting for 1 confirmation…')

const receipt = await tx.wait(1)
if (receipt.status !== 1) fail(`transaction reverted in block ${receipt.blockNumber}`)

const after = await provider.getBalance(wallet.address)
console.log(`confirmed in block ${receipt.blockNumber} · gas used ${receipt.gasUsed}`)
console.log(`remaining ${ethers.formatEther(after)} ETH in ${wallet.address}`)
