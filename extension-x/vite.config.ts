import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import { fileURLToPath } from 'node:url'
import manifest from './manifest.config'

// The repo root, so `../shared/*.mjs` imports resolve out of this workspace (CLAUDE.md §11).
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
  plugins: [crx({ manifest })],
  // shared/ lives above this workspace's root, so Vite's dev server must be told it may read it.
  // Same reason app/vite.config.ts sets fs.allow — without it the dev server 403s on keys.mjs.
  server: { port: 5174, strictPort: true, fs: { allow: [repoRoot] } },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        // STABLE filenames, no content hash — inherited from the Telegram build, where hashed
        // names cost hours. CRXJS loads the content script through a loader that imports the real
        // chunk BY FILENAME; a hashed rebuild renames it, so a browser still holding the old
        // loader requests a file that no longer exists, gets ERR_FILE_NOT_FOUND, and the content
        // script dies silently — extension installed, popup fine, nothing running on the page.
        // An extension loads from disk, so there is nothing to cache-bust.
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
})
