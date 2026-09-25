# extension-x — lortnoc tahc for X

Steganographic posting for X (Twitter). Same codec, same crypto, same framing as the Telegram
overlay in `extension/`; a different DOM and a **different threat model**.

Design: `docs/PRD-x-extension.md`. Read §3 before writing any copy about this.

## State — Modes 1 and 3 work end to end, threading included

| Piece | State |
|---|---|
| Wire format v2 (`shared/xframe.mjs`) | Done — `test/unit/xframe.test.mjs` |
| Compression (`shared/squeeze.mjs`) | Done — `test/unit/squeeze.test.mjs`; −43% of plaintext |
| `K_public` (`shared/keys.mjs::derivePublicChannelKey`) | Done — pinned by `test/unit/parity.test.mjs` |
| Outbound: squeeze → encrypt → split → `/encode` → post | Done — `src/content/{index,compose}.ts` |
| Inbound: hashtag filter → `/decode` → reassemble → decrypt | Done — `src/content/inbound.ts` |
| Threading (multi-post, out-of-order reassembly) | Done — `layoutThread` + `ThreadCollector` |
| Popup: on/off, codec URL, health pill | Done — `src/popup/` |
| **Mode 3 (named recipients)** — the product | Done — `shared/envelope.mjs`, ENS resolution in the SW |
| Identity unlock (passphrase → K_msg) | Done — `src/content/identity.ts`, session-only |
| Mode 2 (shared answer) | Not built — and gated on a *generated* passphrase, see PRD §3 |

**How many posts a message costs**, measured through the shipped modules against a live GPT-2
codec, with the arithmetic coder (`coder: 'arith'`, which this build requests on every call):

| message | posts |
|---|---|
| `no`, `lunch tomorrow?`, `bring the thing` | **1** |
| `meet at 8`, `ok see you there` | 2 |
| `the package is in the usual place ok` | 3 |
| `call me when you land, same number as before` | 4 |

That is 17 posts across the eight test messages, down from 27 before the arithmetic coder, frame
v2 and compression landed.

**Mode 3** (recipients set in the popup) costs more, because the envelope scales with recipient
count — measured, live codec, every reader verified and a stranger verified blind:

| recipients | overhead | posts for `meet at 8` |
|---|---|---|
| 1 | 65 B | 5 |
| 2 | 81 B | 7 |
| 4 | 113 B | 10 |

Leaving the recipients field empty selects Mode 1. The mode travels in the frame, so a reader never
guesses.

**What still dominates both modes is the 16-byte AES-SIV tag** — at ~11 cover characters per byte
it spends ~180 characters, more than most messages. It cannot simply be truncated (in RFC 5297 the
16-byte value *is* the CTR IV), so shrinking it is an open crypto decision, not a tweak.

## Why this is a separate extension

PRD §10 Q2. X ships without risking the working Telegram build, and the store listing is easier to
explain. **The cost is the failure mode `shared/keys.mjs` exists to prevent** — two surfaces that
hand-roll the same format, agree today, and drift silently until each reads only its own posts. So
the split is at the *surface* layer only:

- **Forked (surface):** `selectors.ts`, `compose.ts`, `inbound.ts`, `ui.ts`, `state.ts`, manifest.
- **Shared (never copied):** key derivation and the AES-SIV envelope (`shared/keys.mjs`), the wire
  format (`shared/xframe.mjs`), the compression dictionary (`shared/squeeze.mjs`), the Mode 3
  envelope (`shared/envelope.mjs`). `src/content/crypto.ts` is a re-export and nothing else.

If you find yourself about to inline a key derivation, a frame layout or a dictionary here, that
is the bug. The compression table is consensus-critical in the same way the HKDF labels are:
entries are addressed by index, so inserting one in the middle renumbers everything after it and
messages squeezed under the old table decode to *different words* under the new one — no
exception, no failed tag, just wrong text. Append only.

**The codec is shared too, and that is the sharper edge.** Both extensions call the same codec
instance, so this build names its coder (`coder: 'arith'`) on every request rather than relying on
a server default. Changing that default would otherwise reach into the Telegram build and stop
every message already in a Telegram chat from decoding.

## Mode 1 is obfuscation, not encryption

