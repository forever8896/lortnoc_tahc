# Audit — lortnoc_tahc

**Date:** 2026-07-29 · **Scope:** whole repo (~11.8k LOC, 136 commits, 7 workspaces), with
emphasis on the Chrome extension and the codec service · **Method:** full read of the
correctness-critical paths, plus a new test suite (277 tests across six tiers) written to pin
the behaviour described below. All findings were subsequently fixed; see the status table.

Companion: [`test/README.md`](../test/README.md) — the suite, how to run it, what it does
*not* cover.

---

## Summary

The code is substantially better than its own spec claims. CLAUDE.md §2 still says
*"Pre-code. No build system, scaffold, or git history yet"*; in reality there are three live
chain deployments, a hosted codec, a published extension and a working end-to-end path. The
engineering quality is high in an unusual way: nearly every subtle branch carries a comment
explaining the *failure it exists to prevent* (the `RETRY` symbol, the fossil-frame guard,
the `select` honesty field). That is rare and worth protecting.

What was missing was any mechanism to keep it that way. There was **no test runner, no test
gate in CI, and the tests that existed re-implemented their subjects** — one of them
verifying a passphrase-derived key that had been deleted from the product. The release
workflow packaged, attested and published tagged builds without running a single test.

Findings are ranked by consequence. Every one was verified against the source, not inferred.

**All findings below were fixed on 2026-07-29.** Status column records how; the detail sections
keep the original diagnosis, because the reasoning is the part worth re-reading.

| # | Severity | Finding | Status |
|---|---|---|---|
| TEST-1 | **High** | The pre-existing test suite tested deleted code and could not fail | Fixed — suite replaced, old files deleted |
| EXT-1 | **High** | A one-sided reconnect hangs forever — the exact recovery the UI recommends | Fixed — guard moved into `session.ts` |
| CI-1 | **High** | No test gate; tagged releases shipped unverified | Fixed — `.github/workflows/test.yml` |
| CRYPTO-1 | Medium | Key derivation duplicated across **seven** sites | Fixed — collapsed into `shared/keys.mjs` |
| CODEC-2 | Medium | Free-send counter has a check-then-act race under concurrency | Fixed — atomic `reserve`/`release` |
| CODEC-3 | Medium | `422` is overloaded, re-opening the "silently swallowed message" bug class | Fixed — `coder.NotCoverText` |
| HONESTY-1 | Medium | The UI claims GPT-2 regardless of which backend actually loaded | Fixed — `/encode` reports `model` |
| EXT-2 | Low | `MIN_COVER_WORDS` is uncovered cross-component coupling | Covered by an integration test |
| CHAIN-1 | Low | `contracts/` has no tests | Fixed — 55 Foundry tests; relayer still uncovered |
| DOC-1/2 | Low | Spec drift: §2, §11 toolchain, `coder.py` docstring | Fixed |
| REPO-1 | Low | Built extension trees and zips committed / littering the root | Fixed — removed + gitignored |

Two verifications worth recording, because they turn "should be fine" into evidence:

- **CRYPTO-1 is behaviour-preserving.** The old inlined derivations and the new shared ones were
  run side by side over multiple seeds: `K_own`, `id_sem` and `K_sui` are byte-identical, so no
  existing identity, on-chain commitment or funded Sui address moves. The app's production bundle
  came out with an unchanged content hash.
- **CODEC-2 was a real race, not a theoretical one.** Reproduced with 40 concurrent requests
  against a limit of 3: the old check-then-act allowed **all 40**; `reserve` allows exactly 3.

The remaining known gaps are listed at the end of `test/README.md` — the relayer is the largest.

---

## High

### TEST-1 — The test suite tested code that no longer exists

`extension/test/pipeline.test.mjs` opens by copying `content/crypto.ts` into the test file:

```js
const SALT = enc.encode('lortnoc/conv/aes-siv/v1')
const deriveKey = (pass) => hkdf(sha256, enc.encode(pass), SALT, INFO, 64)
const key = deriveKey('correct horse battery staple')
```

