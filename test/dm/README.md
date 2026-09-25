# DM tier — Lortnoc DM end to end, on real chains

Closes the gap CLAUDE.md §2.1 recorded for years: §6.4 (Sui/Walrus/Seal) said **"no automated
tier"** and §6.6 (native DM) had an empty test column. Everything below the Messenger UI was
proven only by hand-run scripts.

```bash
node test/run.mjs dm          # or: npm test  (dm runs last)
node test/dm/fund.mjs         # one-off: top ALICE up from the Sui CLI keystore
```

## What it proves

| | |
|---|---|
| Two wallets agree a conversation key with **no handshake** | ECDH is symmetric (§5.3 Tier 2) |
| A third party derives a **different** key | |
| Sui account + messaging key come from **one** master secret | this is what "a wallet owning a handle" means |
| Alice sends → Seal encrypt → Walrus blob → Sui head | the real `sendMessage` the UI calls |
| Bob reads the plaintext back | with **no funds** — reading is free |
| Mallory is **refused by the on-chain policy** | `seal_approve` asserts `head.members.contains(sender)` |
| A second message appends to the **same head**, in order | a thread, not a new conversation |

It imports `app/src/lib/live/sui.ts` — the same `sendMessage`/`readMessages` the Messenger calls.
Nothing is re-implemented, so the tier cannot pass against a copy of the logic that has drifted.

## Why only one wallet is funded

Writing costs Sui gas plus WAL for the blob; **reading costs nothing** — a reader signs a Seal
session key off-chain and fetches blobs over HTTP. So Alice writes, Bob reads, and the
access-control cases come free. Addresses are derived deterministically (`identities.mjs`), so
funding survives across runs.

Roughly **0.057 SUI + 0.008 WAL per run**. `fund.mjs` moves 0.3 SUI / 0.2 WAL by default — about
five runs. It skips (never fails) when Alice runs dry, naming the top-up command.

## Two traps this tier walked into, so you do not have to

**A `SealClient` caches derived key shares.** `sui.ts` holds one module-level client, so once Bob's
read succeeds, a stranger's decrypt is served from that cache and "the stranger is refused" passes
for the wrong reason. It did exactly that on the first run. CLAUDE.md §6.4 gotcha 4 warns about it
in one line; the fix here is to run the stranger check in a **child process**, the only genuinely
fresh client when the cache is module state.

**Reads legitimately lag writes.** A fresh Walrus blob is not instantly readable everywhere and a
Sui object read can trail the transaction that wrote it, so `readMessages` returns a short list for
a moment. The append test passed and failed on consecutive runs before the reads were made to
**poll** — which is what the Messenger itself does (§6.6; the realtime relay is roadmap). A test
that reads once asserts a stricter contract than the product offers.

## Real handles, claimed on Sepolia

`alice.lortnoctahc.eth` and `bob.lortnoctahc.eth` are **live**, owned by the test wallets' own
`K_own` keys, publishing the X25519 key each wallet actually derives plus its Sui address:

```bash
node test/dm/claim.mjs <label> [ALICE|BOB]   # funds K_own from .env.local, then claims
```

That is what makes the last test the product rather than a transport check: Alice looks Bob up
**by name**, takes his key and Sui address off ENS, and messages him with nothing known in advance.

## Chat as one of them

```bash
node test/dm/chat.mjs whoami
node test/dm/chat.mjs read  <peer>            # --as BOB to switch wallet
node test/dm/chat.mjs send  <peer> "text"
node test/dm/chat.mjs read  <peer> --head 0x… # when discovery is unavailable (see below)
```

A human in the app and a wallet on the CLI can hold the same conversation — the only way to test
this as it is actually used.

## Inbox discovery — was broken, now fixed

`findHeads()` called `sui.queryEvents()`, and public Sui fullnodes now answer:

> Method not found. JSON-RPC on public fullnodes has been deprecated.

Verified 2026-08-21 against both `fullnode.testnet.sui.io` and `sui-testnet-rpc.publicnode.com`.
That call is the **only** way the app finds a conversation somebody else started, so a peer who was
messaged first saw an **empty inbox** — precisely what `findHeads`' own comment says it exists to
prevent. The platform moved under it; nothing in this repo changed.

Fixed by reading events over **Sui GraphQL** (`SUI.graphql`, `graphql.testnet.sui.io`). Object reads
(`getObject`, balances) are unaffected and still use JSON-RPC. The tier now asserts that **Bob**
discovers a head he never created — he is the one with no local state, so discovery is all that
stands between him and an empty screen.

Watch for the rest of the JSON-RPC surface going the same way: any other event or transaction query
will fail identically.

## Not covered yet
- **Two-way conversation.** §6.6 documents the head as **single-writer** for now, so Bob replying
  into the same head is deliberately not asserted — it is not a supported property yet.
- **Walrus upload relay flakiness.** Its public relay intermittently 500s; sends retry three times
  before failing, so a genuine write failure still surfaces.
- **Knock** — see `app/scripts/knock.test.mjs`.