`K_public` derives from a constant that ships inside a public MIT-licensed extension, so anyone can
extract it in minutes. It delivers *"you need the tool to read this"* — never *"only authorised
people can read this."* The popup says so, and **the UI must never show a lock in this mode**
(PRD §5). Confidentiality lives in Mode 3 — set recipients in the popup.

## Develop

```bash
npm install
npm run build          # -> dist/, load unpacked in chrome://extensions
npm run dev            # HMR
npm run typecheck
```

Tests live in the root six-tier suite, not here — `npm test` from the repo root, or
`node test/run.mjs unit`.

A local codec beats the hosted one for development (the hosted instance is paused during the closed
alpha), and the dependency-free backends need nothing installed:

```bash
cd ../codec && CODEC_BACKEND=markov CODEC_AUTH=0 PORT=8099 python3 server.py
```

Then set the codec URL to `http://127.0.0.1:8099` in the popup's Advanced panel.

⚠️ **Encode and decode must hit the SAME codec process** (CLAUDE.md §6.2). Reversibility depends on
byte-identical model state at both ends; two instances is how "the codec is broken" bugs are born.

## Testing this build

**1. Load it.** `npm run build`, then `chrome://extensions` → Developer mode → Load unpacked →
`extension-x/dist`.

**2. Point it at a codec.** The hosted default (`lortnoc-codec.fly.dev`) is **live again as of
2026-08-18**, running `gpt2/k6` with 0G best-of-2, metered at 10 free sends per bucket. Verified
round-tripping the shipped modules end to end — `meet at 8` lands in a single 195-character post.

If it is ever paused again the popup shows an amber **`codec paused`** pill rather than green: a
paused codec answers `/health` with 200 (deliberately — a non-200 would flip every installed
extension to "offline" and bury the reason) while refusing `/encode` with 503. To run your own:

```bash
cd ../codec && CODEC_BACKEND=markov CODEC_AUTH=0 CODEC_CODER=arith CODEC_TOPN=256 PORT=8099 python3 server.py
```

`markov` needs nothing installed and is fast; `gpt2` needs `torch` + `transformers` and is what
production runs. Set `http://127.0.0.1:8099` in the popup's Advanced panel.

**3. Run the self-test — do this before touching X.** The Diagnostics panel round-trips a real
message through compress → encrypt → frame → codec → decode → decrypt, in Mode 1, threaded, and
Mode 3, plus a stranger-is-blind check and a resolve of any handles you have configured. It needs
no X page and no second person, so a failure tells you the problem is *below* the DOM. If the
self-test is green and posting still fails, the problem is the page layer.

**4. Then try a post.** Toggle on, type in the X composer, Ctrl/Cmd+Enter or click Post.

### What you cannot test solo yet

Mode 3 **sending** works against any published handle — `lortnoc.lortnoctahc.eth` resolves and has
a real `eth.lortnoc.pubkey`. Mode 3 **receiving** needs the private half of a published handle, and
this extension derives its identity from a passphrase while published handles were derived from the
app's wallet signature. So a solo end-to-end read needs either the app to publish your
extension-derived pubkey (shown in the popup once unlocked), or a second install. The self-test
covers the crypto path in the meantime by sealing to a locally-generated recipient.

## DOM notes that cost time

All verified against live x.com during the §7 spike, not guessed:

- The composer is **Draft.js** (`public-DraftEditor-content`). `execCommand('insertText')` reaches
  its controlled model; setting `innerText` does **not**, so there is deliberately no fallback —
  it would post stale text.
- Use `execCommand('selectAll')`, **never** `getSelection().selectAllChildren(el)`. On an empty
  composer the latter **doubles** the inserted text, which is invisible for tweet 1 (always
  non-empty) and breaks every later tweet in a thread.
- The post button flips between `tweetButton` and `tweetButtonInline` mid-session. Query both.
- Plain Enter is a newline here; **Ctrl/Cmd+Enter** is the post shortcut.
- Rapid repeated `execCommand` cycles froze the renderer for 45s. Space out thread posts.
- The feed is **virtualised**, so dedupe by the permalink status id (`selectors.ts::tweetId`),
  never by DOM node or position.
