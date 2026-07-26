// Mirrors app/src/lib/crypto.ts: deriveMasterSecret + deriveOwnerKey, so the CLI can address the
// same owner the browser would derive.
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { privateKeyToAccount } from 'viem/accounts'
const enc = new TextEncoder()
const hex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('')

const seed = Buffer.from(process.env.PRIVATE_KEY.replace(/^0x/, ''), 'hex')
const ms = hkdf(sha256, seed, enc.encode('lortnoc/ms/v1'), enc.encode('master'), 32)
const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
for (let i = 0; i < 256; i++) {
  const priv = hkdf(sha256, ms, enc.encode(`lortnoc/evm/secp256k1/v1${i ? `/${i}` : ''}`), enc.encode('owner'), 32)
  const n = BigInt('0x' + hex(priv))
  if (n > 0n && n < ORDER) {
    const acct = privateKeyToAccount('0x' + hex(priv))
    console.log(acct.address)
    break
  }
}
