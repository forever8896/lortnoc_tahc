#!/usr/bin/env node
// Watch a conversation and EXIT the moment the peer says something new.
//
//   node --import ./test/lib/resolve-ts.mjs test/dm/watch.mjs brianpistar
//
// This is the half of an auto-responder that a machine should own: polling. It deliberately does
// NOT reply on its own, because a canned reply is worse than no reply — it looks like a person
// answering and says nothing. Instead it blocks until there is something to answer, prints the
// message, and exits; whoever launched it (a human, or an agent that gets re-invoked when a
// background command finishes) writes the actual answer with `chat.mjs send`.
//
// Exit codes are the interface:
//   0  a new inbound message arrived — it is on stdout
//   2  nothing arrived before the deadline (restart it; not an error)
//   1  something is actually wrong
import { findHeads, readMessages } from '../../app/src/lib/live/sui.ts'
import * as ens from '../../app/src/lib/live/ens.ts'
import { REC } from '../../app/src/lib/live/config.ts'
import { SuiClient } from '../../app/node_modules/@mysten/sui/dist/esm/client/index.js'
import { deriveConvKey, fromHex } from '../../shared/keys.mjs'
import * as ids from './identities.mjs'

const RPC = process.env.VITE_SUI_RPC || 'https://sui-testnet-rpc.publicnode.com'
const argv = process.argv.slice(2)
const asIdx = argv.indexOf('--as')
const ME = ids[asIdx > -1 ? argv[asIdx + 1] : 'ALICE']
const args = argv.filter((_, i) => asIdx === -1 || (i !== asIdx && i !== asIdx + 1))
const peerArg = args[0]
if (!ME || !peerArg) {
  console.error('usage: node test/dm/watch.mjs <peer-handle> [--as ALICE|BOB] [--for <seconds>] [--every <seconds>]')
  process.exit(1)
}
const num = (flag, dflt) => {
  const i = args.indexOf(flag)
  return i > -1 ? Number(args[i + 1]) : dflt
}
/** Default deadline is generous but finite: a watcher that never returns cannot be restarted
 *  cleanly, and a caller that is woken periodically can simply relaunch. */
const DEADLINE_S = num('--for', 1500)
const EVERY_S = num('--every', 6)

const peer = peerArg.includes('.') ? peerArg : `${peerArg}.lortnoctahc.eth`
const peerPub = await ens.resolvePubkey(peer)
const peerSui = await ens.readText(peer, REC.sui)
if (!peerPub || !peerSui) {
  console.error(`${peer} does not publish the records needed to read a conversation with them.`)
  process.exit(1)
}
const key = deriveConvKey(ME.msg.priv, fromHex(peerPub), ME.msg.pub)
const sui = new SuiClient({ url: RPC })

/** Heads we BOTH belong to — membership decides, not who created it.
 *
 *  Returns the failures alongside the heads. An earlier version swallowed a getObject error and
 *  treated the head as "not a candidate", so a single timed-out RPC call — which this network
 *  produces regularly — turned into "no conversation with them yet, they need to message you
 *  first". That sentence is a confident claim about the other person, produced by a network
 *  blip, about a conversation that was being read successfully minutes earlier. Never again:
 *  a check that could not RUN is not a check that came back negative. */
async function sharedHeads() {
  const found = await findHeads(ME.address)
  const out = []
  let unchecked = 0
  for (const id of found) {
    // One retry, because the failures seen here are transient by nature (ETIMEDOUT to the
    // public RPC), and a second attempt costs a fraction of a second.
    for (let attempt = 0; ; attempt++) {
      try {
        const o = await sui.getObject({ id, options: { showContent: true } })
        const members = o.data?.content?.fields?.members ?? []
        if (members.includes(peerSui) && members.includes(ME.address)) out.push(id)
        break
      } catch (e) {
        if (attempt >= 2) {
          unchecked++
          console.error(`  (could not read head ${id.slice(0, 12)}…: ${String(e.message || e).slice(0, 70)})`)
          break
        }
        await new Promise((r) => setTimeout(r, 800))
      }
    }
  }
  return { heads: out, unchecked }
}

const first = await sharedHeads()
const heads = first.heads
if (!heads.length) {
  // Say which of the two it is. They call for opposite actions: one means "ask them to message
  // you", the other means "try again in a minute".
  if (first.unchecked) {
    console.error(`could not check ${first.unchecked} conversation head(s) — the Sui RPC is not answering. Not a verdict about ${peer}; retry.`)
  } else {
    console.error(`no conversation with ${peer} yet — they need to message you first.`)
  }
  process.exit(1)
}

/** Newest inbound timestamp right now. Everything at or before this is already answered, so the
 *  watcher never fires on history the moment it starts. */
async function newestInbound() {
  let newest = 0
  let latest = null
  for (const head of heads) {
    for (const m of await readMessages(head, key, ME.signer)) {
      if (m.from === peer && m.ts > newest) {
        newest = m.ts
        latest = m
      }
    }
  }
  return { newest, latest }
}

const start = await newestInbound()
console.error(`watching ${peer} · ${heads.length} head(s) · baseline ${start.newest || 'none'} · up to ${DEADLINE_S}s`)

const until = Date.now() + DEADLINE_S * 1000
while (Date.now() < until) {
  await new Promise((r) => setTimeout(r, EVERY_S * 1000))
  let now
  try {
    now = await newestInbound()
  } catch (e) {
    // A transient RPC or Walrus failure is not a reason to stop watching.
    console.error(`  (poll failed, continuing: ${String(e.message || e).slice(0, 80)})`)
    continue
  }
  if (now.newest > start.newest && now.latest) {
    console.log(JSON.stringify({ from: peer, ts: now.latest.ts, body: now.latest.body }, null, 2))
    process.exit(0)
  }
}
console.error('no new message before the deadline')
process.exit(2)
