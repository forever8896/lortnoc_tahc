#!/usr/bin/env node
// Be one of the users. Read and reply as a DM test wallet, from the CLI.
//
//   node test/dm/chat.mjs read  kilian            # what has kilian sent alice?
//   node test/dm/chat.mjs send  kilian "hello"    # reply as alice
//   node test/dm/chat.mjs whoami                  # alice's handle, keys and balances
//   node test/dm/chat.mjs read kilian --as BOB    # act as a different wallet
//
// This exists so a human on the app and a wallet on the CLI can hold the SAME conversation —
// which is the only way to test the product as it is actually used. It drives
// app/src/lib/live/sui.ts, so anything proved here is proved about the shipped code path.
//
// Peer handles are resolved through ENS, never hardcoded: the CLI side discovers the human
// exactly the way the app discovers the CLI.
import { findHeads, readMessages, sendMessage } from '../../app/src/lib/live/sui.ts'
import * as ens from '../../app/src/lib/live/ens.ts'
import { REC } from '../../app/src/lib/live/config.ts'
import { SuiClient } from '../../app/node_modules/@mysten/sui/dist/esm/client/index.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { deriveConvKey, fromHex } from '../../shared/keys.mjs'
import * as ids from './identities.mjs'

const RPC = process.env.VITE_SUI_RPC || 'https://sui-testnet-rpc.publicnode.com'
const argv = process.argv.slice(2)
const asIdx = argv.indexOf('--as')
const ME = ids[asIdx > -1 ? argv[asIdx + 1] : 'ALICE']
if (!ME) { console.error(`unknown wallet for --as`); process.exit(1) }
// Drop the flag AND its value — guarding on asIdx, because `asIdx + 1` is 0 when the flag is
// absent, which silently ate the first real argument.
const args = argv.filter((_, i) => asIdx === -1 || (i !== asIdx && i !== asIdx + 1))
const [cmd, peerArg, ...rest] = args

const full = (h) => (h.includes('.') ? h : `${h}.lortnoctahc.eth`)
const stamp = (ts) => new Date(ts).toISOString().slice(11, 19)

if (cmd === 'whoami') {
  const sui = new SuiClient({ url: RPC })
  const bal = await sui.getAllBalances({ owner: ME.address })
  console.log(`\nsui address  ${ME.address}`)
  console.log(`messaging    ${ME.pubHex}`)
  console.log(`balances     ${bal.map((b) => `${b.coinType.split('::').pop()}=${b.totalBalance}`).join('  ') || '(empty)'}`)
  process.exit(0)
}

if (!cmd || !peerArg) {
  console.error('usage: node test/dm/chat.mjs <read|send|whoami> <peer-handle> [message] [--as ALICE|BOB]')
  process.exit(1)
}

const peer = full(peerArg)
const peerPub = await ens.resolvePubkey(peer)
if (!peerPub) {
  console.error(`${peer} does not resolve — they need to claim a handle and publish a pubkey.`)
  process.exit(1)
}
const peerSui = await ens.readText(peer, REC.sui)
if (!peerSui) {
  console.error(`${peer} has no ${REC.sui} record — they must open the app once so it publishes one.`)
  process.exit(1)
}
const key = deriveConvKey(ME.msg.priv, fromHex(peerPub), ME.msg.pub)

/** A local note of heads we have seen, because on-chain discovery is currently broken.
 *
 *  ⚠️ findHeads() calls sui.queryEvents(), and public Sui fullnodes now answer
 *  "Method not found. JSON-RPC on public fullnodes has been deprecated" — verified against both
 *  fullnode.testnet.sui.io and publicnode. That is the ONLY way the app discovers a conversation
 *  someone else started, so a peer who is messaged first sees an empty inbox. The comment on
 *  findHeads says it exists precisely to stop that happening; the platform moved under it.
 *
 *  This cache keeps the CLI usable meanwhile: a head we sent to is remembered, and `--head` lets
 *  a head id be supplied by hand. It is a workaround for the demo, not a fix for the app. */
const CACHE = new URL('./heads.json', import.meta.url)
const loadCache = () => { try { return JSON.parse(readFileSync(CACHE, 'utf8')) } catch { return {} } }
const rememberHead = (peerHandle, id) => {
  const c = loadCache()
  c[peerHandle] = [...new Set([...(c[peerHandle] ?? []), id])]
  writeFileSync(CACHE, JSON.stringify(c, null, 2))
}

/** Heads we BOTH belong to. A head is shared, so membership decides, not ownership. */
async function sharedHeads() {
  const sui = new SuiClient({ url: RPC })
  const explicit = args.includes('--head') ? [args[args.indexOf('--head') + 1]] : []
  let discovered = []
  try {
    discovered = await findHeads(ME.address)
  } catch (e) {
    console.error(`  (on-chain discovery unavailable: ${String(e.message || e).slice(0, 60)})`)
  }
  const candidates = [...new Set([...explicit, ...discovered, ...(loadCache()[peer] ?? [])])]
  const out = []
  for (const id of candidates) {
    try {
      const o = await sui.getObject({ id, options: { showContent: true } })
      const members = o.data?.content?.fields?.members ?? []
      if (members.includes(peerSui) && members.includes(ME.address)) out.push(id)
    } catch { /* a head id that no longer resolves is simply not a candidate */ }
  }
  return out
}

if (cmd === 'read') {
  const heads = await sharedHeads()
  if (!heads.length) {
    console.log(`\nno conversation with ${peer} yet.`)
    console.log(`they should send to ${ME === ids.ALICE ? 'alice' : 'bob'}.lortnoctahc.eth from the app.`)
    process.exit(0)
  }
  for (const head of heads) {
    const msgs = await readMessages(head, key, ME.signer)
    console.log(`\n── ${peer}   head ${head.slice(0, 18)}…  (${msgs.length} message${msgs.length === 1 ? '' : 's'})`)
    for (const m of msgs) console.log(`  ${stamp(m.ts)}  ${m.from === peer ? '←' : '→'} ${m.body}`)
  }
  process.exit(0)
}

if (cmd === 'send') {
  const body = rest.join(' ')
  if (!body) { console.error('nothing to send'); process.exit(1) }
  // Reuse an existing head so the reply lands in the SAME thread rather than starting a new one.
  const head = (await sharedHeads())[0] ?? null
  const msg = { v: 1, from: 'alice.lortnoctahc.eth', to: peer, ts: Date.now(), body }
  const res = await sendMessage(head, key, msg, ME.signer, peerSui, (s) => process.stdout.write(`  ${s}…\n`))
  rememberHead(peer, res.headId)
  console.log(`\nsent to ${peer}`)
  console.log(`  head ${res.headId}`)
  process.exit(0)
}

console.error(`unknown command ${cmd}`)
process.exit(1)
