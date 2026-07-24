# PRD — lortnoc_tahc Browser Extension (Telegram Web stego overlay)

## Context

This is the **P0 hero** of lortnoc_tahc (CLAUDE.md §6.1): a Chrome MV3 extension that, inside the user's own
Telegram Web session, swaps a typed message for innocuous **cover text** before it sends, and decodes a peer's cover
text back **inline** on receive. Everyone else sees harmless chatter. This PRD scopes *only the extension + the codec
contract it depends on* — enough to build the winning demo to fruition. Prizes (Sui/ENS/0G), native mode, ENS
handles, and the in-band key handshake are **out of scope here** (separate tracks). Research (2026) confirms the
approach is buildable and pins the fragile parts; a near-exact reference implementation exists (`NebulaEncrypt`).

**Locked decisions:** demo topology = **two laptops, two people** → **one hosted codec** both extensions call
(determinism automatic, no Chrome-142 loopback prompt). Build tool = **CRXJS** (`@crxjs/vite-plugin` 2.7.x). Codec =
local, deterministic **HuggingFace GPT-2 (CPU)** service (CLAUDE.md §6.2). Crypto = **AES-SIV** client-side.

---

## 1. Goals / Non-goals

**Goals (this PRD):**
- G1 — On Telegram Web, a stego-enabled chat sends **cover text**; the peer's extension renders the **decoded** real
  message inline. Onlookers/Telegram see only chatter.
- G2 — Plaintext and the key **never leave the page** (invariant §4). The codec sees ciphertext only.
- G3 — Robust, demoable: per-chat toggle, fail-closed on bad decode, latency masked by a "shuffle" animation.

**Non-goals (explicitly out):** ENS/Sui/0G integration · native mode · in-band Tier-1 handshake (use a pre-shared
key) · group chats · message history backfill · custom-emoji fidelity in decoded text · Firefox/Safari · realtime
niceties. Multi-writer, discoverability, knock, payments — all later.

## 2. Users & core use case

Two people who both installed the extension and share a passphrase. Alice types "meet at 8" in a toggled-on chat →
Telegram stores/sends "the weather's been nice lately…" → Bob's extension shows "meet at 8" in place of the cover
bubble. A third person reading the chat sees only the cover text.

## 3. Architecture (two-laptop topology)

```
 Laptop A                                   Laptop B
 ┌─────────────────────────────┐            ┌─────────────────────────────┐
 │ Chrome + extension          │            │ Chrome + extension          │
 │  content script (web.tg/k/) │            │  content script (web.tg/k/) │
 │  ├ read/replace compose     │            │                             │
 │  ├ observe inbound bubbles  │            │                             │
 │  ├ AES-SIV (client-side)    │            │  AES-SIV (client-side)      │
 │  popup: toggle + passphrase │            │  popup: toggle + passphrase │
 │  service worker ──fetch──┐  │            │  service worker ──fetch──┐  │
 └──────────────────────────┼──┘            └──────────────────────────┼──┘
                            │  ciphertext only (never plaintext/key)   │
                            └───────────────►  ┌───────────────────┐ ◄─┘
                                               │  HOSTED CODEC (1)  │
                                               │  /encode /decode   │
                                               │  GPT-2 CPU, warm,   │
                                               │  deterministic      │
                                               └───────────────────┘
```

One codec process serves both ends → encode-time and decode-time distributions are identical by construction
(reversibility guaranteed). Exposed via a stable HTTPS URL (Cloudflare Tunnel / small VM). Both extensions carry that
URL in `host_permissions`; the **service worker** does the fetch (bypasses page CORS via host permission).

## 4. Components

**A. Content script** (`web.telegram.org/k/*`, ISOLATED world) — the only place that touches plaintext/key:
- Reads the compose draft, does AES-SIV encrypt, asks SW to `/encode`, replaces compose with cover text, triggers
  send. Observes inbound bubbles, asks SW to `/decode`, AES-SIV decrypt, renders decoded text inline.
- Holds the derived `K_conv` in memory (from the passphrase); never persisted in plaintext.

**B. Service worker** (background) — the network broker. Receives `{type:'ENCODE'|'DECODE', payload}` via
`chrome.runtime.sendMessage`, fetches the hosted codec, returns the result. `return true` for async response. Stateless
(SW may cold-start per request).

**C. Popup UI** — per-chat **stego on/off** toggle, passphrase entry (→ derive & cache `K_conv`), codec URL field,
and a live status pill (`codec ok` / `codec offline`).

**D. Codec service** (dependency, sibling track; contract in §7) — `POST /encode`, `POST /decode`, `GET /health`.
Deterministic GPT-2 arithmetic coder, model warm, one hosted instance.

## 5. Functional requirements

- **FR1 Load & detect.** Content script injects on `web.telegram.org/k/*`; detect client by path (`/k`). Fail loudly
  if key selectors resolve null (surface "unsupported Telegram build").
