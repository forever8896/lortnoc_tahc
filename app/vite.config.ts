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
    // Deliberately viem ONLY: the app is on @noble/curves v2 while Semaphore's tree still imports
    // the v1 `@noble/curves/ed25519` path, and forcing those onto one version breaks the build.
    // They are pure functions, so two copies are harmless.
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
