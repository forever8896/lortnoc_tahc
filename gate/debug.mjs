// The gate's activity trail — every step of every flow, for debugging at the booth
// (the lab page renders it: extension-everywhere/playground.mjs → "Gate activity").
//
// One event = { id, at, flow, title?, step, ok, detail }. `flow` groups the steps of one attempt
// ("connect:<sid>", "unlock:<n>", "seal:<ref>"). Steps come from the gate itself and from the
// extension (POST /debug/client), so one timeline shows both halves.
//
// What is NEVER recorded: IP addresses, tokens, keys, messages, full nullifiers (first 10 chars only,
// enough to tell two apart). Kept in memory (last 1000) and appended to gate/.data/events.jsonl
// (gitignored) so a restart keeps the history. Read only from this machine (server.mjs).
import { appendFileSync, readFileSync, existsSync } from 'node:fs'

const MAX = 1000
export const short = (v) => (typeof v === 'string' && v.length > 14 ? `${v.slice(0, 10)}…` : v)

export function createDebug({ file, echo = true } = {}) {
  const events = []
  let next = 1
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n').slice(-MAX)) {
      try {
        const e = JSON.parse(line)
        events.push(e)
        next = Math.max(next, e.id + 1)
      } catch {}
    }
  }
  function log(flow, step, ok, detail = {}, title) {
    const e = { id: next++, at: Date.now(), flow, step, ok, detail, ...(title ? { title } : {}) }
    events.push(e)
    if (events.length > MAX) events.shift()
    if (file) {
      try {
        appendFileSync(file, JSON.stringify(e) + '\n')
      } catch {}
    }
    if (echo) console.log(`${new Date(e.at).toISOString().slice(11, 19)} ${ok === false ? '✗' : ok === true ? '✓' : '·'} [${flow}] ${step}${detail && Object.keys(detail).length ? ' ' + JSON.stringify(detail) : ''}`)
    return e
  }
  return {
    log,
    /** A tracer bound to one flow: trace(step, ok, detail). */
    flow: (flow, title) => {
      if (title) log(flow, 'started', null, {}, title)
      return (step, ok, detail) => log(flow, step, ok, detail)
    },
    since: (id = 0) => events.filter((e) => e.id > id),
  }
}

/** A tracer that records nothing — the default everywhere, so tests and callers need not care. */
export const noTrace = () => {}
