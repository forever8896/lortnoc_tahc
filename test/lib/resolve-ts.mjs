// Module-resolution hook: makes Node's native TypeScript support resolve the *extensionless*
// relative imports the product source uses (`import { ... } from './crypto'`).
//
// Vite and tsc resolve those via bundler-style resolution; plain Node does not, and the fix
// must not be "edit the product source to suit the tests". This hook appends `.ts` / `.tsx` /
// `/index.ts` only when the bare specifier does not already resolve, so it can never shadow a
// real file or a package — it only fills in what bundler resolution would have found.
//
// Registered via --import in the `test` scripts.
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CANDIDATES = ['.ts', '.tsx', '.mts', '/index.ts', '/index.tsx']

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (err) {
      // Only rescue relative specifiers that failed to resolve; anything else is a genuine
      // error and must surface as one.
      if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw err
      const base = new URL(specifier, context.parentURL)
      for (const ext of CANDIDATES) {
        const candidate = new URL(base.href + ext)
        if (existsSync(fileURLToPath(candidate))) {
          // Deliberately no `format`: let Node infer it from the extension so `.ts` goes
          // through native type-stripping. Forcing 'module' here bypasses the stripper and
          // the type annotations reach V8 as syntax errors.
          return { url: candidate.href, shortCircuit: true }
        }
      }
      throw err
    }
  },
})

export const ok = true
export { pathToFileURL }