The product has no passphrase path at all. `crypto.ts` says so explicitly — *"There is
deliberately no passphrase path"* — and derives `K_conv` by X25519 ECDH under a different
salt, `lortnoc/conv/x25519/v1`. The test passes, green, exercising an API with no callers.
`extension/test/handshake.test.mjs` has the same shape: it re-implements `deriveConvKey`
rather than importing it, so it verifies the test author's copy, not the product.

A test that re-implements its subject cannot fail when the subject changes, which is the
only thing a test is for.

**Fixed.** The new suite imports real source throughout (Node 24+ strips TypeScript natively,
so `test/unit/crypto.test.mjs` imports `crypto.ts` directly — no compiled copy to drift). Both
old files are deleted; `extension/test/README.md` points at their replacements and explains why
they went, so the lesson survives the files.

### EXT-1 — A one-sided Disconnect→Connect hangs forever

`content/index.ts:115` holds the handshake replay guard as module state:

```ts
const handledFrames = new Set<string>()   // keyed `${type}:${hex(pubkey)}`
```

It is cleared in exactly one place — the peer-re-offered branch at line 141. `HS_RESET`
(line 208) calls `session.reset()`, which knows nothing about it.

The failure:

1. Alice and Bob are established. Keys mismatch, so the extension toasts — verbatim —
   *"Both hit Disconnect, then Connect again."*
2. Alice alone does it (the natural first attempt). `session.reset()` drops her keypair;
   `sendOffer()` generates a new one and sends a fresh OFFER.
3. Bob is still established. He sees an OFFER from a non-peer pubkey, clears *his* guard,
   re-establishes, and ACKs — with **his own pubkey, which never changed**.
4. Alice receives that ACK. `fkey = "2:<Bob's unchanged pubkey>"` is still in her
   `handledFrames` from the first handshake, so `handleFrame` returns early.

`session.onAck` is never called. Alice stays in `offered` forever. No error is logged, no
toast fires, and the 25-second `watchForAnswer` warning tells her the *other* side is at
fault. The only escape is for Bob to reset too.

**Fixed.** The guard moved into `session.ts` as `alreadyHandled()` / `clearHandledFrames()`,
next to the state whose lifetime it shares, and `reset()` clears it. Confirmed the test catches
the original bug: with the `handledFrames.clear()` line removed it fails, with it present it
passes.

### CI-1 — No test gate

`.github/workflows/release.yml` was the only workflow. On a version tag it builds the
extension, packages `dist/`, records a SHA-256 and a build-provenance attestation, and
publishes a GitHub Release — without running anything. The workflow's own comment sells
verifiability (*"anyone can rebuild the tag and diff"*), which is a claim about
reproducibility, not correctness.

**Fixed.** `.github/workflows/test.yml` runs all six tiers on every push and PR, plus
`typecheck` for both TS workspaces and `forge build` + `forge test` for contracts. It needs no
torch, no GPU and no model download — the codec tier runs the dependency-free `wordmap` backend
and the integration tier runs against `markov`.

---

## Medium

### CRYPTO-1 — Duplicated key derivation across seven sites

*The audit opened on two copies; a closer sweep found seven.* The CLAUDE.md §5.1 derivation
table was hand-inlined in:

| Site | What it derived |
|---|---|
| `extension/src/content/crypto.ts` | `K_conv`, AES-SIV envelope |
| `app/src/lib/crypto.ts` | the same, plus `MS`, `K_msg`, `K_own`, `id_seal` |
| `scripts/ens/derive.mjs` | `MS`, `K_own` — comment: *"Mirrors app/src/lib/crypto.ts"* |
| `app/src/lib/live/proof.ts` | `id_sem` |
| `app/src/lib/live/membership.ts` | `id_sem`, again |
| `app/src/lib/live.ts` | `K_sui` |
| `scripts/ens/membership.mjs` | `MS`, `id_sem` |

They agreed. Nothing enforced that they keep agreeing, and CLAUDE.md §3 sells "three surfaces,
**one key set**". Two of these were already flagged by the code itself: `proof.ts` warned that
its `id_sem` "must match membership.ts::commitmentFrom exactly, or the proof would be generated
against a commitment that was never paid for", and `derive.mjs` said it "mirrors" a file it had
no mechanical relationship to.

