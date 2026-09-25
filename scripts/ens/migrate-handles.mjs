#!/usr/bin/env node
// Reissue the handles of a retired ENS deployment on the current one, to their SAME owners (their
// K_own addresses) with their public records carried byte-for-byte, via the registrar's owner-only,
// one-shot `migrate()`. Then (with --close) `closeMigration()` kills that path forever.
//
//   node scripts/ens/migrate-handles.mjs                  (dry: validates + prints the plan)
//   node scripts/ens/migrate-handles.mjs --yes --close    (spend gas; close when ALL verify)
//   --skip a,b   labels to leave behind (default: addrtest1 — junk pubkey 0xdeadbeef)
//   --in <path>  inventory (default scripts/ens/old-handles.json)
//
// The inventory is produced READ-ONLY from the old chain state (research-tokyo/migration/
// old-handles.mjs): owner = old registry findOwner, pubkey + every TextChanged key at its current
// value. Carrying `eth.lortnoc.knock` verbatim matters: its salt must not change, or every knock
// already waiting on the relay becomes unopenable (CLAUDE.md §6.8 fix #2).
//
// Idempotent: a label already owned by its intended owner is skipped; owned by anyone else = abort.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAddressEqual } from 'viem'
import {
  ROOT, ENS, PARENT_NAME, REC, registrarAbi, registryAbi, helperAbi,
  clients, readDeployment, writeDeployment, send, log, dnsEncode,
} from './lib/ens.mjs'

const args = process.argv.slice(2)
const YES = args.includes('--yes')
const CLOSE = args.includes('--close')
const opt = (k, d) => (args.indexOf(k) === -1 ? d : args[args.indexOf(k) + 1])
const SKIP = opt('--skip', 'addrtest1').split(',').filter(Boolean)
const IN = opt('--in', join(ROOT, 'scripts', 'ens', 'old-handles.json'))
const ZERO = '0x0000000000000000000000000000000000000000'

const { publicClient, walletClient, account } = clients()
const D = readDeployment()
const { registry, registrar } = D.lortnoc
if (!registry || !registrar) throw new Error('run scripts/ens/deploy.mjs first')

const rows = JSON.parse(readFileSync(IN, 'utf8')).filter((r) => !SKIP.includes(r.label))

// Validate the payload against the row it claims to encode — a hand-edit must not slip through.
for (const r of rows) {
  const [label, pubkey, owner, keys, values] = r.migrateArgs
  const carry = Object.entries(r.carry)
  const bad =
    label !== r.label || pubkey !== r.pubkey || !isAddressEqual(owner, r.owner) ||
    keys.length !== carry.length || keys.some((k, i) => r.carry[k] !== values[i]) ||
    keys.includes(REC.pubkey) || !pubkey
  if (bad) throw new Error(`inventory row ${r.label}: migrateArgs do not match owner/pubkey/carry — refusing`)
}

console.log(`\n\x1b[1mReissue ${rows.length} handles on ${D.tag}\x1b[0m  (skip: ${SKIP.join(',') || 'none'})`)
console.log(`  registrar ${registrar}   owner-signer ${account.address}`)
const regOwner = await publicClient.readContract({ address: registrar, abi: registrarAbi, functionName: 'owner' })
if (!isAddressEqual(regOwner, account.address)) throw new Error(`registrar owner is ${regOwner}, not the signer`)
const open = await publicClient.readContract({ address: registrar, abi: registrarAbi, functionName: 'migrationOpen' })

log.step('Migrate')
for (const r of rows) {
  const name = `${r.label}.${PARENT_NAME}`
  const current = await publicClient.readContract({ address: registry, abi: registryAbi, functionName: 'findOwner', args: [r.label] })
  if (!isAddressEqual(current, ZERO)) {
    if (!isAddressEqual(current, r.owner)) throw new Error(`${name} is owned by ${current}, expected ${r.owner} — abort`)
    log.skip(`${name} → ${r.owner}`)
    continue
  }
  if (!open) throw new Error(`${name} is unissued but migration is CLOSED`)
  log.info(`${name.padEnd(34)} → ${r.owner}  carry [${Object.keys(r.carry).join(', ')}]`)
  if (!YES) continue
  const { request } = await publicClient.simulateContract({
    account, address: registrar, abi: registrarAbi, functionName: 'migrate', args: r.migrateArgs,
  })
  const rc = await send(publicClient, walletClient, request, `migrate(${r.label})`)
  log.ok(`${name} gas ${rc.gasUsed}`)
}
if (!YES) {
  console.log('\n  Dry run. Re-run with --yes (and --close to seal the window).\n')
  process.exit(0)
}

// ---- verify through ENS's own path: viem default UR + UniversalHelper ---------------------------
log.step("Verify via viem's default UniversalResolver + UniversalHelper.findExactOwner")
let fails = 0
for (const r of rows) {
  const name = `${r.label}.${PARENT_NAME}`
  const [addr, pubkey, owner] = await Promise.all([
    publicClient.getEnsAddress({ name }),
    publicClient.getEnsText({ name, key: REC.pubkey }),
    publicClient.readContract({ address: ENS.universalHelper, abi: helperAbi, functionName: 'findExactOwner', args: [dnsEncode(name)] }),
  ])
  const problems = []
  if (!addr || !isAddressEqual(addr, r.owner)) problems.push(`addr ${addr}`)
  if (!isAddressEqual(owner, r.owner)) problems.push(`owner ${owner}`)
  if (pubkey !== r.pubkey) problems.push('pubkey differs')
  for (const [k, v] of Object.entries(r.carry)) {
    const got = await publicClient.getEnsText({ name, key: k })
    if (got !== v) problems.push(`${k} differs`)
  }
  if (problems.length) { fails++; console.log(`    \x1b[31m✗\x1b[0m ${name}: ${problems.join('; ')}`) }
  else log.ok(`${name} addr=owner=${r.owner} pubkey ✓ carried ${Object.keys(r.carry).length} byte-identical`)
}
if (fails) {
  console.error(`\n\x1b[31m${fails} handle(s) failed verification — migration left OPEN for a fix\x1b[0m`)
  process.exit(1)
}

if (CLOSE) {
  log.step('closeMigration()')
  if (!open) log.skip('already closed')
  else {
    const { request } = await publicClient.simulateContract({ account, address: registrar, abi: registrarAbi, functionName: 'closeMigration' })
    await send(publicClient, walletClient, request, 'closeMigration')
    log.ok('migrate() is now dead forever')
  }
  D.lortnoc.migrationClosedAt = D.lortnoc.migrationClosedAt ?? new Date().toISOString()
  writeDeployment(D)
}
console.log(`\n\x1b[32mAll ${rows.length} reissued handles resolve through ENS's canonical path.\x1b[0m\n`)
