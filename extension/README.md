# extension — Telegram Web stego overlay

MV3 Chrome extension (CRXJS + Vite + TS). Types real, sends **cover text**, decodes a peer's
cover text back **inline** — on `web.telegram.org/k/`. Plaintext and the key never leave the page;
the codec sees ciphertext only (invariant §4). See `docs/PRD-extension.md`.

## Run

```bash
# 1. start the codec (separate terminal), expose it for the two-laptop demo:
cd ../codec && python3 server.py
#    cloudflared tunnel --url http://localhost:8080   # -> hosted URL for both laptops

# 2. build the extension
npm install
npm run build           # -> dist/   (or: npm run dev for HMR)

# 3. load it: chrome://extensions → Developer mode → Load unpacked → select extension/dist
```

Then, in the popup: enter the **same passphrase** on both laptops, set the **Codec URL** (the tunnel
URL, or `http://localhost:8080` locally), and toggle **Stego** on. Open a chat and type — it sends as
cover text; the peer sees it decoded inline.

## Verify

```bash
npm run typecheck                 # tsc, clean
node test/pipeline.test.mjs       # end-to-end crypto↔codec proof (codec must be running)
```

`pipeline.test.mjs` exercises the whole data path minus the DOM: real→AES-SIV→/encode→cover→/decode→
verify→decoded, plus the wrong-passphrase detector and the not-ours (422) path.

## Structure

```
src/
  content/index.ts       orchestrator (wires outbound + inbound)
  content/selectors.ts   all Telegram-K selectors, one place
  content/compose.ts     read / replace (execCommand) / send-intercept (.btn-send.click)
  content/inbound.ts     MutationObserver, dedupe by data-mid, inline render
  content/crypto.ts      HKDF + AES-SIV (@noble) — the ONLY place with plaintext/key
  content/state.ts       enabled/codecUrl/key, synced from chrome.storage
  content/ui.ts          injected styles, shuffle animation, decoded marker
  background/index.ts     service worker: ENCODE/DECODE/HEALTH broker → codec
  popup/                 toggle, passphrase, codec URL, health pill
```

## Status vs PRD milestones

- **M1–M3 (built & verified minus DOM):** scaffold, SW↔codec plumbing, outbound swap, inbound decode,
  crypto, popup. `pipeline.test.mjs` green.
- **M0 (needs a live browser):** the Telegram-Web byte-exactness spike — load unpacked, confirm
  `execCommand('insertText')` + `.btn-send.click()` sends byte-exact cover text on the current Web K
  build. **This is the one thing to verify live before relying on the flow.**
- **Codec:** `../codec` is the deterministic `wordmap-256` placeholder; the GPT-2 arithmetic coder
  swaps in behind the same HTTP contract (no extension change).

## Notes

- Targets **Web K** (`web.telegram.org/k/`). On Web A it warns and no-ops (A support is later).
- Global Stego toggle for the demo; per-chat gating is a fast-follow.
- Fail-closed: any codec/decrypt/selector error shows the original cover text, never plaintext.
