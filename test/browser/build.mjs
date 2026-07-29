// Bundles the content-script modules for the browser tier.
//
// esbuild is already present as a Vite dependency in extension/, so this adds no install. The
// bundle is written to the scratch dir, not into the repo — it is a build artifact of the test
// run, and the audit's REPO-1 finding is precisely about build artifacts accumulating in the tree.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ROOT } from '../lib/env.mjs'

const execFileAsync = promisify(execFile)

const ESBUILD = resolve(ROOT, 'extension/node_modules/.bin/esbuild')

/** True when the browser tier can run at all. */
export function esbuildAvailable() {
  return existsSync(ESBUILD)
}

/**
 * Build test/browser/entry.ts into a single IIFE and return its path.
 * Bundling (rather than serving raw modules) keeps the fixture page free of import maps and
 * resolves @noble out of shared/node_modules exactly as the real extension build does.
 */
export async function buildBundle() {
  const dir = await mkdtemp(join(tmpdir(), 'lortnoc-browser-'))
  const out = join(dir, 'lortnoc.js')
  await execFileAsync(ESBUILD, [
    resolve(ROOT, 'test/browser/entry.ts'),
    '--bundle',
    '--format=iife',
    '--target=chrome120',
    '--platform=browser',
    `--outfile=${out}`,
  ])
  return out
}
