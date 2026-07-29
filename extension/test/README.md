# extension/test — moved

The tests that lived here (`pipeline.test.mjs`, `handshake.test.mjs`) were removed on 2026-07-29
and replaced by the root suite:

| Was here | Now |
|---|---|
| `pipeline.test.mjs` | `test/integration/pipeline.test.mjs` |
| `handshake.test.mjs` | `test/unit/crypto.test.mjs` + `test/unit/handshake.test.mjs` |

Run them with `npm test` (or `npm run test:unit`) from the **repo root**.

## Why they were replaced, not kept

Both re-implemented their subject inside the test file instead of importing it. `pipeline.test.mjs`
tested a passphrase-derived conversation key — a derivation the product had already deleted in
favour of the X25519 handshake, under a different HKDF salt. It passed, green, exercising an API
with no callers, for as long as it existed.

The replacements import `extension/src/content/*.ts` directly (Node 24+ strips TypeScript types
natively, so no build step is involved). A test that re-implements its subject cannot fail when the
subject changes, which is the only thing a test is for.

See `test/README.md` at the repo root.
