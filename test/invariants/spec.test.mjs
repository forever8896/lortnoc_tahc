// CLAUDE.md §4 — "Non-negotiable invariants. Break any and the product stops being what it
// claims. Hard constraints in review."
//
// This file automates that review. These are policy assertions over the source itself, which
// is unusual for a test suite and correct here: the invariants are about what the code must
// NEVER do, and the cheapest reliable proof of a negative is that the construct does not
// appear. Each test names the invariant it guards so a failure reads as "you broke §4", not
// "a regex went red".
//
// Scope note: these catch the obvious, high-consequence regressions (a plaintext POST, a
// re-introduced bot token, a World ID import). They are a tripwire, not a proof.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { ROOT, source } from '../lib/env.mjs'

/**
 * The ONE sanctioned Telegram bot: the onboarding funnel (@lortnoctahc_bot). CLAUDE.md §4 forbids a
 * bot in the MESSAGING path — something acting as a user's Telegram account, which is where the
 * ban/ToS risk lives. A Bot API bot that people choose to message, holding no user session and
 * never touching the extension, is outside that rule; §4 records the carve-out.
 *
 * Exempted by EXACT path, never by directory: a bot token turning up anywhere else — above all in
 * extension/ or app/ — must still fail here. The test below proves the product never reaches in.
 */
const FUNNEL_BOT = ['site/api/tgbot.js', 'site/api/_lib/bot.js', 'site/scripts/tgbot-setup.mjs']

