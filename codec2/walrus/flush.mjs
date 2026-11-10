// Upload one batch of sealed posts as ONE Walrus quilt (codec2/archive.py calls this).
//
//   stdin  {"items": [{"name": "f3a9…", "b64": "…"}], "index": {"<locator hex>": "<name>"}, "epochs": 53}
//   stdout {"blobId", "blobObjectId", "endEpoch", "patches": {"<name>": "<patchId>"}}
//
// Every item is stored under a random NAME, never its locator: quilt names are public, and a public
// locator would let anyone check whether a reply is a real post — exactly what the decoys prevent.
// The batch's locator→name map rides along as one more file, encrypted (common.mjs).
import { WalrusFile } from '@mysten/walrus'
import { walrus, signer, sealIndex, INDEX_NAME, NETWORK } from './common.mjs'

const input = JSON.parse(await new Response(process.stdin).text())
if (!input.items?.length) throw new Error('nothing to upload')

// Walrus SORTS a quilt's files by identifier (JS `<`, see @mysten/walrus utils/quilts.js) and returns
// the patch ids in THAT order, not ours. Measured: mapping by input position swapped two posts.
// So sort the same way first, then map by position — and verify the ends below.
const entries = [
  ...input.items.map((it) => ({ name: it.name, bytes: new Uint8Array(Buffer.from(it.b64, 'base64')) })),
  { name: INDEX_NAME, bytes: new Uint8Array(sealIndex({ v: 1, network: NETWORK, map: input.index })) },
].sort((a, b) => (a.name < b.name ? -1 : 1))
const files = entries.map((e) => WalrusFile.from({ contents: e.bytes, identifier: e.name }))

const res = await walrus.writeFiles({ files, epochs: input.epochs ?? 53, deletable: true, signer: signer() })
if (res.length !== entries.length) throw new Error(`walrus returned ${res.length} patches for ${entries.length} files`)
const patches = {}
entries.forEach((e, i) => e.name !== INDEX_NAME && (patches[e.name] = res[i].id))

// Belt and braces: the first and last patch must carry the names we mapped them to.
for (const i of [0, entries.length - 1]) {
  const [f] = await walrus.getFiles({ ids: [res[i].id] })
  const got = await f.getIdentifier()
  if (got !== entries[i].name) throw new Error(`patch order mismatch: ${res[i].id} is "${got}", expected "${entries[i].name}"`)
}
process.stdout.write(JSON.stringify({
  blobId: res[0].blobId,
  blobObjectId: res[0].blobObject.id?.id ?? res[0].blobObject.id,
  endEpoch: res[0].blobObject.storage.end_epoch ?? res[0].blobObject.storage.endEpoch,
  patches,
}))
