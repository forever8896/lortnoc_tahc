// Time, written the way a messenger writes it.
//
// A chat app is read at a glance: you want "was this just now or last week?" without parsing a
// date. These helpers exist so the sidebar and the thread agree on that phrasing instead of each
// calling toLocaleTimeString() with different options.
//
// Everything here is pure and local — no formatting library, and nothing that would put a
// timestamp anywhere it could leak. `ts` is always the message's own unix ms.

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Start-of-day for `ts`, in the reader's own timezone — the unit day separators group by. */
function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Compact age for a conversation row: `now · 4m · 3h · Tue · 12 Aug`.
 *
 * Deliberately coarse. A row is scanned, not studied, and a full timestamp there is noise — the
 * exact time lives on the message itself, where it can be read against its neighbours.
 */
export function relativeTime(ts: number, now = Date.now()): string {
  if (!ts) return ''
  const age = now - ts
  if (age < MIN) return 'now'
  if (age < HOUR) return `${Math.floor(age / MIN)}m`
  if (age < DAY) return `${Math.floor(age / HOUR)}h`
  // Inside the last week a weekday name reads faster than a date ("Tue" vs "26 Aug").
  if (age < 7 * DAY) return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' })
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** Wall-clock time on a message bubble — `14:32`, in the reader's locale and timezone. */
export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** Heading for a day separator: `Today`, `Yesterday`, or a written date. */
export function dayLabel(ts: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return new Date(ts).toLocaleDateString(undefined, { weekday: 'long' })
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
}

/** True when `ts` opens a new day relative to `prev` — i.e. a separator belongs before it.
 *  `prev` undefined means this is the first message, which always opens the log. */
export function opensNewDay(ts: number, prev?: number): boolean {
  return prev === undefined || startOfDay(ts) !== startOfDay(prev)
}
