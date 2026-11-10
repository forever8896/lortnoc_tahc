// Rebuild codec2's index from Walrus alone: list every quilt the server's wallet owns on Sui, open
// each quilt's encrypted index file, and print the merged map. With this, the drop server is
// replaceable — anyone holding the server secret (→ INDEX_KEY) and the wallet address can bring a
// new one up and every reply ever posted resolves again.
//
//   stdout {"<locator hex>": {"b": "<quilt blobId>", "n": "<name>"}, ...}
//   env    WALRUS_OWNER (default: the signer's address), INDEX_KEY, WALRUS_NETWORK, WALRUS_AGGREGATOR
import { blobIdFromInt } from '@mysten/walrus'
import { GRAPHQL, NETWORK, signer, openIndex, INDEX_NAME } from './common.mjs'

const owner = process.env.WALRUS_OWNER || signer().toSuiAddress()
const AGG = process.env.WALRUS_AGGREGATOR || { testnet: 'https://aggregator.walrus-testnet.walrus.space', mainnet: 'https://aggregator.walrus-mainnet.walrus.space' }[NETWORK]

async function ownedBlobs() {
  const out = []
  let after = null
  for (;;) {
    const q = `{ address(address: "${owner}") { objects(first: 50${after ? `, after: "${after}"` : ''}) {
      pageInfo { hasNextPage endCursor } nodes { contents { type { repr } json } } } } }`
    const r = await fetch(GRAPHQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) })
    const j = await r.json()
    if (j.errors) throw new Error(JSON.stringify(j.errors))
    const page = j.data.address.objects
    for (const n of page.nodes) {
      // any version of the Walrus package: match the type by module + name, not by package address
      if (n.contents?.type?.repr?.endsWith('::blob::Blob')) out.push(n.contents.json)
    }
    if (!page.pageInfo.hasNextPage) return out
    after = page.pageInfo.endCursor
  }
}

const merged = {}
let quilts = 0, ours = 0
for (const b of await ownedBlobs()) {
  quilts++
  const blobId = blobIdFromInt(BigInt(b.blob_id))
  const r = await fetch(`${AGG}/v1/blobs/by-quilt-id/${blobId}/${INDEX_NAME}`)
  if (!r.ok) continue                              // not a quilt of ours, or expired
  const idx = openIndex(new Uint8Array(await r.arrayBuffer()))
  if (!idx) continue                               // someone else's index key
  ours++
  for (const [loc, name] of Object.entries(idx.map)) merged[loc] = { b: blobId, n: name }
}
process.stderr.write(`[recover] ${owner}: ${quilts} blob(s), ${ours} of ours, ${Object.keys(merged).length} post(s)\n`)
process.stdout.write(JSON.stringify(merged))
