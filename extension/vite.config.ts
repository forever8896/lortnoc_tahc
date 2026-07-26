import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        // STABLE filenames, no content hash.
        //
        // CRXJS loads the content script through a small loader that dynamically imports the real
        // chunk by filename. With hashed names, every rebuild renames that chunk — so a browser
        // still holding the previous loader requests a file that no longer exists, gets
        // ERR_FILE_NOT_FOUND, and the content script dies silently. The extension looks installed,
        // the popup works, and nothing on Telegram runs. That failure cost us hours of debugging a
        // handshake that was never executing.
        //
        // Stable names mean a stale loader resolves to the current chunk instead of a 404. We do
        // not need cache-busting here: an extension is loaded from disk, not fetched over HTTP.
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
  server: { port: 5173, strictPort: true },
})
