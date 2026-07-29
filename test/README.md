# Test suite

One command: `npm test` (from the repo root).

```
npm test                    # all six tiers
npm run test:unit           # fastest loop, no I/O
npm run test:invariants     # CLAUDE.md §4, as executable checks
npm run test:codec          # python: coder, paywall, HTTP surface
npm run test:contracts      # forge: membership + registrar
npm run test:browser        # the DOM layer, in real Chromium
npm run test:integration    # needs a live codec; self-skips without one
npm run test:watch          # re-run unit tests on save
```

## The one rule

**Tests import the real product source.** They never re-implement it.

This is not a style preference. The suite that existed before
(`extension/test/pipeline.test.mjs`) copied `content/crypto.ts` into the test file and
tested a *passphrase-derived* conversation key — a derivation the product had already
deleted in favour of the X25519 handshake, under a different HKDF salt. The test kept
passing, against code that no longer existed, exercising an API with no callers. A test
that re-implements its subject cannot fail when the subject changes, which is the only
thing a test is for.

Node 24+ strips TypeScript types natively, so `test/unit/crypto.test.mjs` imports
`extension/src/content/crypto.ts` directly. No build step, no compiled copy to drift.
(`test/lib/resolve-ts.mjs` teaches Node to follow the source's extensionless relative
imports, so the product source never has to be edited to suit the tests.)

## Tiers

| Tier | Tests | Needs | What it proves |
|---|---|---|---|
| `unit` | 88 | nothing | Crypto, framing, session state, metering, ticket binding |
| `invariants` | 16 | `git` | The CLAUDE.md §4 "hard constraints in review" |
| `codec` | 77 | `python3` | Coder reversibility, the x402 paywall, the HTTP contract |
| `contracts` | 55 | `forge` | `LortnocMembership` + `LortnocRegistrar` |
| `browser` | 29 | Chromium | `selectors.ts`, send interception, inbound scanning |
| `integration` | 12 | a running codec | The full extension data path, end to end |

A tier whose dependency is missing **skips rather than fails**, so the default run stays
green offline. CI installs everything and runs them all.

Start a codec for the integration tier:

```bash
cd codec && CODEC_BACKEND=markov python3 server.py     # real stego, no torch needed
CODEC_BACKEND=gpt2 python3 server.py                   # the shipped model (slow, needs torch)
```

Point the tests elsewhere with `CODEC=https://lortnoc-codec.fly.dev npm run test:integration`.

First run of the browser tier needs the browser: `npx playwright install chromium`.

## Layout

```
test/
  run.mjs                    orchestrator — tiers, summary, exit code
  lib/
    env.mjs                  chrome.* stub, codec client, source reader
    resolve-ts.mjs           lets Node follow the source's extensionless TS imports
  unit/
    crypto.test.mjs          K_conv derivation, AES-SIV envelope, base64 transport
    parity.test.mjs          extension ≡ app ≡ shared; the HKDF labels are pinned
    handshake.test.mjs       frame build/parse, and every rejection path
    session.test.mjs         handshake state machine, persistence, the replay guard
    metering.test.mjs        freemium counter, membership bypass, server reconciliation
    ticket.test.mjs          the Semaphore public signal that binds a claim
  invariants/
    spec.test.mjs            §4 / §8 / §9 enforced against the tree
  browser/
    fixture.html             a Telegram Web K DOM, including the hidden stale chat pane
    entry.ts                 bundle entry — exposes the real modules on window
    build.mjs                esbuild bundling (reuses extension/'s esbuild; no new install)
    dom.test.mjs             the DOM layer in Chromium
  integration/
    pipeline.test.mjs        live codec: round-trip, reversibility, Telegram-safety
codec/
  run_tests.py               python runner (collects BOTH TestCase and bare test_* styles)
  test_coder.py              block-coder reversibility (pre-existing)
  test_codec.py              wordmap + active backend (pre-existing)
  test_auth.py               the paywall — tokens, buckets, x402, the reserve/release race
  test_server.py             HTTP surface, status codes, membership resource
contracts/test/
  LortnocMembership.t.sol    payment, double-join, treasury forwarding, nullifier burns
  LortnocRegistrar.t.sol     the role handover, label rules, relayed + gated claims
  mocks/                     MockSemaphore, MockEns (registry/factory/resolver/gate)
```

## Notes that will save you time

**`parity.test.mjs` guards a collapse, not a duplication.** The §5.1 derivation table used to
be hand-inlined in seven places across three workspaces. It now lives once in
`shared/keys.mjs`; this test asserts neither surface has re-inlined it, and pins the HKDF
labels — changing one invalidates every key derived under it, which for `K_sui` means
stranding the WAL balance at an address nobody holds any more.

**Status codes on `/decode` are load-bearing.** `422` means "ordinary chatter" and the
extension *caches* that verdict permanently. Anything else means "transient" and is retried.
Only `coder.NotCoverText` earns a 422; a malformed request is 400 and an internal failure is
500. Turning either of those into a 422 silently swallows a real message forever — the bug
class the `RETRY` symbol in `inbound.ts` exists to prevent.

**`codec/run_tests.py` exists because `python3 -m unittest discover` collects zero tests
from `test_coder.py` and `test_codec.py`** — they use bare `test_*` functions, not
`TestCase` classes. The coder's reversibility proof, arguably the most important test in
the repo, ran only if someone typed `python3 test_coder.py` by hand.

**The browser tier cannot prove the selectors still work.** It runs against a fixture, so it
proves the logic layered on the selectors is correct — fail-closed sends, the decode cache,
history fossils, the hidden-pane filter. Telegram ships new markup without notice, and only a
live page will tell you when `selectors.ts` stops matching. Treat a green browser tier as "our
logic is intact", never as "the overlay works today".

## What is NOT covered

Stated plainly so nobody reads a green suite as more than it is:

- **The live Telegram DOM.** See above. `extension/scripts/drive.mjs` exists for manual driving.
- **Sui / Walrus / Seal.** `app/src/lib/live/*` is exercised only by the ad-hoc scripts in
  `app/scripts/` (`seal-live.mjs`, `quilt-probe.mjs`). No automated tier touches real storage.
- **The relayer.** `relayer/server.mjs` — 479 lines holding a funded key and bridging a burned
  ticket across two chains — still has no tests. Highest-value remaining gap.
- **Real Groth16 verification.** The contract tests mock `ISemaphore`, so they cover
  `LortnocMembership`'s own bookkeeping, not proof validity (Semaphore tests that upstream). A
  fork test against the live Galileo deployment would close it.
- **The 0G sealed-inference call** and the ENS v2 resolution path against live Sepolia — both
  are exercised only by `scripts/ens/demo.mjs` and `status.mjs`, run by hand.
- **The invariant tests are a tripwire, not a proof.** They catch a re-introduced bot token or
  a plaintext POST; they cannot prove the absence of a leak.
