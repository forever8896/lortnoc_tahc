#!/usr/bin/env node
// Read-only health check for the live ENS layer. No key needed. Run it before EVERY demo: ENS
// resets Sepolia every ~32-46 days and our names vanish from the canonical root when it does.
//
//   node scripts/ens/status.mjs            (= preflight.mjs, the G1 gate; exit code is its verdict)
//   node scripts/ens/status.mjs alice      (…then dump one handle's records via the canonical UR)
//
// The verdict comes ONLY from preflight.mjs, which checks the way ENS's own tooling sees us (viem's
// default UniversalResolver + UniversalHelper + the newest contracts-v2 tag). The old status.mjs
// read our own resolver directly, and that blind spot is how in July our names "worked" in our
// code while no ENS tool could resolve them.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isAddressEqual } from 'viem'
import { ENS, PARENT_NAME, REC, helperAbi, clients, readDeployment, dnsEncode } from './lib/ens.mjs'

const label = process.argv[2]
const pre = spawnSync(process.execPath, [fileURLToPath(new URL('./preflight.mjs', import.meta.url))], { stdio: 'inherit' })

if (label) {
  const { publicClient } = clients({ requireKey: false })
  const D = readDeployment()
  const name = `${label}.${PARENT_NAME}`
  const dim = (s) => `\x1b[90m${s}\x1b[0m`
  console.log(`\n\x1b[1mHandle ${name}\x1b[0m  ${dim(`(viem default UR ${ENS.universalResolver})`)}`)
  const owner = await publicClient.readContract({ address: ENS.universalHelper, abi: helperAbi, functionName: 'findExactOwner', args: [dnsEncode(name)] })
  if (isAddressEqual(owner, '0x0000000000000000000000000000000000000000')) {
    console.log(`  ${dim('unclaimed (or expired) — findExactOwner = 0')}`)
  } else {
    console.log(`  owner     ${owner}`)
    console.log(`  resolver  ${await publicClient.getEnsResolver({ name })}`)
    console.log(`  addr      ${await publicClient.getEnsAddress({ name })}`)
    for (const key of Object.values(REC)) {
      const v = await publicClient.getEnsText({ name, key }).catch(() => null)
      console.log(`  ${key.padEnd(26)} ${v || dim('(unset)')}`)
    }
  }
  console.log(dim(`  tag ${D.tag}`))
}
console.log()
process.exit(pre.status ?? 1)