- **FR2 Key setup.** Popup: enter passphrase → `K_conv = AES-SIV-key(HKDF-SHA256(passphrase, salt="lortnoc/conv",
  info=convScope))`. Cache in the content script's memory for the session. (Pre-shared for the demo; both users type
  the same phrase.)
- **FR3 Per-chat toggle.** Stego applies only in chats the user toggled on. Toggle state persisted per chat id.
- **FR4 Outbound.** On send intercept: read compose text → `AES-SIV.encrypt(K_conv, realText)` → SW `/encode` →
  replace compose with cover text → play shuffle animation → trigger real send. Plaintext never leaves the page.
- **FR5 Inbound.** For each new/changed inbound bubble in a toggled chat: SW `/decode` → `AES-SIV.decrypt`. **Valid
  auth tag ⇒ replace the bubble's rendered text with the decoded message inline (visually marked); invalid ⇒ leave
  the bubble untouched.** Dedupe by `data-mid`; treat late text-fill/edits as updates.
- **FR6 Fail-closed.** Any error (codec offline, decode fail, selector miss, Telegram normalized the text) ⇒ show the
  original cover text, never a crash, never plaintext leakage. Status pill reflects codec reachability.
- **FR7 Cover-text safety.** Outbound cover text must be plain ASCII words only — no markdown-significant chars,
  emoticons, URL-like tokens, or edge/repeated whitespace (client-side transforms would corrupt it). Codec's output
  alphabet is constrained accordingly.

## 6. Technical design (the fragile parts, pinned)

**Target Web K (`/k/`).** Semantic, durable selectors; source readable in `morethanwords/tweb`. Detect `/a/` and
degrade gracefully (K first; A is a later add). Centralize all selectors in one `selectors.ts` config; fail loudly on
null.

**Compose is a `contenteditable` div** — `div.input-message-input[contenteditable="true"]` (target the one in the
*active, visible* `.chat-input`; multiple exist).
- **Read:** `el.innerText`.
- **Replace (critical):** `el.focus(); getSelection().selectAllChildren(el); document.execCommand('insertText',
  false, coverText)`. Do **NOT** set `.textContent`/`.innerText` alone — the framework keeps a controlled model
  rebuilt from `input`/`beforeinput` events and would send stale text. Fallback: set `innerText` + dispatch
  `new InputEvent('input', {bubbles:true})`.

**Send** — Web K send button `button.btn-send` (present only when field non-empty). Strategy: capture-phase `keydown`
on the input; on send shortcut (`Enter && !shift`, honoring ctrl-enter setting) `preventDefault()` +
`stopImmediatePropagation()`, run the replace, then **`document.querySelector('.btn-send').click()`**. Synthetic
`Enter` will **not** send (`isTrusted:false`); `.click()` invokes the bound handler. Guard re-entrancy with a flag.
Swap **only at send** (not per keystroke) so Telegram's draft-autosave never persists real *or* cover text early.
*Fallback if programmatic send is flaky on a build:* a "transform now, you press send" mode (stage cover text in the
field, user hits send) — NebulaEncrypt's low-fragility default; keep as a toggle.

**Inbound** — container `.bubbles`; incoming `.bubble.is-in`, text `.bubble.is-in .message`. `MutationObserver` on
`.bubbles` (re-attach on chat switch) with `{childList:true, subtree:true, characterData:true}`; debounce ~200–300ms.
Dedupe by bubble `data-mid`; handle "text filled/edited on an existing mid" as an update. `textContent` is lossy
(custom emoji become nodes) — accept for the demo.

**Network** — SW-routed fetch to the hosted codec URL (in `host_permissions`); bypasses page CORS. Public HTTPS host
⇒ no mixed-content/loopback (Chrome-142 LNA) prompt. Handle SW cold-start (no in-memory state).

**Crypto** — `@noble/ciphers` 2.x `aessiv` (RFC 5297; **decrypt throws on tag mismatch = the "is this ours?"
detector**) + `@noble/hashes` 2.x `hkdf`/`sha256`. AES-SIV needs a double-length key (64B → AES-256-SIV). WebCrypto
has no SIV (has HKDF) — noble is the pick. **Drop `miscreant`** (archived/unmaintained). Verify `aessiv` arg order
against the installed 2.x typings.

## 7. Codec service contract (dependency — sibling track)

```
POST /encode  { ciphertext: base64 }  → { coverText: string }   # plain ASCII words only
POST /decode  { coverText: string }   → { ciphertext: base64 }
GET  /health                          → { model, digest, ready }
```
Deterministic: byte-identical model + greedy/`temp=0`; `decode(encode(x)) == x` for all byte strings; one warm hosted
instance so both ends share the exact process. **Stub first** (echo/identity codec) so the extension is built and
tested end-to-end before the real GPT-2 coder lands. Sees ciphertext only.

## 8. Repo layout & stack