Each drift has a distinct silent failure: `K_conv` → each surface reads only its own messages;
`id_sem` → a valid proof against a commitment nobody bought; `K_own` → the CLI mints a handle to
an address nobody holds; `K_sui` → the funded storage address moves and the WAL is stranded.

The failure mode is silent: change one salt, one HKDF output length or one sort order, and
each surface reads only its own messages — with no error anywhere. That is the same symptom
the handshake comments describe chasing repeatedly.

`shared/ticket.mjs` already made exactly this argument in its own header — *"ONE
implementation ... this value is security-critical and two copies would eventually
disagree"* — and the crypto is more security-critical than the ticket encoder.

**Fixed.** All seven now import `shared/keys.mjs`. `test/unit/parity.test.mjs` asserts the
surfaces stay interchangeable, that neither has re-inlined a derivation, and pins the HKDF
labels. Verified behaviour-preserving by running the old and new derivations side by side:
byte-identical `K_own`, `id_sem` and `K_sui` across seeds, and an unchanged app bundle hash.

One deliberate oddity is preserved and now guarded: `K_sui` passes an **empty** HKDF info where
every other derivation passes a string. Normalising it would change the Sui address and strand
the WAL balance, so `parity.test.mjs` asserts that exact line stays as it is.

A related finding while wiring this up: adding `@noble/*` to the app's Vite `dedupe` list to
collapse the second copy that `shared/node_modules` introduces **does not work** — Semaphore's
tree still imports v1 deep paths and the build fails with `Missing "./sha3" specifier in
"@noble/hashes"`. Tried, measured, reverted, and the reason recorded in `app/vite.config.ts` so
nobody repeats it.

### CODEC-2 — Check-then-act race on the free-send counter

`server.py` does:

```python
verdict = auth.authorize(handle, membership)   # reads the count
...
cover, select = codec.encode(ct, fast=fast)    # seconds, under a model lock
...
auth.spend(handle)                             # increments it
```

`authorize` and `spend` each take `_lock` individually, but the gap between them spans a
full model call, and the service is a `ThreadingHTTPServer`. N concurrent requests from one
handle at `remaining == 1` all pass `authorize` before any of them reaches `spend`, so all N
get cover text. The free limit is soft against a trivially parallel client.

This is bounded by the honesty already in `auth.py` (the handle is client-asserted anyway),
so it is a metering leak, not a security hole.

**Fixed.** `auth.reserve()` claims the slot inside the same lock as the check; `auth.release()`
refunds it when the encode fails, so a codec error still costs the user nothing. `authorize()`
survives as the read-only view for callers that must not consume quota. Reproduced before and
after with 40 concurrent requests against a limit of 3: **40 allowed** before, **exactly 3**
after.

### CODEC-3 — `422` is overloaded, re-opening a solved bug class

`server.py` maps **every** `KeyError` and `ValueError` on `/decode` to 422. The extension
treats 422 as the *cacheable* verdict — `inbound.ts` records `seen.set(mid, null)` and never
retries that bubble again.

That coupling is correct only if 422 means exactly "this is ordinary chatter". Today it also
means "the request was missing a field", and it would mean "the coder hit an internal
`ValueError`" — at which point a real message is permanently swallowed with no error
surfaced. This is precisely the failure the `RETRY` symbol in `inbound.ts` was introduced to
prevent, re-entering through the server instead of the client.

**Fixed.** `coder.NotCoverText` is now the only path to a 422; `wordmap.decode` and both models'
`from_words` raise it for an unknown word. A malformed request is 400, an unexpected internal
failure is 500 — both of which the extension retries instead of caching. Also fixed alongside:
`hide()` now rejects payloads over the 2-byte length header's 65,535-byte ceiling explicitly,
rather than letting `int.to_bytes` raise from the middle of the framing.

### HONESTY-1 — The UI claims GPT-2 whichever backend loaded

`codec.py` falls back silently: `auto` → gpt2 → markov → wordmap, each on any exception.
`/health` reports the truth (`model`, `digest`). The extension never reads it, and
`index.ts` sets the progress label unconditionally:

```ts
progress.set(1, 'GPT-2 · hiding it as chatter')
```

