#!/usr/bin/env node
// One entrypoint for the whole test suite, across two languages and four workspaces.
//
// Tiers, fastest first — each is independently runnable so a failure points at a layer:
//
//   unit         JS/TS. No network, no browser, no codec. Imports the real product source.
//   invariants   The CLAUDE.md §4 "hard constraints in review", automated.
//   codec        Python. The coder's reversibility proof, the paywall, the HTTP surface.
//   integration  JS/TS against a LIVE codec. Skips cleanly when none is running.
//
// Usage:
//   node test/run.mjs                 # everything (integration self-skips if no codec)
//   node test/run.mjs unit            # one tier
//   node test/run.mjs unit invariants # several
//   CODEC=http://host:port node test/run.mjs integration
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = resolve(ROOT, 'test/lib/resolve-ts.mjs')

// `--import` registers the resolver hook that lets Node's native TypeScript support follow
// the extensionless relative imports the product source uses. See test/lib/resolve-ts.mjs.
const node = (globs) => ({
  cmd: process.execPath,
  args: ['--import', HOOK, '--test', ...globs],
})

const TIERS = {
  unit: { label: 'unit — real source, no I/O', ...node(['test/unit/*.test.mjs']) },
  invariants: { label: 'invariants — CLAUDE.md §4', ...node(['test/invariants/*.test.mjs']) },
  codec: {
    label: 'codec — python (coder, paywall, HTTP)',
    cmd: 'python3',
    args: ['-W', 'ignore::ResourceWarning', 'run_tests.py'],
    cwd: resolve(ROOT, 'codec'),
  },
  contracts: {
    label: 'contracts — foundry (membership, registrar)',
    cmd: 'forge',
    args: ['test', '--root', 'contracts'],
  },
  // Serialised: each test drives a shared Chromium and asserts on global page state, so
  // concurrency would have them stepping on one another.
  browser: {
    label: 'browser — DOM layer in Chromium',
    cmd: process.execPath,
    args: ['--import', HOOK, '--test', '--test-concurrency=1', 'test/browser/*.test.mjs'],
  },
  integration: { label: 'integration — needs a live codec', ...node(['test/integration/*.test.mjs']) },
}

const ORDER = ['unit', 'invariants', 'codec', 'contracts', 'browser', 'integration']

function run({ cmd, args, cwd }) {
  return new Promise((done) => {
    const p = spawn(cmd, args, { cwd: cwd ?? ROOT, stdio: 'inherit' })
    p.on('close', (code) => done(code ?? 1))
    p.on('error', (err) => {
      console.error(`  could not start ${cmd}: ${err.message}`)
      done(127)
    })
  })
}

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const selected = requested.length ? requested : ORDER

for (const name of selected) {
  if (!TIERS[name]) {
    console.error(`unknown tier "${name}" — expected one of: ${ORDER.join(', ')}`)
    process.exit(2)
  }
}

const results = []
for (const name of selected) {
  const tier = TIERS[name]
  console.log(`\n\x1b[1m━━━ ${name}\x1b[0m  ${tier.label}`)
  results.push([name, await run(tier)])
}

console.log('\n\x1b[1m━━━ summary\x1b[0m')
for (const [name, code] of results) {
  console.log(`  ${code === 0 ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`)
}
const failed = results.filter(([, c]) => c !== 0)
if (failed.length) {
  console.log(`\n\x1b[31m${failed.length} tier(s) failed\x1b[0m\n`)
  process.exit(1)
}
console.log('\n\x1b[32mall tiers passed\x1b[0m\n')