```
extension/                 # CRXJS + Vite + TypeScript (this PRD)
  manifest.config.ts       # MV3; matches web.telegram.org/k/*, /a/*; host_permissions:[codec URL]
  vite.config.ts           # crx({ manifest })
  src/
    content/index.ts       # inject, orchestrate outbound/inbound
    content/selectors.ts    # all Telegram-K selectors, one place
    content/compose.ts      # read / replace / send-intercept
    content/inbound.ts      # observer, dedupe, inline render
    content/crypto.ts       # HKDF + AES-SIV (noble)
    background/index.ts     # SW: ENCODE/DECODE broker
    popup/                  # toggle, passphrase, codec URL, status
codec/                     # Python + HF transformers (sibling track; contract §7)
```
Deps: `@crxjs/vite-plugin@^2.7`, `vite`, `typescript`, `@noble/ciphers@^2`, `@noble/hashes@^2`.

## 9. Milestones & acceptance criteria (de-risk first)

- **M0 — 🔑 Byte-exactness spike (blocker).** Minimal content script on Web K: read compose, replace with a known
  constrained ASCII string via `execCommand('insertText')`, send, read the inbound bubble back, assert **byte-
  identical**. *Accept:* round-trips identical on the live client. **If this fails, stop and rethink cover-text
  alphabet before building further.**
- **M1 — Scaffold + plumbing.** CRXJS MV3 loads on Telegram Web; popup toggle; SW ↔ content messaging; SW reaches the
  hosted codec `/health`. *Accept:* status pill shows `codec ok`.
- **M2 — Outbound with stub codec.** Send intercept → AES-SIV encrypt → `/encode` (echo) → replace → `.btn-send`
  send. *Accept:* toggled chat sends the (stub) cover text via the button path.
- **M3 — Inbound with stub codec.** Observer → `/decode` → AES-SIV verify → inline render; invalid tag left alone.
  *Accept:* a self-sent stego message renders decoded on the peer; a normal message is untouched.
- **M4 — Real codec swap.** Point at the GPT-2 hosted codec. *Accept:* two laptops, same passphrase, hold a hidden
  conversation; onlooker sees chatter.
- **M5 — Demo polish.** Shuffle animation, fail-closed paths, selector-miss messaging, short-thread demo script,
  transform-then-send fallback toggle.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Telegram normalizes cover text** (markdown/emoticon/whitespace) → decode fails | FR7 constrained ASCII alphabet; M0 proves it before building; fail-closed |
| **contenteditable send sends stale text** | `execCommand('insertText')` + `input` event, never `textContent`; `.btn-send.click()` not synthetic Enter |
| **Selectors drift across TG builds** | one `selectors.ts`; detect-and-fail-loudly; K (semantic) not A |
| **Virtualized bubbles re-decode** | dedupe by `data-mid`; treat text-fill/edit as update |
| **Codec latency (~1–3s)** | shuffle animation (outbound); short demo threads; keep model warm |
| **Hosted codec reachability on stage** | health pill; run tunnel + codec before demo; local fallback instance ready |
| **Draft-autosave leaks text to TG** | swap only at send instant, never per keystroke |
| **Custom-emoji loss in decoded text** | accept for demo; codec alphabet avoids emoji |

## 11. Verification

- **Unit:** `crypto.ts` — `AES-SIV.decrypt(encrypt(x)) == x`; wrong key ⇒ throws (detector works).
- **M0 harness:** automated DOM read-back asserting byte-equality post-send on `web.telegram.org/k/`.
- **Codec contract:** `decode(encode(x)) == x` for 100 random payloads; deterministic across restarts.
- **End-to-end:** two laptops, shared passphrase, toggled chat → hidden conversation; onlooker profile sees only
  cover text; toggling off shows raw cover text (fail-closed).

## 12. References (read the source)

- **`NebulaEncrypt`** (`github.com/dmitrymalakhov/NebulaEncrypt`) — closest prior art: MV3 content script that
  encrypts/decrypts Telegram messages; A/K detection; `execCommand('insertText')` replace; `.bubble.is-in .message`
  reads; body MutationObserver + 300ms debounce. **Reference implementation.**
- **`morethanwords/tweb`** — authoritative Web K selectors (`src/components/chat/input.ts`: `btn-send`,
  `isSendShortcutPressed`, `getRichValueWithCaret`).
- **`Ajaxy/telegram-tt`** — Web A selectors (`MessageInput.tsx`: `#editable-message-text`, `isSendShortcut`).
- **`@noble/ciphers`** (`github.com/paulmillr/noble-ciphers`), **`@noble/hashes`** — crypto.
- **CRXJS** (`crxjs.dev`, `@crxjs/vite-plugin` 2.7.x). **Chrome LNA** (`developer.chrome.com/blog/local-network-access`)
  — irrelevant while codec is a public host; revisit only if a localhost codec is ever used.
