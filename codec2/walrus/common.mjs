// Shared by flush.mjs and recover.mjs: the network, the signer, and the index cipher.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography'
import { walrus as walrusExtension } from '@mysten/walrus'

export const NETWORK = process.env.WALRUS_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
// gRPC, not JSON-RPC: every public Sui JSON-RPC endpoint (Mysten, publicnode, Blast) refuses since
// ~2026-10 ("deprecated, use gRPC"). @mysten/walrus 0.6 could only speak JSON-RPC, hence 1.x.
const GRPC = { testnet: 'https://fullnode.testnet.sui.io:443', mainnet: 'https://fullnode.mainnet.sui.io:443' }[NETWORK]
const RELAY = { testnet: 'https://upload-relay.testnet.walrus.space', mainnet: 'https://upload-relay.mainnet.walrus.space' }[NETWORK]
export const GRAPHQL = { testnet: 'https://graphql.testnet.sui.io/graphql', mainnet: 'https://graphql.mainnet.sui.io/graphql' }[NETWORK]

export const sui = new SuiGrpcClient({ network: NETWORK, baseUrl: process.env.SUI_GRPC || GRPC }).$extend(walrusExtension({
  // The relay is paid per upload. Mainnet asks 40 MIST per KiB of ENCODED size (~64 MiB for any quilt)
  // ≈ 2.6M MIST ≈ 0.0026 SUI (read from /v1/tip-config 2026-10-12); testnet asks far less. The old
  // cap of 1000 MIST would have had every mainnet upload refused.
  uploadRelay: { host: process.env.WALRUS_RELAY || RELAY, sendTip: { max: Number(process.env.WALRUS_MAX_TIP || 5_000_000) } },
}))
export const walrus = sui.walrus

/** WALRUS_KEY = a `suiprivkey1…` string (production). Without it, the local Sui CLI key (dev only). */
export function signer() {
  const k = process.env.WALRUS_KEY
  if (k) return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(k).secretKey)
  for (const b64 of JSON.parse(readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, 'utf8'))) {
    const raw = Buffer.from(b64, 'base64')
    if (raw[0] === 0x00) return Ed25519Keypair.fromSecretKey(new Uint8Array(raw.subarray(1)))
  }
  throw new Error('no WALRUS_KEY and no ed25519 key in the Sui keystore')
}

// The index (locator → name inside the quilt) is public data on Walrus, so it is encrypted:
// AES-256-GCM under INDEX_KEY, which the server derives from its own secret. Without it a quilt
// is a pile of random 256-byte blobs with meaningless names.
function indexKey() {
  const k = Buffer.from(process.env.INDEX_KEY || '', 'hex')
  if (k.length !== 32) throw new Error('INDEX_KEY must be 32 bytes of hex')
  return k
}
export function sealIndex(obj) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', indexKey(), iv)
  const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final()])
  return Buffer.concat([Buffer.from('LTI1'), iv, ct, c.getAuthTag()])
}
export function openIndex(buf) {
  const b = Buffer.from(buf)
  if (b.subarray(0, 4).toString() !== 'LTI1') return null
  try {
    const d = createDecipheriv('aes-256-gcm', indexKey(), b.subarray(4, 16))
    d.setAuthTag(b.subarray(b.length - 16))
    return JSON.parse(Buffer.concat([d.update(b.subarray(16, b.length - 16)), d.final()]).toString())
  } catch {
    return null   // not ours (another key) — skip it
  }
}

export const INDEX_NAME = 'i'
