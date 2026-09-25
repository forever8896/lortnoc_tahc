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
  resolve: { dedupe: ['@noble/hashes', '@noble/ciphers', '@noble/curves', '@scure/bip39'] },
  build: {
    target: 'esnext',
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
