// Knock crypto, exercised the way it will actually be used.
import { argon2id } from '@noble/hashes/argon2.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
const enc = new TextEncoder(), dec = new TextDecoder()
const hex = (u) => Array.from(u, b => b.toString(16).padStart(2,'0')).join('')
const unhex = (s) => Uint8Array.from(s.match(/../g).map(b => parseInt(b,16)))
const KDF = { t: 2, m: 19456, p: 1 }
const norm = (a) => a.trim().toLowerCase().replace(/\s+/g,' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,'')
const derive = (answer, salt) => argon2id(enc.encode(norm(answer)), unhex(salt), { ...KDF, dkLen: 32 })
const seal = (k, p) => { const n = crypto.getRandomValues(new Uint8Array(24))
  const ct = xchacha20poly1305(k, n).encrypt(enc.encode(JSON.stringify(p)))
  const o = new Uint8Array(n.length+ct.length); o.set(n); o.set(ct, n.length)
  return Buffer.from(o).toString('base64') }
const open = (k, s) => { try { const raw = new Uint8Array(Buffer.from(s,'base64'))
  return JSON.parse(dec.decode(xchacha20poly1305(k, raw.subarray(0,24)).decrypt(raw.subarray(24)))) } catch { return null } }

let fail = 0
const ok = (b, m) => { console.log(`  ${b?'\x1b[32m✓\x1b[0m':'\x1b[31m✗\x1b[0m'} ${m}`); if(!b) fail++ }

const salt = hex(crypto.getRandomValues(new Uint8Array(16)))
const payload = { v:1, pubkey:'0xabc123', from:'bob.lortnoctahc.eth', intro:'the bar in Lisbon', ts: 1 }

const kSender = derive('The Blue Door', salt)
const sealed = seal(kSender, payload)

console.log('\nknock crypto')
const kOwner = derive('the blue door', salt)
ok(open(kOwner, sealed)?.intro === payload.intro, 'right answer opens it (and normalises case/spacing)')
ok(open(derive('the blue door!', salt), sealed)?.pubkey === '0xabc123', 'trailing punctuation still opens it')
ok(open(derive('the red door', salt), sealed) === null, 'wrong answer returns null — never an error')
ok(open(derive('the blue door', hex(crypto.getRandomValues(new Uint8Array(16)))), sealed) === null,
   'right answer + wrong salt fails (salt domain-separates per person)')
ok(open(kOwner, 'not-base64!!') === null, 'garbage input returns null')
const tampered = Buffer.from(Buffer.from(sealed,'base64')); tampered[30] ^= 1
ok(open(kOwner, tampered.toString('base64')) === null, 'flipped ciphertext bit fails the auth tag')
ok(seal(kSender, payload) !== seal(kSender, payload), 'nonce is fresh per knock (no ciphertext reuse)')
ok(!sealed.includes('bob') && !sealed.includes('Lisbon'), 'the relay sees no plaintext')

console.log(fail === 0 ? '\n\x1b[32mALL PASS\x1b[0m\n' : `\n\x1b[31m${fail} FAILED\x1b[0m\n`)
process.exit(fail ? 1 : 0)