So a codec that quietly degraded to `wordmap` — a deterministic public byte→word map, with
no model and no steganography — still tells the user GPT-2 hid their message. Confidentiality
is unaffected (AES-SIV does that work), but the product claim is not.

This is the same class of problem the team already fixed for 0G in `903cba3`, which added
the `select` field so the UI stops claiming 0G judged a cover it never saw.

**Fixed, the same shape.** `/encode` now returns `model`, and the progress stepper stays neutral
("Hiding it as ordinary chatter") until the codec says which backend actually ran — then names
it, or warns outright when the cover is not steganographic. And `codec.py` refuses to boot on the
`wordmap` placeholder unless it was explicitly asked for (`CODEC_BACKEND=wordmap` or
`CODEC_ALLOW_WORDMAP=1`), so a silent production degradation is a startup failure instead.

---

## Low

### EXT-2 — `MIN_COVER_WORDS` is uncovered cross-component coupling *(covered)*

`inbound.ts` discards any bubble under 13 words without calling the codec, calibrated against
*"a 16-byte AES-SIV ciphertext ... comes back as 27 words"*. That figure depends on `CODEC_K`,
an environment variable in a different workspace and a different language. Raise it and covers
get shorter; cross the floor and the extension silently discards its own messages, with no
error on either side.

Measured headroom is backend-dependent. For `markov` there is plenty (20 words even at k=8).
For GPT-2, the code's own figure of 27 words at k=3 implies roughly 13–14 at k=6 — at the
floor. **Done:** `test/integration/pipeline.test.mjs` measures the shortest real cover text
against whatever backend is running and fails with a message naming both constants.

### CHAIN-1 — Contracts and relayer are untested

`contracts/` has no `test/` directory. `LortnocMembership` receives payment and forwards to a
treasury; `LortnocRegistrar` mints handles and manages roles. Neither has a unit test — and
CLAUDE.md already flags *"Treasury is still the hot deploy key — move it before collecting at
scale."* `relayer/server.mjs` (479 lines, holds a funded key, bridges a burned ticket across
two chains) likewise has none.

**Fixed for the contracts.** 55 Foundry tests in `contracts/test/`, run by CI. The headline
assertion is the one the ENS-booth demo rests on and that only a live deploy script had ever
checked: after `claim()`, the registrar holds **no** roles on the handle's resolver and cannot
write to it, while the claimant can. Also covered: treasury forwarding and the contract never
holding a balance, double-join and double-spend rejection, a rejected proof rolling the nullifier
burn back, the label rules, relayed claims minting to the claimant rather than the relayer, the
nullifier gate, and the `isRelayer`-does-not-survive-a-redeploy trap that cost a live outage.

`ISemaphore` is mocked, so proof *validity* is still Semaphore's own concern — a fork test
against the live Galileo deployment remains the next step. **The relayer is still untested** and
is now the largest single gap in the repo.

### DOC-1 — Spec drift *(fixed)*

- **§2 "Status"** still reads *"Pre-code ... No build system, scaffold, or git history yet."*
  There are 136 commits, ~11.8k LOC and live deployments on Sepolia, 0G Galileo and 0G
  mainnet. CLAUDE.md's own preamble requires updating it in the same change as the code.
- **§11 Toolchain** says *"pnpm monorepo (workspaces: `extension/`, `codec/`, `gateway/`,
  `contracts/`, `app/`)"*. Reality: npm, per-workspace lockfiles, no root workspace, no
  `gateway/` (the equivalent is `relayer/`), and `shared/` and `scripts/` are unlisted.

### DOC-2 — `coder.py` docstring contradicts the code *(fixed)*

The header states *"A 4-byte big-endian length header prefixes the payload"*. The code writes
2 random nonce bytes plus a **2-byte** length (`_NONCE = 2`, `len(data).to_bytes(2, "big")`).
The undocumented consequence is a hard 65,535-byte payload cap: a larger payload raises
`OverflowError`, which `server.py` catches as a generic 400. It fails closed, correctly — but
the limit should be stated and validated deliberately rather than emerging from an integer
overflow. `MAX_BODY` is 256 KiB, so the server accepts bodies it cannot encode.

