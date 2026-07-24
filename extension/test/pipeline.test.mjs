// End-to-end proof of the extension's data path WITHOUT a browser: it replicates
// content/crypto.ts + the service-worker codec calls, against a running codec.
//   1. start the codec:  (cd ../../codec && python3 server.py)
//   2. run:              node pipeline.test.mjs
import { aessiv } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

const CODEC = process.env.CODEC || 'http://localhost:8080'
const enc = new TextEncoder()
const dec = new TextDecoder()

// --- mirror content/crypto.ts ---
const SALT = enc.encode('lortnoc/conv/aes-siv/v1')
const INFO = enc.encode('demo')
const deriveKey = (pass) => hkdf(sha256, enc.encode(pass), SALT, INFO, 64)
const encrypt = (key, pt) => aessiv(key).encrypt(enc.encode(pt))
const tryDecrypt = (key, ct) => {
  try { return dec.decode(aessiv(key).decrypt(ct)) } catch { return null }
}
const toB64 = (b) => Buffer.from(b).toString('base64')
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'))

// --- mirror background/index.ts codec calls ---
const codecEncode = async (b64) => {
  const r = await fetch(`${CODEC}/encode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ciphertext: b64 }) })
  if (!r.ok) throw new Error(`encode ${r.status}`)
  return (await r.json()).coverText
}
const codecDecode = async (coverText) => {
  const r = await fetch(`${CODEC}/decode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coverText }) })
  if (!r.ok) return { status: r.status, ciphertext: null }
  return { status: 200, ciphertext: (await r.json()).ciphertext }
}

let failures = 0
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++ }

const key = deriveKey('correct horse battery staple')
const wrongKey = deriveKey('wrong passphrase')

// 1. full outbound → inbound round-trip
const real = 'meet at 8 by the north gate'
const cover = await codecEncode(toB64(encrypt(key, real)))
console.log(`  real:  "${real}"`)
console.log(`  cover: "${cover}"`)
const back = await codecDecode(cover)
check('cover text is plain lowercase ASCII words', /^[a-z ]+$/.test(cover))
check('peer with same passphrase decodes to the original', back.status === 200 && tryDecrypt(key, fromB64(back.ciphertext)) === real)

// 2. detector: wrong passphrase → tag mismatch → not rendered
check('wrong passphrase fails the auth tag (returns null)', tryDecrypt(wrongKey, fromB64(back.ciphertext)) === null)

// 3. a normal (non-codec) Telegram message → codec 422 → treated as not-ours
const normal = await codecDecode('hey are you free tonight')
check('a normal message is not codec cover text (422)', normal.status === 422)

// 4. determinism: same input twice → identical cover text
const c2 = await codecEncode(toB64(encrypt(key, real)))
check('deterministic: identical real text → identical cover text', c2 === cover)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
