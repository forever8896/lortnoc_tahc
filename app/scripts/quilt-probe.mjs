#!/usr/bin/env node
// Can we actually USE Quilt here? Two questions the cost model cannot answer:
//   1. does writeFiles give us a per-message id we can store in the head, and
//   2. can an AGGREGATOR serve one of those patches over plain HTTP?
//
// (2) is the blocker. Reads go through aggregators because the SDK's direct-node path is
// unreliable from a browser; if patches are only reachable the SDK way, Quilt would trade a
// cost win for the "sent message never appears" bug we just finished fixing.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SuiClient } from '@mysten/sui/client'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { WalrusClient, WalrusFile } from '@mysten/walrus'

const RPC = 'https://sui-testnet-rpc.publicnode.com'
const AGGS = [
  'https://aggregator.walrus-testnet.walrus.space',
  'https://wal-aggregator-testnet.staketab.org',
]
const sui = new SuiClient({ url: RPC })
const walrus = new WalrusClient({
  network: 'testnet',
  suiClient: sui,
  uploadRelay: { host: 'https://upload-relay.testnet.walrus.space', sendTip: { max: 1000 } },
})

function keypair() {
  for (const b64 of JSON.parse(readFileSync(join(homedir(), '.sui', 'sui_config', 'sui.keystore'), 'utf8'))) {
    const raw = Buffer.from(b64, 'base64')
    if (raw[0] === 0x00) return Ed25519Keypair.fromSecretKey(new Uint8Array(raw.subarray(1)))
  }
  throw new Error('no ed25519 key')
}
const me = keypair()

// Three "messages" in ONE quilt — the whole point.
const files = [0, 1, 2].map((i) =>
  WalrusFile.from({
    contents: new TextEncoder().encode(JSON.stringify({ v: 1, body: `quilted message ${i}` })),
    identifier: `msg-${i}`,
  }),
)

console.log('writing a 3-message quilt…')
const res = await walrus.writeFiles({ files, epochs: 3, deletable: true, signer: me })
console.log('blobId :', res[0]?.blobId ?? res.blobId)
for (const r of Array.isArray(res) ? res : [res]) console.log('  patch:', r.id)

const patchId = (Array.isArray(res) ? res[0] : res).id
const blobId = (Array.isArray(res) ? res[0] : res).blobId

console.log('\n--- can an aggregator serve ONE patch? ---')
for (const agg of AGGS) {
  for (const path of [`/v1/blobs/by-quilt-patch-id/${patchId}`, `/v1/blobs/${patchId}`]) {
    try {
      const r = await fetch(`${agg}${path}`)
      const body = r.ok ? new TextDecoder().decode(new Uint8Array(await r.arrayBuffer())).slice(0, 60) : ''
      console.log(`  ${r.status}  ${agg.replace('https://', '').slice(0, 28)}${path.slice(0, 34)}…  ${body}`)
    } catch (e) {
      console.log(`  ERR ${path.slice(0, 40)} ${e.message.slice(0, 40)}`)
    }
  }
}

console.log('\n--- and the whole quilt blob by blobId? ---')
const r = await fetch(`${AGGS[0]}/v1/blobs/${blobId}`)
console.log(`  ${r.status}, ${r.ok ? (await r.arrayBuffer()).byteLength : 0} bytes`)

console.log('\n--- SDK getFiles by patch id ---')
try {
  const [f] = await walrus.getFiles({ ids: [patchId] })
  console.log('  ok:', new TextDecoder().decode(await f.bytes()).slice(0, 60))
} catch (e) {
  console.log('  FAILED:', e.message.slice(0, 90))
}