### REPO-1 — Build artifacts in the tree *(fixed)*

`lortnoc-tahc-extension-v0.8.2/` is **committed** (25 files, 700 KB of built output).
`v0.8.3/` and five zips (2.9 MB) sit untracked in the root. `extension/package.json` says
`0.8.7`, the newest zip is `0.8.5`.

This works against the release workflow's own pitch — that the download comes from GitHub and
anyone can rebuild the tag and diff it. With several unlabelled candidate builds in the
working tree, "which artifact is the release" stops being obvious. Recommend deleting them
and adding `lortnoc-tahc-extension-*/` and `*.zip` to `.gitignore`.

*(Checked and clean: `.env.local` is correctly gitignored and untracked; no secret is
committed.)*

---

## What the new suite covers

277 tests, six tiers, one command (`npm test`).

| Tier | Tests | Needs |
|---|---|---|
| `unit` | 88 | nothing |
| `invariants` | 16 | `git` |
| `codec` (python) | 77 | `python3` |
| `contracts` (forge) | 55 | `forge` |
| `browser` (playwright) | 29 | Chromium |
| `integration` | 12 | a running codec |

A tier whose dependency is missing skips rather than fails, so the default run stays green
offline; CI installs everything.

Notable, beyond the obvious:

- **`parity.test.mjs`** — guards the CRYPTO-1 collapse: neither surface may re-inline a
  derivation, and the HKDF labels are pinned (changing one invalidates every key derived
  under it).
- **`invariants/spec.test.mjs`** — CLAUDE.md §4 as executable checks: no MTProto/bot token,
  no World ID (§9), plaintext never reaches the codec, key material never lands in
  `storage.local`, cover text never decorated, the coder never samples, 0G never asked for
  logprobs, and the `select` honesty signal still wired end to end.
- **`codec/test_auth.py`** — the paywall had **zero** tests. It now covers token forgery,
  expiry, tampering, the secret-less path, handle-bucket normalisation, the reserve/release
  race under 40 threads, and the x402 verify-before-settle ordering (a facilitator that
  settled an unverified payment would hand out free memberships).
- **`codec/run_tests.py`** — exists because `python3 -m unittest discover` collects **zero**
  tests from `test_coder.py` and `test_codec.py`: they use bare `test_*` functions rather than
  `TestCase` classes. The block coder's reversibility proof — arguably the most important test
  in the repo — ran only when someone typed `python3 test_coder.py` by hand.
- **`contracts/test/LortnocRegistrar.t.sol`** — asserts locally what only a live deploy script
  had ever checked: after `claim()`, the registrar holds no roles on the handle's resolver and
  cannot write to it, while the claimant can. That is the ENS-booth demo.
- **`test/browser/dom.test.mjs`** — the DOM layer in real Chromium: the send path is
  fail-closed, the decode cache distinguishes "not ours" from "try again", history fossils are
  flagged, the hidden chat pane is never scanned, and a triple-Enter does not double-send.
- **§6.2's stated first milestone** (*"`decode(encode(x)) == x` for 100 random payloads,
  deterministic across process restarts"*) is now an actual test, passing against `markov`.

## What it still does not cover

- **The live Telegram DOM.** The browser tier runs against a fixture, so it proves our logic is
  intact, never that `selectors.ts` still matches today's Telegram build. Telegram ships markup
  without notice; only a live page will tell you. This remains the likeliest production break.
- **The relayer** — `relayer/server.mjs`, 479 lines holding a funded key and bridging a burned
  ticket across two chains. Still zero tests, and now the largest single gap in the repo.
- **Sui / Walrus / Seal.** `app/src/lib/live/*` is exercised only by the ad-hoc scripts in
  `app/scripts/`. No automated tier touches real storage.
- **Real Groth16 verification.** The contract tests mock `ISemaphore`, covering
  `LortnocMembership`'s own bookkeeping rather than proof validity. A fork test against the live
  Galileo deployment would close it.
- **The invariant tests are a tripwire, not a proof.** They catch a re-introduced bot token or
  a plaintext POST; they cannot prove the absence of a leak.
