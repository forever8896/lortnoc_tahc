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
import { existsSync, readFileSync } from 'node:fs'
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
  /**
   * Two Vite-isms the product source is entitled to use and Node is not obliged to understand.
   * Both are rewritten in the LOADER, never in the source — "edit the product to suit the tests"
   * is the failure this whole suite exists to avoid.
   *
   *  1. `import.meta.env.VITE_X` — Vite substitutes these at build time. Node leaves
   *     `import.meta.env` undefined, so the very first property read throws before any test runs.
   *     Rewriting it to an empty object makes every `(import.meta.env.X as string) || 'default'`
   *     in live/config.ts take its default, which is exactly the public-endpoint configuration a
   *     test should run against.
   *  2. `import ... from './x.json'` — Node requires an explicit import attribute; Vite does not.
   *
   * Without these, nothing under app/src/lib/live can be imported at all, which is why the
   * Sui/Walrus/Seal layer had no automated tier (CLAUDE.md §2.1) — not because it was untestable,
   * but because the test runner could not load it.
   */
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!/\/(app|extension|extension-x)\/.*\.tsx?$/.test(url)) return result
    let src = result.source == null ? readFileSync(fileURLToPath(url), 'utf8') : String(result.source)
    if (!src.includes('import.meta.env') && !/from\s+['"][^'"]+\.json['"]/.test(src)) return result
    src = src
      .replace(/import\.meta\.env/g, '({})')
      .replace(/(from\s+['"][^'"]+\.json['"])(\s*[;\n])/g, '$1 with { type: "json" }$2')
    return { ...result, source: src, shortCircuit: true }
  },
})

export const ok = true
export { pathToFileURL }
