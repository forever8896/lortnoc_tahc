import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { aessiv } from '@noble/ciphers/aes.js'
const enc = new TextEncoder(), dec = new TextDecoder()
const ECDH_SALT = enc.encode('lortnoc/conv/x25519/v1')
const cmp = (a,b) => { for (let i=0;i<a.length;i++) if (a[i]!==b[i]) return a[i]-b[i]; return 0 }
const gen = () => { const priv = crypto.getRandomValues(new Uint8Array(32)); return { priv, pub: x25519.getPublicKey(priv) } }
const conv = (myPriv, theirPub, myPub) => {
  const shared = x25519.getSharedSecret(myPriv, theirPub)
  const [a,b] = [myPub, theirPub].sort(cmp)
  const info = new Uint8Array(a.length+b.length); info.set(a); info.set(b, a.length)
  return hkdf(sha256, shared, ECDH_SALT, info, 64)
}
const fp = (k) => Array.from(k.slice(0,6), b=>b.toString(16).padStart(2,'0')).join('')
let fail = 0
const ok = (b,m) => { console.log(`  ${b?'\x1b[32m✓\x1b[0m':'\x1b[31m✗\x1b[0m'} ${m}`); if(!b) fail++ }

// normal: A offers, B accepts
const A = gen(), B = gen()
const kA = conv(A.priv, B.pub, A.pub), kB = conv(B.priv, A.pub, B.pub)
ok(fp(kA) === fp(kB), `A and B derive the same key (${fp(kA)})`)

// a message encrypted by B opens for A — the thing that was broken
const ct = aessiv(kB).encrypt(enc.encode('their message'))
ok(dec.decode(aessiv(kA).decrypt(ct)) === 'their message', "A can open B's message (not just its own)")

// glare: both offer, both accept the other's offer
const kA2 = conv(A.priv, B.pub, A.pub), kB2 = conv(B.priv, A.pub, B.pub)
ok(fp(kA2) === fp(kB2), 'glare (both Connect) still converges on one key')

// peer restarts with a NEW keypair — old key must NOT open new messages
const B2 = gen()
const kB2new = conv(B2.priv, A.pub, B2.pub)
const ct2 = aessiv(kB2new).encrypt(enc.encode('after restart'))
let opened = true; try { aessiv(kA).decrypt(ct2) } catch { opened = false }
ok(!opened, 'after peer restarts, the stale key fails (this is what re-handshake now fixes)')
ok(fp(conv(A.priv, B2.pub, A.pub)) === fp(kB2new), 're-handshaking with the new pubkey converges again')

console.log(fail===0 ? '\n\x1b[32mALL PASS\x1b[0m\n' : `\n\x1b[31m${fail} FAILED\x1b[0m\n`)
process.exit(fail?1:0)
