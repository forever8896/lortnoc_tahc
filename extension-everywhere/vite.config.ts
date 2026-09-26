import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import { fileURLToPath } from 'node:url'
import manifest from './manifest.config'

// The repo root, so `../shared/*.mjs` imports resolve out of this workspace (CLAUDE.md §11).
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const page = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  plugins: [crx({ manifest })],
  server: { port: 5175, strictPort: true, fs: { allow: [repoRoot] } },
  // shared/*.mjs import @noble/* and @scure/* by bare name; resolve them from THIS workspace's
  // node_modules so the bundle carries one copy, not one per directory that imports them.
  // NOT deduped: IDKit (World ID) depends on @noble/hashes v1 (subpath './sha3'), our shared/ code on
  // v2 ('./sha3.js'). Forcing one copy broke the build; each package gets the major it was built for.
  resolve: { dedupe: ['@noble/ciphers', '@scure/bip39'] }, // curves: viem needs v1 ('./abstract/utils'), shared/ v2
  build: {
    target: 'esnext',
    // OUT_DIR lets tests/agents build a private copy without touching the dist/ a human has loaded.
    outDir: process.env.OUT_DIR ?? 'dist',
    rollupOptions: {
      // The sheet and the reveal card are extension pages loaded as iframes INTO other sites; they
      // are not reachable from the manifest, so they are listed as inputs explicitly.
      input: { sheet: page('src/sheet/index.html'), reveal: page('src/reveal/index.html') },
      output: {
        // Stable filenames — see extension-x/vite.config.ts for the ERR_FILE_NOT_FOUND story.
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
})
