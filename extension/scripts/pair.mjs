#!/usr/bin/env node
// Two-person testing, on one machine, with one Telegram account.
//
//   npm run pair
//
// Launches two isolated browser profiles with the extension loaded, both on Telegram Web. Each
// profile is a separate extension install, so each generates its OWN handshake keypair — which is
// what makes them count as two different people. The Telegram account can be the same one; the
// identity that matters here belongs to the extension, not to Telegram.
//
// TWO WAYS TO USE THIS, and they are for different jobs:
//
//   A. One Telegram account, Saved Messages — for FUNCTION and STABILITY.
//      Both windows are the same account, so every bubble renders on the same side. It looks
//      nothing like a conversation, and that does not matter: what you are testing is that the
//      handshake converges, keys match, decode works, and a reset recovers.
//
//   B. Two Telegram accounts, one per window — for the DEMO.
//      Real left/right bubbles, because they genuinely are two people. Needs no change here: the
//      profiles are separate browser installs, so just log a different account into each.
//
// Either way each profile is its own extension install with its own handshake keypair — that, and
// not the Telegram account, is what makes them two parties. Profiles persist in .dev-profiles/,
// so the QR login is paid once per window.
import { spawn, execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DIST = join(ROOT, 'dist')
const PROFILES = join(ROOT, '.dev-profiles')
const URL = process.env.TG_URL || 'https://web.telegram.org/k/'

const CANDIDATES = [
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  'brave-browser', 'brave', 'microsoft-edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
]

function findBrowser() {
  if (process.env.BROWSER) return process.env.BROWSER
  for (const c of CANDIDATES) {
    if (c.startsWith('/')) {
      if (existsSync(c)) return c
      continue
    }
    try {
      return execSync(`command -v ${c}`, { encoding: 'utf8' }).trim()
    } catch {
      /* not installed */
    }
  }
  return null
}

if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('No build found. Run `npm run build` first.')
  process.exit(1)
}

const browser = findBrowser()
if (!browser) {
  console.error(
    'No Chromium-family browser found. Set BROWSER=/path/to/chrome and re-run.\n' +
      `Tried: ${CANDIDATES.filter((c) => !c.startsWith('/')).join(', ')}`,
  )
  process.exit(1)
}

console.log(`\nlortnoc — paired test windows`)
console.log(`  browser   ${browser}`)
console.log(`  extension ${DIST}`)
console.log(`  profiles  ${PROFILES}\n`)

for (const name of ['alice', 'bob']) {
  const dir = join(PROFILES, name)
  mkdirSync(dir, { recursive: true })
  const child = spawn(
    browser,
    [
      `--user-data-dir=${dir}`,
      `--load-extension=${DIST}`,
      `--disable-extensions-except=${DIST}`,
      // Without this the two windows can end up sharing one browser process, and with it each
      // gets its own extension instance — which is the entire point.
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=1100,900`,
      name === 'bob' ? '--window-position=1120,0' : '--window-position=0,0',
      URL,
    ],
    { detached: true, stdio: 'ignore' },
  )
  child.unref()
  console.log(`  ▸ ${name} launched`)
}

console.log(`
Pick the mode that matches what you are doing:

  TESTING (one account) — same account in both windows, open Saved Messages in both.
    Every bubble sits on the same side. Ugly, and irrelevant: you are checking the handshake,
    not the layout.

  DEMO (two accounts) — log a DIFFERENT Telegram account into each window and open the chat
    between them. Real two-sided conversation, because it is one.

Then, in both windows:
  1. Turn PrivacyMaxxing on in the popup.
  2. Confirm the console says:  [lortnoc] content script ready
     If that line is missing, stop — nothing else you observe means anything.
  3. Click Connect in ONE window; Accept in the other.
  4. Compare  [lortnoc] convKey fingerprint: …  — the two MUST match.

Then type. A message sent in either window should decode in both.

Worth rehearsing on purpose: reset one side (remove the extension, or clear its session storage)
and watch it re-handshake. That path used to strand both sides permanently.
`)
