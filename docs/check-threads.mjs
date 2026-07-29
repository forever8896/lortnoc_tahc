#!/usr/bin/env node
// Character-count check for docs/x-threads-sponsors.md.
//
// X counts by Unicode code points, not UTF-16 units, and most emoji are a single weighted
// character rather than the two JS reports via `.length`. Counting with [...str] gets code
// points; the 🙏 in each thank-you post is one of them, so a naive .length over-counts and
// would have you trimming copy that already fits.
//
// Run: node docs/check-threads.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const LIMIT = 280
const file = resolve(dirname(fileURLToPath(import.meta.url)), 'x-threads-sponsors.md')
const src = readFileSync(file, 'utf8')

// Posts run from a **N/** marker to the next marker, heading, or rule.
const posts = []
let section = ''
let current = null
for (const line of src.split('\n')) {
  const h = /^##\s+(.+)$/.exec(line)
  if (h) { if (current) posts.push(current); current = null; section = h[1].trim(); continue }
  const m = /^\*\*(\d+)\/\*\*\s*$/.exec(line)
  if (m) { if (current) posts.push(current); current = { section, n: m[1], lines: [] }; continue }
  if (!current) continue
  if (/^---\s*$/.test(line)) { posts.push(current); current = null; continue }
  current.lines.push(line)
}
if (current) posts.push(current)

let bad = 0
for (const p of posts) {
  const text = p.lines.join('\n').trim()
  const len = [...text].length            // code points, as X counts them
  const over = len > LIMIT
  if (over) bad++
  const pad = `${p.section} ${p.n}/`.padEnd(34)
  console.log(`  ${over ? '✗' : '✓'} ${pad} ${String(len).padStart(3)} / ${LIMIT}${over ? `  OVER BY ${len - LIMIT}` : ''}`)
}
console.log(bad ? `\n${bad} post(s) over the limit\n` : `\nall ${posts.length} posts fit\n`)
process.exit(bad ? 1 : 0)