/** Search tracked source only — build output, node_modules and vendored deps are not ours. */
function grepSource(pattern, { includeFunnelBot = false } = {}) {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-n', '-i', '-E', pattern, '--', ':!*/node_modules/*', ':!*/dist/*', ':!*/out/*',
       ':!*/lib/*', ':!*.zip', ':!CLAUDE.md', ':!README.md', ':!*/docs/*', ':!test/*', ':!*.md',
       ...(includeFunnelBot ? [] : FUNNEL_BOT.map((f) => `:!${f}`))],
      { cwd: ROOT, encoding: 'utf8' },
    )
    return out.trim().split('\n').filter(Boolean)
  } catch (e) {
    if (e.status === 1) return [] // git grep: no matches
    throw e
  }
}

describe('§4 — no userbot, no MTProto, no held Telegram session credential', () => {
  test('no MTProto / Telegram API client library is present', () => {
    const hits = grepSource('mtproto|telethon|gramjs|telegram-bot-api|node-telegram|pyrogram')
    assert.deepEqual(hits, [], `a Telegram API client appeared:\n${hits.join('\n')}`)
  })

  test('no Telegram bot token is read or stored anywhere', () => {
    const hits = grepSource('bot_token|botToken|TELEGRAM_TOKEN|TG_BOT')
    assert.deepEqual(hits, [], `a bot token reference appeared:\n${hits.join('\n')}`)
  })

  test('the funnel bot is isolated — no product surface imports or references it', () => {
    // The carve-out above is only safe while the bot stays a separate funnel. If the extension,
    // app, codec or relayer ever import it or read its token, it has become part of the
    // messaging path, and §4 is broken no matter what the exemption says.
    const hits = grepSource('tgbot|_lib/bot\\.js|TG_BOT_TOKEN|TG_WEBHOOK_SECRET', { includeFunnelBot: true })
      .filter((h) => !FUNNEL_BOT.some((f) => h.startsWith(`${f}:`)))
      .filter((h) => /^(extension|extension-x|app|codec|relayer|shared)\//.test(h))
    assert.deepEqual(hits, [], `a product surface reaches into the funnel bot:\n${hits.join('\n')}`)
  })

  test('the extension only ever talks to Telegram through the DOM', () => {
    // A fetch to a telegram.org API endpoint would mean we hold a session credential.
    const hits = grepSource('fetch\\([^)]*api\\.telegram|telegram\\.org/(bot|api)')
    assert.deepEqual(hits, [], `a direct Telegram API call appeared:\n${hits.join('\n')}`)
  })
})

describe('§4 — the X overlay is DOM-only too (no API token, no OAuth)', () => {
  // PRD-x-extension.md §9. The Telegram design deliberately avoids MTProto and stored
  // credentials so there is no ban risk; the same rule has to hold on X, where the automation
  // rules are stricter. The failure this guards against is the tempting one — "just use the API,
  // it's so much easier than driving Draft.js" — which trades the whole no-credential property
  // for convenience, and does it in a single import nobody reviews closely.
  test('no X/Twitter API client library is present', () => {
    const hits = grepSource('twitter-api|twitter_api|twit\\b|@twurple|tweepy|node-twitter|twitter-lite')
    assert.deepEqual(hits, [], `an X API client appeared:\n${hits.join('\n')}`)
  })

  test('no X API credential or OAuth token is read or stored', () => {
    const hits = grepSource('bearer_token|bearerToken|TWITTER_TOKEN|X_API_KEY|consumer_secret|access_token_secret|oauth_token')
    assert.deepEqual(hits, [], `an X credential reference appeared:\n${hits.join('\n')}`)
  })

  test('the X extension only ever talks to X through the DOM', () => {
    const hits = grepSource('fetch\\([^)]*api\\.(x|twitter)\\.com|api\\.twitter\\.com/[0-9]')
    assert.deepEqual(hits, [], `a direct X API call appeared:\n${hits.join('\n')}`)
  })
})

describe('§9 — World ID only as an OPTIONAL reader check, never for writing or metering', () => {
  // Decided 2026-09-25 (docs/PRD-universal.md §11, §22.5): an author may require readers to be a
  // verified human (the `human` check). Nobody may ever need World ID to WRITE, and it must never
  // meter the free tier (§9 still meters by Telegram handle). So World ID is confined to the files
  // that implement that one reader check — anywhere else is a regression.
  const ALLOWED = /^(gate\/|shared\/checks\/human\.mjs|extension-everywhere\/(src\/reveal\/|src\/background\/|package(-lock)?\.json|manifest\.config\.ts))/
  const WORLD = 'worldcoin|world-id|worldid|@worldcoin|idkit'

  test('World ID appears only in the reader-check files', () => {
    const outside = grepSource(WORLD).filter((line) => !ALLOWED.test(line))
    assert.deepEqual(outside, [], `World ID appeared outside the optional reader check:\n${outside.join('\n')}`)
  })
  test('the writing path and the metering path never touch it', () => {
    const writing = grepSource(WORLD).filter((l) => /^(extension-everywhere\/src\/sheet\/|extension\/|extension-x\/|codec\/|app\/|relayer\/)/.test(l))
    assert.deepEqual(writing, [], `World ID reached a writing or metering surface:\n${writing.join('\n')}`)
  })
  test('the human check says what World ID cannot prove', () => {
    const human = source('shared/checks/human.mjs')
    assert.match(human, /does\s+(\/\/\s*)?NOT prove gender/i, 'the honest limit must stay written at the check')
    assert.match(human, /OPTIONAL/, 'the check must state that it is optional')
  })
})

describe('§4 — never host or transmit plaintext', () => {
  const index = source('extension/src/content/index.ts')

  test('the outbound path encrypts before it encodes', () => {
    // The compose interceptor receives `real` (the typed plaintext). The ONLY thing that may
    // reach the codec is the AES-SIV ciphertext.
    assert.match(index, /const ct = encrypt\(key, real\)/, 'the encrypt-before-encode step is gone')
    assert.match(index, /ciphertextB64: toB64\(ct\)/, 'ENCODE no longer sends the ciphertext')
  })

  test('the plaintext variable is never handed to the codec', () => {
    // Catches `ciphertextB64: toB64(enc.encode(real))` and similar shortcuts.
    assert.doesNotMatch(index, /ciphertextB64:\s*[^,\n]*\breal\b/, 'plaintext is being sent to the codec')
    assert.doesNotMatch(index, /coverText:\s*real\b/, 'plaintext is being sent as cover text')
  })

  test('a send with no key fails closed instead of sending plaintext', () => {
    assert.match(index, /if \(!key\) \{[\s\S]*?return null/, 'the no-key path no longer fails closed')
  })

  test('the codec service never logs request bodies (§8 Layer 4 gateway hygiene)', () => {
    assert.match(source('codec/server.py'), /def log_message\(self, \*_\):/, 'request logging was re-enabled')
  })
})

describe('§4 — key material stays on the device', () => {
  test('the conversation key is never sent over the wire', () => {
    const hits = grepSource('convKey.*(fetch|body:|JSON\\.stringify)|key:\\s*toB64\\(key\\)')
    assert.deepEqual(hits, [], `the conversation key may be leaving the device:\n${hits.join('\n')}`)
  })

  test('handshake key material is written to storage.session, never storage.local', () => {
    const session = source('extension/src/content/session.ts')
    assert.match(session, /chrome\.storage\.session\.set/, 'session persistence changed')
    assert.doesNotMatch(session, /chrome\.storage\.local\.set/, 'ephemeral key material now survives browser close')
  })

  test('no private key is written to a plain-text file by the app', () => {
    const hits = grepSource('writeFileSync\\([^)]*priv|localStorage\\.setItem\\([^)]*priv')
    assert.deepEqual(hits, [], `a private key may be persisted in the clear:\n${hits.join('\n')}`)
  })
})

describe('§4 — cover text stays plain', () => {
  test('the extension does not decorate cover text before sending', () => {
    // Markdown/emoji/smart quotes make Telegram normalise the text and byte-exact decoding
    // breaks. The compose path must pass the codec's output through untouched.
    const compose = source('extension/src/content/compose.ts')
    assert.doesNotMatch(compose, /coverText\s*[+.]=|`\*\*\$\{|\.replace\([^)]*['"][*_~`]/,
      'cover text is being decorated before send')
  })

  test('the wordmap fallback emits only lowercase ASCII words', async () => {
    // Behavioural check on the one backend that runs with no dependencies at all, so this
    // invariant is covered even where torch is absent. The model-backed backends are checked
    // in the integration suite against a live codec.
    const { stdout } = await runPython(
      'import os,wordmap;' +
      'covers=[wordmap.encode(os.urandom(1+os.urandom(1)[0])) for _ in range(50)];' +
      'print(all(c==c.strip() and "  " not in c and c.isascii() and all(ch.islower() or ch==" " for ch in c) for c in covers))',
    )
    assert.equal(stdout.trim(), 'True', 'the wordmap backend emitted non-plain cover text')
  })
})

describe('§4 — codec determinism (never route inference through hosted GPU)', () => {
  test('0G is used for cover SELECTION only, never for codec inference', () => {
    // §6.3/CF-1: hosted inference is non-deterministic and would break reversibility. 0G may
    // judge which of N covers reads best; it must never generate the token distribution.
    const zerog = source('codec/zerog.py')
    assert.match(zerog, /select_best/, 'zerog.py no longer exposes selection')
    assert.doesNotMatch(zerog, /logprobs/, '0G logprobs are being requested — CF-1 says they are unusable')
  })

  test('the coder never samples randomly from the model distribution', () => {
    // Reversibility requires the token to be chosen by ciphertext bits, not by sampling.
    const coder = source('codec/coder.py')
    assert.match(coder, /cands\[idx\]/, 'token selection is no longer bit-indexed')
    assert.doesNotMatch(coder, /random\.choice|multinomial|temperature/, 'the coder introduced sampling')
  })
})

describe('§8 — honesty in the pitch', () => {
  test('the codec reports how a cover was actually selected (no blind 0G claim)', () => {
    // Regression guard for the fix in 903cba3: the UI must not claim 0G judged a cover when
    // selection silently fell back.
    assert.match(source('codec/codec.py'), /return zerog\.select_best\(covers\)/)
    assert.match(source('codec/server.py'), /"select": select/, 'the honest selection signal was dropped')
    assert.match(source('extension/src/content/index.ts'), /select === 'fallback'/,
      'the client no longer distinguishes a real 0G judgement from a fallback')
  })
})

// --- helpers ---------------------------------------------------------------
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)

function runPython(code) {
  return execFileAsync('python3', ['-c', code], { cwd: `${ROOT}/codec`, encoding: 'utf8' })
}
