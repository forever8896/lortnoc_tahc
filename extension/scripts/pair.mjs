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
// Use **Saved Messages** as the chat. Messages you send appear in both windows, the inbound
// observer watches outgoing bubbles as well as incoming ones, and `isMine()` compares against the
// LOCAL keypair — so window B genuinely treats window A's offer as a stranger's.
//
// Profiles persist in .dev-profiles/, so you log into Telegram once per window and never again.
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
Next:
  1. Log the SAME Telegram account into both windows (QR from your phone). One time only —
     the profiles persist.
  2. Open **Saved Messages** in both.
  3. Turn PrivacyMaxxing on in both popups.
  4. Click Connect in ONE window; Accept in the other.
  5. Watch both consoles for:  [lortnoc] convKey fingerprint: …   ← must match.

Then type. A message sent in either window should decode in both.

Reset a side the way a real user would — remove the extension, or clear its session storage — and
watch it re-handshake. That is the path that used to strand people permanently.
`)
