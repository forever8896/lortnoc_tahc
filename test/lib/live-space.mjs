// LIVE helper: buy a fresh ENS space on Sepolia (deployer pays 0.005 Sepolia ETH) and have the relayer
// create <label>.space.lortnoctahc.eth. The owner key is new and returned — never written anywhere.
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export async function buyLiveSpace({ prefix = 'live', token: tokenIn, relayer = process.env.RELAYER ?? 'https://lortnoc-relayer.fly.dev' } = {}) {
  const viem = await import('../../gate/node_modules/viem/_esm/index.js')
  const accounts = await import('../../gate/node_modules/viem/_esm/accounts/index.js')
  const { clients, sendTx, readDeployment } = await import('../../scripts/ens/lib/ens.mjs')
  const S = readDeployment().lortnoc.spaces
  const SPACES = JSON.parse(readFileSync(join(ROOT, 'app/src/lib/live/spaces-deployment.json'), 'utf8')).sepolia.address
  const { publicClient: pc, walletClient: deployer } = clients()
  const label = `${prefix}-${Math.random().toString(36).slice(2, 8)}`
  const ownerPriv = accounts.generatePrivateKey()
  const owner = accounts.privateKeyToAccount(ownerPriv)
  const token = tokenIn ?? `eip155:11155111/erc721:${S.demoPass.toLowerCase()}`
  const abi = viem.parseAbi(['function buySpace(string,address,bytes32) payable returns (uint256)', 'function price() view returns (uint256)'])
  const price = await pc.readContract({ address: SPACES, abi, functionName: 'price' })
  const rules = viem.keccak256(viem.stringToHex(`lortnoc/space/rules/v1|${token}`))
  const buy = await sendTx(pc, deployer, { to: SPACES, value: price, data: viem.encodeFunctionData({ abi, functionName: 'buySpace', args: [label, owner.address, rules] }) }, 'buySpace')
  let made
  for (let i = 0; i < 20 && !made?.name; i++) {
    made = await fetch(`${relayer}/space`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chainId: 11155111, txHash: buy.transactionHash, label, token }) }).then((r) => r.json()).catch(() => null)
    if (!made?.name) await new Promise((r) => setTimeout(r, 6000))
  }
  if (!made?.name) throw new Error(`relayer did not create the space: ${JSON.stringify(made)}`)
  return { label, ownerPriv, owner, token, name: made.name }
}
