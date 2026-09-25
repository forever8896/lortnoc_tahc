// The check registry (docs/PRD-universal.md §16). One file per check; the engine (../policy.mjs)
// finds a check here by id when compiling and by tag when parsing, and knows nothing else about it.
//
// Adding a check = a new file + one line below + passing test/unit/checks.conformance.test.mjs.
// Tags are CONSENSUS: a tag, once shipped, is never reused for a different check — posts already
// out in the world carry it.
import publicCheck from './public.mjs'
import passphrase from './passphrase.mjs'
import recipients from './recipients.mjs'
import after from './after.mjs'

export const CHECKS = Object.freeze(
  Object.fromEntries([publicCheck, passphrase, recipients, after].map((m) => [m.id, m])),
)

const TAGS = new Map(Object.values(CHECKS).map((m) => [m.tag, m]))
if (TAGS.size !== Object.keys(CHECKS).length) throw new Error('checks: duplicate tag')

/** @returns the check module for a wire tag, or undefined for one this version does not know. */
export const byTag = (tag) => TAGS.get(tag)
