import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
    // src/lib/live/proof.ts imports ../../../../shared/ticket.mjs — the ticket binding has ONE
    // implementation, shared with the CLI and the relayer, so the dev server has to be allowed
    // to read outside app/.
    fs: { allow: [repoRoot] },
  },
  resolve: {
    // shared/ carries its own node_modules (plain-node callers need it), so without deduping the
    // bundle would ship two copies of viem and instanceof checks would start failing.
    //
    // Deliberately viem ONLY. Adding @noble/* here was tried and MEASURED to fail: the app is on
    // @noble v2 while Semaphore's tree still imports v1 deep paths, so deduping breaks the build
    // with `Missing "./sha3" specifier in "@noble/hashes"` (and the same for curves' `/ed25519`).
    // shared/keys.mjs therefore resolves @noble from shared/node_modules and the bundle carries a
    // second copy. They are pure functions with no instanceof checks across the boundary, so two
    // copies are harmless — unlike viem, where duplicate classes break instanceof.
    dedupe: ['viem'],
  },
  // snarkjs, reached through @semaphore-protocol/proof, expects a Node-ish global.
  define: { global: 'globalThis' },
  optimizeDeps: {
    include: ['@semaphore-protocol/identity', '@semaphore-protocol/group', '@semaphore-protocol/proof'],
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        // Proving drags in a large, rarely-needed dependency tree. Splitting it keeps first paint
        // fast for people who are only reading messages.
        manualChunks: {
          semaphore: [
            '@semaphore-protocol/identity',
            '@semaphore-protocol/group',
            '@semaphore-protocol/proof',
          ],
        },
      },
    },
  },
})
