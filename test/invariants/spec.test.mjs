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

/** Search tracked source only — build output, node_modules and vendored deps are not ours. */
function grepSource(pattern) {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-n', '-i', '-E', pattern, '--', ':!*/node_modules/*', ':!*/dist/*', ':!*/out/*',
       ':!*/lib/*', ':!*.zip', ':!CLAUDE.md', ':!README.md', ':!*/docs/*', ':!test/*', ':!*.md'],
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

  test('the extension only ever talks to Telegram through the DOM', () => {
    // A fetch to a telegram.org API endpoint would mean we hold a session credential.
    const hits = grepSource('fetch\\([^)]*api\\.telegram|telegram\\.org/(bot|api)')
    assert.deepEqual(hits, [], `a direct Telegram API call appeared:\n${hits.join('\n')}`)
  })
})

describe('§9 — this project must not use World ID', () => {
  test('no World ID SDK, widget or verification call', () => {
    const hits = grepSource('worldcoin|world-id|worldid|@worldcoin|idkit')
    assert.deepEqual(hits, [], `World ID appeared (§9 forbids it):\n${hits.join('\n')}`)
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
